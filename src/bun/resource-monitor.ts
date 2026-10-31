import { ACTIVE_STATUSES, getTaskTitle } from "../shared/types";
import { cpus, loadavg } from "node:os";
import { resolveResourceLevels } from "../shared/types";
import type { MemoryTaskConsumer, ResourceUsage, SystemLoadSnapshot, SystemMemorySnapshot, TaskStatus } from "../shared/types";
import { collectProcessInfo, collectDescendants, getAllSessionPanePids, listNativeTaskIds, nativeTaskPids } from "./port-scanner";
import { DEFAULT_TMUX_SOCKET, devServerSessionForTaskSession, parseDev3SessionName, TASK_SESSION_PREFIX } from "./tmux";
import { createLogger } from "./logger";
import { startSleepInhibitWatch, stopSleepInhibitWatch } from "./caffeinate";
import { probeMemoryFacts } from "./system-memory-probe";
import { classifyPressure, groupConsumers, isSwapping, median, type RawConsumer } from "./system-memory";
import { classifyCpu, classifyDisk, cpuBusyRatio, groupCpuConsumers, loadSnapshotWorthPushing, readDiskFacts, sumCpuTimes, type CpuTimes } from "./system-load";
import { loadSettings } from "./settings";
import { DEV3_HOME } from "./paths";

const log = createLogger("resource-monitor");
const POLL_INTERVAL_MS = 10_000;
/**
 * Tick while a surface is watching the numbers live (the tmux sessions popover).
 * One `ps -eo` over the whole process table costs ~120 ms of CPU on a busy
 * machine, so 2 s is the point where the readout feels live at ~6% of a core;
 * per-session sharding cannot beat it — a single `ps` already covers every
 * session, so there is nothing to shard.
 */
const BOOSTED_POLL_INTERVAL_MS = 2_000;
/**
 * A boost dies on its own unless renewed. The watcher may be a browser tab in
 * remote mode, which can vanish without ever telling us to stop.
 */
const BOOST_TTL_MS = 15_000;

/** How many grouped non-dev3 consumers the breakdown shows. */
const TOP_CONSUMERS = 5;
/** How many heaviest tasks the dev3 section shows. */
const TOP_TASKS = 3;
/** Headroom must move by at least this much to justify a re-render. */
const HEADROOM_PUSH_THRESHOLD = 256 * 1024 * 1024;

type PushMessageFn = (name: string, payload: unknown) => void;

/**
 * A tick still running after this long is stuck on an await that may never
 * settle. The watchdog abandons it and starts a fresh one, so one hung probe
 * cannot end monitoring for the rest of the app's life.
 */
const STALL_AFTER_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 15_000;
/** Abandoned ticks allowed at once; past that, wait for one to settle rather than pile up more. */
const MAX_ABANDONED_POLLS = 2;

type PollRun = { startedAt: number; stage: string };

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
/** The tick in flight that owns rescheduling; an abandoned tick no longer does. */
let currentPoll: PollRun | null = null;
/** Stuck ticks the watchdog gave up on, still pending → the stage each was stuck in. */
const abandonedPolls = new Map<PollRun, string>();
let pushMessageFn: PushMessageFn | null = null;
/** Epoch ms until which the fast tick applies; 0 = not boosted. */
let boostUntil = 0;

const usageData = new Map<string, ResourceUsage>();
let memorySnapshot: SystemMemorySnapshot | null = null;
/** Previous cumulative swap-out counter — a delta is the only meaningful reading. */
let previousSwapOutCount: number | null = null;
let loadSnapshot: SystemLoadSnapshot | null = null;
/** Cumulative core times at the previous tick — busy % is a delta, like swap. */
let previousCpuTimes: CpuTimes | null = null;

/**
 * Aggregate resource usage for a set of PIDs from pre-collected data.
 */
