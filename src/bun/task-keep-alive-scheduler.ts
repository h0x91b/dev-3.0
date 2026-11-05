import type { Project, Task } from "../shared/types";
import { getTaskTitle } from "../shared/types";
import type { KeepAliveState } from "../shared/types/keep-alive";
import { AGENT_TIME_STATUSES, TERMINAL_STATUSES } from "../shared/types/task";
import {
	KEEP_ALIVE_MAX_ATTEMPTS,
	keepAliveBackoffMs,
	keepAliveRateLimitSource,
	keepAliveRateLimitWaitUntil,
} from "../shared/keep-alive";
import * as data from "./data";
import { createLogger } from "./logger";
import { getCachedRateLimitsReport } from "./rate-limit-monitor";
import { getPushMessage, pushCliAttention, pushCliToast } from "./rpc-handlers";
import { ResumeUnavailableError, resumeTaskSession, taskTerminalAlive } from "./rpc-handlers/tmux-pty";
import { taskMainAgentLiveness } from "./scheduled-message-author";

const log = createLogger("task-keep-alive-scheduler");

/**
 * How often the watchdog checks kept-alive tasks. Deliberately gentle: keep-alive
 * is for unattended, long-running tasks, so a few minutes before a revive costs
 * nothing, and each tick loads every project's tasks and probes the process table
 * per kept-alive task.
 */
const TICK_INTERVAL_MS = 5 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/**
 * The "keep alive" watchdog: for every task the user opted into auto-revive
 * ({@link Task.keepAlive}.enabled), notice when its agent conversation has died
 * and relaunch + resume it via the shared {@link resumeTaskSession} seam, with
 * exponential backoff, a known rate-limit reset honoured instead of hammering,
 * and a retry cap that escalates to the user instead of trying forever.
 *
 * Only tasks whose agent SHOULD be running ({@link AGENT_TIME_STATUSES}) and that
 * were actually launched are revive candidates; a hibernated task is never
 * touched (that is an explicit-consent teardown). Runs in the desktop app and in
 * `dev3 remote` headless, like the other schedulers.
 */
export function startTaskKeepAliveScheduler(): void {
	if (timer) return;
	log.info("Task keep-alive scheduler started", { tickMs: TICK_INTERVAL_MS });
	void tick();
	timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
}