export function aggregateResources(
	pids: Set<number>,
	resources: Map<number, { rss: number; cpu: number }>,
): ResourceUsage {
	let totalRss = 0;
	let totalCpu = 0;
	for (const pid of pids) {
		const info = resources.get(pid);
		if (info) {
			totalRss += info.rss;
			totalCpu += info.cpu;
		}
	}
	return { rss: totalRss, cpu: totalCpu };
}

/**
 * Resolve short task ids to a title + project, for the breakdown's clickable
 * rows. Loads are inode+mtime cached in data.ts, and this only runs when we
 * have already decided to push, so it is a stat per project per change.
 */
export async function resolveTaskConsumers(
	entries: Array<{ shortId: string; rss: number }>,
): Promise<MemoryTaskConsumer[]> {
	const wanted = new Map(entries.map((e) => [e.shortId, e.rss]));
	const resolved: MemoryTaskConsumer[] = [];
	try {
		const { loadProjects, loadVirtualProjects, loadTasks } = await import("./data");
		const projects = [...(await loadProjects()), ...(await loadVirtualProjects())];
		for (const project of projects) {
			if (wanted.size === 0) break;
			for (const task of await loadTasks(project)) {
				const shortId = task.id.slice(0, 8);
				const rss = wanted.get(shortId);
				if (rss === undefined) continue;
				wanted.delete(shortId);
				// getTaskTitle, not task.title: a user-renamed task must show the name
				// the user gave it, and auto-generated titles are raw description text.
				resolved.push({ shortId, taskId: task.id, title: getTaskTitle(task), projectId: project.id, rss });
			}
		}
	} catch (err) {
		log.warn("Could not resolve task titles for the memory breakdown", { error: String(err) });
	}
	// Anything unresolved still deserves a row — the number is real even when the
	// name is not. Sorting stays owned by the caller's rss ordering.
	for (const [shortId, rss] of wanted) {
		resolved.push({ shortId, taskId: null, title: "", projectId: "", rss });
	}
	return resolved.sort((a, b) => b.rss - a.rss);
}

/**
 * Task short ids that must never be offered for a process kill: a live terminal
 * session (either backend), or a task still in an active column. An agent working
 * right now legitimately owns a daemonized headless browser, and that daemon is
 * reparented to init exactly like a leaked one — the status is the only thing
 * that tells them apart. Computed fresh, never from the poller's cache: the
 * startup scan runs before the first tick.
 */
export async function getBusyTaskShortIds(): Promise<Set<string>> {
	const busy = new Set<string>();
	try {
		const paneMap = await getAllSessionPanePids(DEFAULT_TMUX_SOCKET);
		for (const name of filterTaskSessions(paneMap)) busy.add(name.slice(TASK_SESSION_PREFIX.length));
	} catch (err) {
		log.warn("Could not list tmux sessions for the orphan scan", { error: String(err) });
	}
	try {
		const { loadProjects, loadVirtualProjects, loadTasks } = await import("./data");
		const active = new Set<TaskStatus>(ACTIVE_STATUSES);
		for (const project of [...(await loadProjects()), ...(await loadVirtualProjects())]) {
			for (const task of await loadTasks(project)) {
				if (active.has(task.status)) busy.add(task.id.slice(0, 8));
			}
		}
	} catch (err) {
		// Cannot prove a task is finished → offer nothing. Failing closed here is
		// the difference between a useful button and one that kills live work.
		log.warn("Could not read tasks for the orphan scan — reporting no leftovers", { error: String(err) });
		throw err;
	}
	return busy;
}

/** True when the two snapshots differ enough that the header should re-render. */
function snapshotWorthPushing(prev: SystemMemorySnapshot | null, next: SystemMemorySnapshot): boolean {
	if (!prev) return true;
	if (prev.pressure !== next.pressure) return true;
	if (prev.swapping !== next.swapping) return true;
	if (prev.activeTaskCount !== next.activeTaskCount) return true;
	if (Math.abs(next.headroom - prev.headroom) >= HEADROOM_PUSH_THRESHOLD) return true;
	const names = (s: SystemMemorySnapshot) => s.topConsumers.map((c) => c.name).join("\0");
	if (names(prev) !== names(next)) return true;
	const taskIds = (s: SystemMemorySnapshot) => s.topTasks.map((t) => t.taskId).join("\0");
	return taskIds(prev) !== taskIds(next);
}

/**
 * Build and (if it moved) push the system-memory snapshot.
 *
 * Runs inside the per-task tick on purpose: the dev3 subtotal and the system
 * total come from the SAME `ps` sample, so the popover can never show two
 * figures taken at different moments.
 */
async function collectSystemMemory(
	resources: Map<number, { rss: number; cpu: number }>,
	cmdlines: Map<number, string>,
	tree: Map<number, number[]>,
	taskUsage: Array<{ shortId: string; rss: number; cpu: number }>,
	taskPids: Set<number>,
): Promise<void> {
	const facts = await probeMemoryFacts();
	if (!facts) return;

	const swapping = isSwapping(previousSwapOutCount, facts.swapOutCount);
	previousSwapOutCount = facts.swapOutCount;
	const { pressure, estimated } = classifyPressure(facts, { swapping });

	// The dev3 app's own tree — reported separately so nobody has to guess which
	// share is ours and which we merely enabled the user to spend.
	const appPids = new Set<number>([process.pid, ...collectDescendants(process.pid, tree)]);
	let appRss = 0;
	for (const pid of appPids) appRss += resources.get(pid)?.rss ?? 0;

	// Everything the user launched through us is excluded from the system list,
	// so Docker and Chrome cannot be crowded out by fourteen of our own tasks.
	const ours = new Set<number>(appPids);
	for (const pid of taskPids) ours.add(pid);

	const outsiders: RawConsumer[] = [];
	for (const [pid, info] of resources) {
		if (ours.has(pid)) continue;
		const cmdline = cmdlines.get(pid);
		if (!cmdline) continue;
		outsiders.push({ pid, rss: info.rss, cmdline });
	}

	const ranked = [...taskUsage].sort((a, b) => b.rss - a.rss);
	const topTasks = await resolveTaskConsumers(ranked.slice(0, TOP_TASKS));

	const next: SystemMemorySnapshot = {
		headroom: facts.headroom,
		used: facts.used,
		total: facts.total,
		cached: facts.cached,
		pressure,
		pressureEstimated: estimated,
		swapUsed: facts.swapUsed,
		swapTotal: facts.swapTotal,
		swapping,
		topConsumers: groupConsumers(outsiders, TOP_CONSUMERS),
		appRss,
		activeTaskCount: taskUsage.length,
		tasksRssApprox: taskUsage.reduce((sum, t) => sum + t.rss, 0),
		topTasks,
		medianTaskRss: median(taskUsage.map((t) => t.rss)),
	};

	const worth = snapshotWorthPushing(memorySnapshot, next);
	memorySnapshot = next;
	if (worth) pushMessageFn?.("systemMemoryUpdated", next);
}

/**
 * CPU and disk for the header kebab rows, from the same `ps` sample as memory.
 * Busy % comes from cumulative core times rather than summing `ps` %cpu, which
 * on macOS is a decaying average and overshoots after a burst.
 */