export function stopTaskKeepAliveScheduler(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

async function tick(): Promise<void> {
	if (tickInFlight) return; // never overlap ticks
	tickInFlight = true;
	try {
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		for (const project of projects) {
			try {
				await tickProject(project);
			} catch (err) {
				log.error("Keep-alive tick failed for project", { projectId: project.id, error: String(err) });
			}
		}
	} catch (err) {
		log.error("Keep-alive tick failed", { error: String(err) });
	} finally {
		tickInFlight = false;
	}
}

async function tickProject(project: Project): Promise<void> {
	const tasks = await data.loadTasks(project);
	const now = Date.now();
	for (const task of tasks) {
		if (!task.keepAlive?.enabled) continue;
		// Inert, exactly like hibernation/draft: the property forbids nothing here.
		if (task.hibernated || task.draft) continue;
		if (TERMINAL_STATUSES.includes(task.status)) continue;
		try {
			const candidate = AGENT_TIME_STATUSES.includes(task.status)
				&& (task.sessionState?.panes?.length ?? 0) > 0;
			if (candidate) {
				await evaluateTask(project, task, now);
			} else {
				// Agent is legitimately idle/waiting (Has Questions, Your Review) or
				// not yet launched — not a death. Keep the marker honest.
				await resetToWatching(project, task);
			}
		} catch (err) {
			log.error("Keep-alive check failed for task", { taskId: task.id.slice(0, 8), error: String(err) });
		}
	}
}

/** Exported for unit tests — the per-task revive decision. */
export async function evaluateTask(project: Project, task: Task, now: number): Promise<void> {
	// Liveness is the AGENT PROCESS, not the tmux session: panes keep a shell after
	// the agent exits (`keepShell`), so a live session is not a live agent.
	const liveness = await taskMainAgentLiveness(task);
	if (liveness === "alive") {
		await resetToWatching(project, task);
		return;
	}
	// Reviving tears the terminal down, so a guess never may: without proof the
	// agent exited, only a terminal that is gone altogether counts as a death.
	const terminalAlive = await taskTerminalAlive(task);
	if (liveness === "unknown" && terminalAlive) return;
	const ka = task.keepAlive!;
	if (ka.status === "gave-up") return; // escalated to the user; waits for them
	if (ka.nextAttemptAt != null && now < ka.nextAttemptAt) return; // backoff / rate-limit window

	// Rate-limit awareness: wait for the known reset instead of hammering a blocked account.
	const waitUntil = rateLimitWaitUntil(task, now);
	if (waitUntil != null && now < waitUntil) {
		await patchKeepAlive(project, task, { status: "reviving", nextAttemptAt: waitUntil, lastVerdict: "rate-limited" });
		return;
	}

	const attempts = (ka.attempts ?? 0) + 1;
	if (attempts > KEEP_ALIVE_MAX_ATTEMPTS) {
		const reason = `No luck after ${KEEP_ALIVE_MAX_ATTEMPTS} tries`;
		await patchKeepAlive(project, task, { status: "gave-up", lastVerdict: "gave-up", gaveUpReason: reason });
		notifyGaveUp(project, task, reason);
		return;
	}

	// Record the attempt and arm the next backoff BEFORE awaiting, so a slow or
	// failing resume cannot double-fire on the next tick.
	await patchKeepAlive(project, task, {
		status: "reviving",
		attempts,
		lastAttemptAt: new Date(now).toISOString(),
		nextAttemptAt: now + keepAliveBackoffMs(attempts),
		lastVerdict: "revived",
	});

	try {
		// Replacement shares the resume lock with user restarts, so the watchdog
		// cannot tear down a terminal another caller just relaunched.
		const outcome = await resumeTaskSession(task.id, terminalAlive ? { restart: "if-exited" } : { refuseLive: true });
		if (outcome.kind === "already-running") {
			await patchKeepAlive(project, task, { lastVerdict: "error" });
			log.warn("Keep-alive left a live or unverified terminal alone", { taskId: task.id.slice(0, 8), attempts });
			return;
		}
		log.info("Keep-alive revived a task", { taskId: task.id.slice(0, 8), attempts });
	} catch (err) {
		if (err instanceof ResumeUnavailableError) {
			// Nothing safe to reopen (no saved session, Codex transcript ambiguity).
			// Retrying will not change that — stop and surface it.
			const reason = "Conversation can't be resumed";
			await patchKeepAlive(project, task, { status: "gave-up", lastVerdict: "unresumable", gaveUpReason: reason });
			notifyGaveUp(project, task, reason);
			return;
		}
		// Transient failure — keep the armed backoff and let the next tick retry.
		await patchKeepAlive(project, task, { lastVerdict: "error" });
		log.error("Keep-alive revive attempt failed", { taskId: task.id.slice(0, 8), attempts, error: String(err) });
	}
}

/** The epoch-ms time to wait until when the task's account is rate-limit-blocked, else null. */
function rateLimitWaitUntil(task: Task, now: number): number | null {
	const pane = task.sessionState?.panes?.[0];
	const source = keepAliveRateLimitSource(pane?.agentFamily);
	if (!source) return null;
	return keepAliveRateLimitWaitUntil(getCachedRateLimitsReport(), source, pane?.accountId ?? null, now);
}

/** Clear watchdog bookkeeping back to a resting "watching" state (idempotent). */
async function resetToWatching(project: Project, task: Task): Promise<void> {
	const ka = task.keepAlive;
	if (!ka) return;
	const resting = (ka.status ?? "watching") === "watching"
		&& (ka.attempts ?? 0) === 0
		&& ka.nextAttemptAt == null
		&& (ka.gaveUpReason ?? null) === null;
	if (resting) return;
	await patchKeepAlive(project, task, {
		status: "watching",
		attempts: 0,
		nextAttemptAt: null,
		lastVerdict: "healthy",
		gaveUpReason: null,
	});
}

async function patchKeepAlive(project: Project, task: Task, patch: Partial<KeepAliveState>): Promise<void> {
	let wrote = false;
	// Read-modify-write under the tasks-file lock so a user who disables keep-alive
	// mid-tick is respected — the watchdog never resurrects `enabled`.
	const { task: updated } = await data.updateTaskWith(project, task.id, (current) => {
		if (!current.keepAlive?.enabled) return { updates: {}, result: null };
		wrote = true;
		const next: KeepAliveState = { ...current.keepAlive, ...patch, enabled: true };
		return { updates: { keepAlive: next }, result: null };
	});
	task.keepAlive = updated.keepAlive; // keep the in-tick copy in sync
	if (wrote) getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
}

function notifyGaveUp(project: Project, task: Task, reason: string): void {
	const title = getTaskTitle(task);
	pushCliAttention({ taskId: task.id, projectId: project.id, reason: `Keep alive gave up — ${reason}` });
	pushCliToast({
		taskId: task.id,
		projectId: project.id,
		level: "error",
		message: `Keep alive gave up on "${title}" — ${reason}`,
		taskSeq: task.seq,
		taskTitle: title,
		projectName: project.name,
	});
}