async function collectSystemLoad(
	resources: Map<number, { rss: number; cpu: number }>,
	cmdlines: Map<number, string>,
	tree: Map<number, number[]>,
	taskUsage: Array<{ shortId: string; rss: number; cpu: number }>,
	taskPids: Set<number>,
): Promise<void> {
	const times = sumCpuTimes(cpus());
	const busy = cpuBusyRatio(previousCpuTimes, times);
	previousCpuTimes = times;
	if (busy === null) return;

	const appPids = new Set<number>([process.pid, ...collectDescendants(process.pid, tree)]);
	let appCpu = 0;
	for (const pid of appPids) appCpu += resources.get(pid)?.cpu ?? 0;

	const outsiders: Array<{ pid: number; cpu: number; cmdline: string }> = [];
	for (const [pid, info] of resources) {
		if (appPids.has(pid) || taskPids.has(pid)) continue;
		const cmdline = cmdlines.get(pid);
		if (cmdline) outsiders.push({ pid, cpu: info.cpu, cmdline });
	}

	const ranked = taskUsage.filter((t) => t.cpu > 0).sort((a, b) => b.cpu - a.cpu).slice(0, TOP_TASKS);
	const resolved = await resolveTaskConsumers(ranked.map((t) => ({ shortId: t.shortId, rss: t.cpu })));
	const [one, five, fifteen] = loadavg();
	const cores = cpus().length;
	// Read every tick so a changed level shows within one poll, no restart.
	const levels = resolveResourceLevels(await loadSettings());
	const disk = readDiskFacts(DEV3_HOME);

	const next: SystemLoadSnapshot = {
		cpuBusy: busy,
		cpuPressure: classifyCpu(busy, levels),
		cores,
		loadAvg: [one, five, fifteen],
		topCpuConsumers: groupCpuConsumers(outsiders, TOP_CONSUMERS),
		appCpu,
		topCpuTasks: resolved.map(({ rss, ...task }) => ({ ...task, cpu: rss })),
		disk: disk && { ...disk, pressure: classifyDisk(disk.free, levels) },
	};

	const worth = loadSnapshotWorthPushing(loadSnapshot, next);
	loadSnapshot = next;
	if (worth) pushMessageFn?.("systemLoadUpdated", next);
}

/**
 * Task session names from a pane map (excluding cleanup, dev-server,
 * project-terminal sessions).
 */
function filterTaskSessions(paneMap: Map<string, number[]>): string[] {
	return [...paneMap.keys()].filter((name) => parseDev3SessionName(name)?.kind === "task");
}

async function poll() {
	pollTimer = null;
	const run: PollRun = { startedAt: Date.now(), stage: "tmux" };
	currentPoll = run;
	try {
		if (!pushMessageFn) return;

		// One tmux call for all sessions AND all their pane PIDs — this poller
		// used to spawn `tmux list-sessions` + 2 `list-panes` per session,
		// synchronously, which stalled the main loop under load.
		const paneMap = await getAllSessionPanePids(DEFAULT_TMUX_SOCKET);
		const sessionNames = filterTaskSessions(paneMap);
		const nativeTaskIds = listNativeTaskIds();
		const activeShortIds = new Set([
			...sessionNames.map((n) => n.slice(TASK_SESSION_PREFIX.length)),
			...nativeTaskIds.map((id) => id.slice(0, 8)),
		]);

		// Clean up stale cache and notify renderer
		for (const shortId of usageData.keys()) {
			if (!activeShortIds.has(shortId)) {
				usageData.delete(shortId);
				pushMessageFn("resourceUsageUpdated", {
					taskId: shortId,
					usage: { cpu: 0, rss: 0 },
				});
			}
		}

		// Shared process info — TTL-cached in port-scanner, so port-scanner poller
		// firing in the same cycle reuses this result without a second ps spawn.
		// Collected even with zero sessions: the memory widget must still show
		// system memory on an empty board.
		// A boosted tick must not be served the 5 s shared cache — it would render
		// the same numbers three times and call it live.
		run.stage = "process-table";
		const { tree, resources, cmdlines } = await collectProcessInfo(
			isBoosted() ? { maxAgeMs: BOOSTED_POLL_INTERVAL_MS / 2 } : undefined,
		);
		// A real sample always holds at least `ps` and this app. An empty one is a
		// failed probe (timed out, spawn error), and its zeros would read as every
		// task going idle — keep the last figures instead.
		if (resources.size === 0) return;

		// Accumulated for the memory snapshot below, from the same ps sample.
		const taskUsage: Array<{ shortId: string; rss: number; cpu: number }> = [];
		const allTaskPids = new Set<number>();

		const recordUsage = (shortId: string, allPids: Set<number>) => {
			// Aggregate resources from pre-collected data (no extra spawns)
			const usage = aggregateResources(allPids, resources);

			taskUsage.push({ shortId, rss: usage.rss, cpu: usage.cpu });
			for (const pid of allPids) allTaskPids.add(pid);

			const prev = usageData.get(shortId);
			const cpuChanged = !prev || Math.abs(usage.cpu - prev.cpu) > 1;
			const rssChanged = !prev || Math.abs(usage.rss - prev.rss) > 1024 * 1024;

			if (cpuChanged || rssChanged) {
				usageData.set(shortId, usage);
				pushMessageFn?.("resourceUsageUpdated", { taskId: shortId, usage });
			}
		};

		for (const sessionName of sessionNames) {
			const shortId = sessionName.slice(TASK_SESSION_PREFIX.length);
			try {
				// Pane PIDs from the shared map (main session + dev server session)
				const panePids = [...(paneMap.get(sessionName) ?? [])];
				panePids.push(...(paneMap.get(devServerSessionForTaskSession(sessionName)) ?? []));

				if (panePids.length === 0) continue;

				// Build full PID set using collectDescendants (in-memory BFS, no extra spawns)
				const allPids = new Set<number>(panePids);
				for (const pid of panePids) {
					for (const d of collectDescendants(pid, tree)) {
						allPids.add(d);
					}
				}
				recordUsage(shortId, allPids);
			} catch (err) {
				log.warn("Resource usage scan failed", { session: sessionName, error: String(err) });
			}
		}

		const tmuxShortIds = new Set(sessionNames.map((n) => n.slice(TASK_SESSION_PREFIX.length)));
		for (const taskId of nativeTaskIds) {
			const shortId = taskId.slice(0, 8);
			// A leftover record of a task now on tmux must not overwrite its real usage.
			if (tmuxShortIds.has(shortId)) continue;
			try {
				const allPids = nativeTaskPids(taskId, tree);
				if (allPids.size > 0) recordUsage(shortId, allPids);
				else if (usageData.delete(shortId)) {
					// A leftover coordinator record with no live pane must not freeze the last figures.
					pushMessageFn?.("resourceUsageUpdated", { taskId: shortId, usage: { cpu: 0, rss: 0 } });
				}
			} catch (err) {
				log.warn("Resource usage scan failed", { session: taskId.slice(0, 8), error: String(err) });
			}
		}

		// A failing platform probe must cost the snapshot, not the whole tick —
		// per-task usage above has already been pushed.
		run.stage = "system-memory";
		try {
			await collectSystemMemory(resources, cmdlines, tree, taskUsage, allTaskPids);
		} catch (err) {
			log.warn("System memory snapshot failed", { error: String(err) });
		}
		run.stage = "system-load";
		try {
			await collectSystemLoad(resources, cmdlines, tree, taskUsage, allTaskPids);
		} catch (err) {
			log.warn("System load snapshot failed", { error: String(err) });
		}
	} catch (err) {
		log.error("Resource monitor poll cycle failed", { error: String(err) });
	} finally {
		if (currentPoll === run) {
			currentPoll = null;
			if (watchdogTimer) schedulePoll(currentIntervalMs());
		} else if (abandonedPolls.has(run)) {
			log.info("A stalled resource monitor poll finally settled", { stage: abandonedPolls.get(run), afterMs: Date.now() - run.startedAt });
			abandonedPolls.delete(run);
		}
	}
}

function schedulePoll(delayMs: number): void {
	if (pollTimer) clearTimeout(pollTimer);
	pollTimer = setTimeout(() => void poll(), delayMs);
}

/** Restart the loop if a tick is stuck or nothing is scheduled. Silent while healthy. */
function checkPollLoop(): void {
	const run = currentPoll;
	if (run) {
		const stalledMs = Date.now() - run.startedAt;
		if (stalledMs < STALL_AFTER_MS || abandonedPolls.size >= MAX_ABANDONED_POLLS) return;
		abandonedPolls.set(run, run.stage);
		currentPoll = null;
		log.warn("Resource monitor poll stalled; starting a fresh one", { stage: run.stage, stalledMs, abandoned: abandonedPolls.size });
		schedulePoll(0);
		return;
	}
	if (!pollTimer) {
		log.warn("Resource monitor poll was not scheduled; restarting it");
		schedulePoll(0);
	}
}

function isBoosted(): boolean {
	return Date.now() < boostUntil;
}

function currentIntervalMs(): number {
	return isBoosted() ? BOOSTED_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
}

/**
 * Ask for the fast tick, e.g. while the tmux sessions popover is open. Renew it
 * before {@link BOOST_TTL_MS} elapses or it lapses back to the slow cadence on
 * its own. Pulls the next tick forward so opening the popover does not wait out
 * the remainder of a 10 s interval.
 */
export function boostResourceMonitor(): void {
	const wasBoosted = isBoosted();
	boostUntil = Date.now() + BOOST_TTL_MS;
	// A tick in flight reschedules at the boosted interval when it ends; starting
	// another now would run two loops side by side.
	if (!pollTimer || wasBoosted) return;
	schedulePoll(0);
}

/** Drop back to the slow tick immediately (the popover closed). */
export function clearResourceMonitorBoost(): void {
	boostUntil = 0;
}

/** Whether the fast tick is currently in force. */
export function isResourceMonitorBoosted(): boolean {
	return isBoosted();
}

export function startResourceMonitor(push: PushMessageFn): void {
	pushMessageFn = push;
	previousCpuTimes = sumCpuTimes(cpus());
	log.info("Resource monitor started", { intervalMs: POLL_INTERVAL_MS });
	// Keep the machine awake while the app runs (per setting) or while remote
	// access is active (forced on). Owned by a timer of its own, so a stuck
	// tick here cannot stop it.
	startSleepInhibitWatch(async () => (await import("./remote-access-server")).isRemoteAccessActive);
	if (watchdogTimer) clearInterval(watchdogTimer);
	watchdogTimer = setInterval(checkPollLoop, WATCHDOG_INTERVAL_MS);
	schedulePoll(POLL_INTERVAL_MS);
}

export function stopResourceMonitor(): void {
	stopSleepInhibitWatch();
	if (watchdogTimer) {
		clearInterval(watchdogTimer);
		watchdogTimer = null;
	}
	if (pollTimer) {
		clearTimeout(pollTimer);
		pollTimer = null;
	}
	// A tick in flight finishes as an orphan and does not reschedule.
	currentPoll = null;
	abandonedPolls.clear();
	usageData.clear();
	memorySnapshot = null;
	previousSwapOutCount = null;
	loadSnapshot = null;
	previousCpuTimes = null;
	boostUntil = 0;
}

/**
 * Latest system-memory snapshot, or null before the first poll completes.
 * The header widget renders nothing until this is non-null — a placeholder pill
 * would cause exactly the header layout shift the UX manifest warns about.
 */
export function getSystemMemorySnapshot(): SystemMemorySnapshot | null {
	return memorySnapshot;
}

/** Latest CPU/disk snapshot, or null before the second poll (busy % needs a delta). */
export function getSystemLoadSnapshot(): SystemLoadSnapshot | null {
	return loadSnapshot;
}

/**
 * Get cached resource usage for a task (by short ID — first 8 chars of taskId).
 */
export function getResourceUsage(taskId: string): ResourceUsage | undefined {
	return usageData.get(taskId.slice(0, 8));
}
