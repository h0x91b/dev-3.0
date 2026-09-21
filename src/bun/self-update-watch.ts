/**
 * The half of self-update nobody clicks: a headless box that updates itself once
 * it is quiet.
 *
 * This exists because the button is not enough. A `dev3 remote` box lives on a
 * machine nobody opens a terminal on — the operator reaches it from a phone — so
 * "there is an update, press restart" is a prompt that never gets pressed. Months
 * of releases pile up, including the fixes the operator reported themselves.
 *
 * Same 30-minute cadence as the desktop auto-check. The DECISION of whether a
 * moment is quiet enough is `evaluateQuietWindow` in `src/shared/self-update.ts`;
 * everything here measures the browser, terminal, and restart-ownership facts it
 * needs. A supervisor-owned process cannot promise that detached agents survive:
 * systemd and container runtimes may tear down the whole cgroup/container.
 */

import { evaluateQuietWindow, MAX_UPDATE_ATTEMPTS, PTY_QUIET_MS, retryBackoffMs, type UpdatePlan } from "../shared/self-update";
import { ACTIVE_STATUSES, type RemoteUpdateAttempts, type Task } from "../shared/types";
import type { UpdateChannel } from "../shared/update-channel";
import * as data from "./data";
import { createLogger } from "./logger";
import { nativeTaskPanesAlive } from "./native-task-panes";
import { readRemoteState, recordUpdateFailure } from "./remote-state";
import { buildPlan, chooseRestartStrategy, runSelfUpdate } from "./self-update";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";

const log = createLogger("self-update-watch");

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60_000;

interface WatchState {
	/** Version currently on offer, so a new release resets the pending clock. */
	pendingVersion: string | null;
	pendingSinceMs: number;
	/** When the measurable quiet conditions last STARTED holding. Owned by the evaluator. */
	quietSinceMs: number | null;
	/** Failed attempts at `pendingVersion`. Reset only by a NEW version appearing. */
	failedAttempts: number;
	lastFailureMs: number | null;
	/** True once the give-up has been logged, so it is said loudly exactly once. */
	gaveUpLogged: boolean;
	/** Version already fetched and extracted, so a press of Restart is fast. */
	preStaged: string | null;
	/** Failed pre-stages of `pendingVersion`, so a broken artifact is not re-fetched hourly. */
	preStageFailures: number;
	lastPreStageFailureMs: number | null;
	/** Versions already announced to connected browsers, so the plaque appears once. */
	announced: Set<string>;
	/** Refusal reasons already logged, so a box that can never update says why once. */
	loggedRefusals: Set<string>;
}

const state: WatchState = {
	pendingVersion: null,
	pendingSinceMs: 0,
	quietSinceMs: null,
	failedAttempts: 0,
	lastFailureMs: null,
	gaveUpLogged: false,
	preStaged: null,
	preStageFailures: 0,
	lastPreStageFailureMs: null,
	announced: new Set(),
	loggedRefusals: new Set(),
};

let timer: ReturnType<typeof setInterval> | null = null;

interface TaskUpdateSafety {
	/** Persisted agent sessions a supervisor restart could terminate. */
	agentsAtRisk: number;
	/** A live native terminal has no output timestamp, so its idleness is unknowable. */
	liveNativeSession: boolean;
}

/**
 * Could a supervisor restart right now kill a real agent process for this task,
 * going by persisted state alone?
 *
 * DELIBERATELY NOT `taskAgentSessionLooksLive`: that predicate answers "should we
 * TELL the user something", so it reads a missing `runtimeState` as live and hides
 * `preparing`. Both are wrong here. A restart landing mid-worktree-creation is the
 * one case that leaves real mess, and reading an absent hint as "running" lets a
 * single stale record pin a supervisor-owned box on an old build FOREVER — the
 * supervisor gate sits in front of the quiet window, so the 72-hour ceiling cannot
 * release it.
 *
 * `runtimeState` is additive: a task written by an older build may simply not carry
 * it. That is `unknown`, and the caller probes the terminal rather than guessing.
 */
function persistedAgentRisk(task: Task): "at-risk" | "idle" | "unknown" {
	if (task.hibernated || task.draft) return "idle";
	if (!task.worktreePath) return "idle"; // never launched: there is no agent to lose
	if (!ACTIVE_STATUSES.includes(task.status)) return "idle";
	if (task.preparing === true) return "at-risk";
	const runtime = task.runtimeState?.runtime;
	if (runtime === undefined) return "unknown";
	return runtime === "idle" ? "idle" : "at-risk";
}

/** Does this task's terminal answer on ITS OWN backend? A native task is never asked through tmux. */
async function terminalStillAlive(task: Task, native: boolean): Promise<boolean> {
	if (!native) {
		const { tmuxSessionExists } = await import("./pty-server");
		return await tmuxSessionExists(task.id, task.tmuxSocket ?? undefined);
	}
	try {
		return await nativeTaskPanesAlive(task.id);
	} catch (error) {
		log.debug("Native presence probe failed — assuming the agent is alive", {
			taskId: task.id.slice(0, 8),
			error: String(error),
		});
		return true;
	}
}

async function inspectTaskUpdateSafety(): Promise<TaskUpdateSafety> {
	const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
	let agentsAtRisk = 0;
	let liveNativeSession = false;
	for (const project of projects) {
		for (const task of await data.loadTasks(project)) {
			const risk = persistedAgentRisk(task);
			if (risk === "idle") continue;
			// AN UNUSABLE BACKEND FIELD MUST NOT THROW THE TICK AWAY. `taskTerminalBackendIdentity`
			// rejects a record it cannot read, and one such task would otherwise abort every
			// check for the life of the process — silent updates off, with one log line.
			let native: boolean;
			try {
				native = taskTerminalBackendIdentity(task) === "native";
			} catch (error) {
				log.debug("Task terminal backend is unreadable — counting it as a live agent", {
					taskId: task.id.slice(0, 8),
					error: String(error),
				});
				agentsAtRisk += 1;
				continue;
			}
			if (risk === "unknown" && !(await terminalStillAlive(task, native))) continue;
			agentsAtRisk += 1;
			if (!native) continue;
			try {
				if (await nativeTaskPanesAlive(task.id)) liveNativeSession = true;
			} catch (error) {
				log.debug("Native terminal activity probe could not prove a session quiet", {
					taskId: task.id.slice(0, 8),
					error: String(error),
				});
				liveNativeSession = true;
			}
		}
	}
	return { agentsAtRisk, liveNativeSession };
}

/**
 * Milliseconds since the freshest observable terminal output on the box, or
 * null when activity cannot be read safely.
 *
 * tmux has no per-pane activity variable, so `window_activity` (epoch seconds,
 * per WINDOW) is the freshest honest signal — the same one `dev3 peek` reports and
 * labels as window-level. NULL, NOT INFINITY, is the answer when a session has no
 * tmux socket (the native terminal backend publishes no equivalent) or tmux
 * refuses: a probe that cannot see is not evidence of quiet.
 *
 * THE TMUX SERVER IS ASKED, NOT THIS PROCESS'S SESSION MAP. `getActiveSessionIds`
 * lists only sessions THIS process attached — none, right after a restart.
 * Reading "no sessions" as "nothing running at all" would therefore declare a
 * freshly restarted box silent while detached agents were still printing.
 *
 * `liveNativeSession` comes from {@link inspectTaskUpdateSafety} — the caller has
 * already walked the board, so it is passed in rather than measured twice.
 */
export async function probePtyIdleMs(
	now: number,
	liveNativeSession: boolean,
): Promise<number | null> {
	try {
		if (liveNativeSession) return null;
		const { getActiveSessionIds } = await import("./pty-server");
		const { tmux, DEFAULT_TMUX_SOCKET, isTmuxError } = await import("./tmux");
		const { PEEK_PANE_FORMAT } = await import("./tmux/formats");
		const sockets = new Set<string>([DEFAULT_TMUX_SOCKET]);
		for (const session of getActiveSessionIds()) {
			// A session with no tmux socket is on the native backend, which publishes no
			// activity time at all — so the box as a whole becomes unreadable, not partly readable.
			if (!session.tmuxSocket) return null;
			sockets.add(session.tmuxSocket);
		}
		let newest = 0;
		let panes = 0;
		for (const socket of sockets) {
			let rows: Array<{ windowActivity: number }>;
			try {
				rows = await tmux.listPanes(PEEK_PANE_FORMAT, { scope: "server", socket });
			} catch (err) {
				// tmux ANSWERED and said no: on `list-panes -a` that is "no server running on
				// this socket", i.e. genuinely nothing there. A spawn failure or a timeout is
				// a probe that could not see, and that is not evidence of quiet.
				if (isTmuxError(err)) continue;
				log.debug("Terminal activity probe could not read a tmux socket", { socket, error: String(err) });
				return null;
			}
			panes += rows.length;
			for (const row of rows) {
				if (row.windowActivity > newest) newest = row.windowActivity;
			}
		}
		if (panes === 0) return Number.MAX_SAFE_INTEGER; // nothing running at all
		if (newest === 0) return null;
		return Math.max(0, now - newest * 1000);
	} catch (err) {
		log.debug("Terminal activity probe failed", { error: String(err) });
		return null;
	}
}

async function browserClientCount(): Promise<number> {
	const { getConnectedClientCount } = await import("./remote-access-server");
	return getConnectedClientCount();
}

async function silentUpdatesEnabled(): Promise<boolean> {
	const { loadSettings } = await import("./settings");
	return (await loadSettings()).remoteSilentUpdate !== false;
}

async function selectedChannel(): Promise<UpdateChannel> {
	const { loadSettings } = await import("./settings");
	return (await loadSettings()).updateChannel;
}

/** One tick. Exported so the state machine around it is testable without timers. */
export async function checkOnce(push: (name: string, payload: unknown) => void): Promise<void> {
	const channel = await selectedChannel();
	const { plan, install, summary, checkError } = await buildPlan(channel);

	// A FEED THAT DID NOT ANSWER IS NOT A VERDICT. `buildPlan` turns a network or
	// manifest error into a refusal, which would otherwise clear the pending clock
	// and the failure counters — so one blip on a flaky uplink erases the backoff,
	// the give-up, and the 72-hour ceiling that box may never otherwise reach.
	if (checkError) {
		log.debug("Update check failed — keeping the pending state as it is", { error: checkError });
		return;
	}

	if (plan.kind !== "brew" && plan.kind !== "tarball") {
		// Up to date, or this install can never self-update. Either way there is
		// nothing pending; log a refusal once per reason so the journal explains a
		// box that never updates instead of staying silent about it.
		if (plan.kind === "refused" && !state.loggedRefusals.has(plan.reason)) {
			state.loggedRefusals.add(plan.reason);
			log.warn("Self-update is not available on this install", { install, reason: plan.reason });
		}
		state.pendingVersion = null;
		state.quietSinceMs = null;
		return;
	}

	if (state.pendingVersion !== plan.version) {
		state.pendingVersion = plan.version;
		state.pendingSinceMs = Date.now();
		state.quietSinceMs = null;
		// A NEW BUILD IS THE ONLY THING THAT CLEARS A GIVE-UP. Whatever broke on the
		// last version may well be fixed in this one, and the operator should not have
		// to restart the server to get another attempt.
		state.failedAttempts = 0;
		state.lastFailureMs = null;
		state.gaveUpLogged = false;
		state.preStaged = null;
		state.preStageFailures = 0;
		state.lastPreStageFailureMs = null;
		log.info("Update pending", { version: plan.version, summary });
	}

	// Let any connected browser show the ordinary header plaque, once per version —
	// but ONLY count it as announced if somebody was actually listening. The usual
	// state of a headless box is zero clients (the operator's phone tab is closed),
	// and a push with no audience is simply dropped; marking it announced anyway
	// meant the plaque never appeared again for the life of the process, which is
	// precisely the case the "silent updates off" toggle exists for.
	const clients = await browserClientCount();
	if (!state.announced.has(plan.version) && clients > 0) {
		state.announced.add(plan.version);
		push("updateAvailable", { version: plan.version });
	}

	// The persisted count wins when it is higher: the failure it records — an update
	// that applied and then would not boot — happened in a process whose in-memory
	// counter died with it. READ BEFORE THE PRE-STAGE, because the give-up gates that
	// too: nothing should keep downloading a version dev3 has stopped trying.
	const persisted = persistedAttempts(plan.version);
	const failedAttempts = Math.max(state.failedAttempts, persisted?.failures ?? 0);
	const lastFailureMs = persisted && persisted.failures >= state.failedAttempts
		? persisted.lastFailureMs
		: state.lastFailureMs;

	const silent = await silentUpdatesEnabled();

	// STAGE BEFORE ANYBODY PRESSES ANYTHING. The Restart button runs the whole
	// update inside one RPC call, and the renderer gives up on that call after 120 s
	// — less than a ~76 MB download or a `brew fetch` needs — so it toasts a failure
	// for an update that then succeeds and restarts the box underneath the user.
	// With the release already staged, the apply is renames only.
	await preStage(plan, failedAttempts);

	if (!silent) {
		log.info("Silent updates are off in settings — waiting for someone to press Update", {
			version: plan.version,
		});
		return;
	}

	const taskSafety = await inspectTaskUpdateSafety();
	const restartStrategy = chooseRestartStrategy(process.env);
	if (restartStrategy === "supervisor-exit" && taskSafety.agentsAtRisk > 0) {
		state.quietSinceMs = null;
		log.info("Holding off the silent update", {
			version: plan.version,
			reason: "the process supervisor may terminate running agents",
			agentsAtRisk: taskSafety.agentsAtRisk,
			restartStrategy,
		});
		return;
	}
	const ptyIdleMs = await probePtyIdleMs(Date.now(), taskSafety.liveNativeSession);
	const verdict = evaluateQuietWindow({
		ptyIdleMs,
		browserClients: clients,
		quietSinceMs: state.quietSinceMs,
		pendingSinceMs: state.pendingSinceMs,
		failedAttempts,
		lastFailureMs,
		now: Date.now(),
	});
	state.quietSinceMs = verdict.quietSinceMs;

	if (verdict.decision === "wait") {
		const givingUp = failedAttempts >= MAX_UPDATE_ATTEMPTS;
		if (givingUp && !state.gaveUpLogged) {
			state.gaveUpLogged = true;
			log.error("Giving up on this version — it has to be installed by hand", {
				version: plan.version,
				attempts: failedAttempts,
				lastError: persisted?.lastError,
			});
		} else if (!givingUp) {
			log.info("Holding off the silent update", {
				version: plan.version,
				reason: verdict.reason,
				browserClients: clients,
				ptyQuietThresholdMs: PTY_QUIET_MS,
			});
		}
		return;
	}

	log.info("Applying update silently", { version: plan.version, reason: verdict.reason });
	const outcome = await runSelfUpdate({ channel, restart: true, silent: true });
	if (outcome.ok) return;

	// A REFUSAL IS NOT AN ATTEMPT. `runSelfUpdate` re-checks the feed, so a network
	// blip comes back as a refusal — and counting those would spend the version's
	// whole budget on nothing, then refuse the build forever. Only a real stage or
	// apply failure counts.
	if (outcome.refused) {
		log.info("Silent update declined without attempting anything", { reason: outcome.message });
		return;
	}
	state.failedAttempts = failedAttempts + 1;
	state.lastFailureMs = Date.now();
	state.quietSinceMs = null;
	recordUpdateFailure(plan.version, outcome.message);
	log.error("Silent update failed — the server is still running the old build", {
		error: outcome.message,
		attempt: state.failedAttempts,
		nextTryInMs: retryBackoffMs(state.failedAttempts),
	});
}

/** Attempts recorded on disk for `version`, ignoring counts left by an older one. */
function persistedAttempts(version: string): RemoteUpdateAttempts | null {
	const recorded = readRemoteState()?.updateAttempts;
	return recorded && recorded.version === version ? recorded : null;
}

/**
 * Fetch and extract the pending release now, so an apply is renames only.
 *
 * Failures are logged and swallowed: this is opportunistic. The real attempt runs
 * `stageUpdate` again and reports properly, and a second call reuses this tree
 * rather than downloading it twice.
 *
 * A PRE-STAGE IS AN ATTEMPT AT THE NETWORK, so it needs the same brakes the real
 * attempt has. When staging itself is what fails — a 404 on the artifact, a full
 * disk, an unwritable install dir — nothing is memoised, so an ungated pre-stage
 * re-downloaded ~76 MB every 30 minutes forever, including after the watch had
 * officially given up on that version. It carries its OWN failure count rather than
 * spending the update's budget: a pre-stage that fails has installed nothing.
 */
async function preStage(
	plan: Extract<UpdatePlan, { kind: "brew" | "tarball" }>,
	failedAttempts: number,
	now: number = Date.now(),
): Promise<void> {
	if (state.preStaged === plan.version) return;
	if (failedAttempts >= MAX_UPDATE_ATTEMPTS) return; // given up on this version
	if (state.lastPreStageFailureMs !== null) {
		const readyAt = state.lastPreStageFailureMs + retryBackoffMs(state.preStageFailures);
		if (now < readyAt) return;
	}
	const { stageUpdate } = await import("./self-update");
	const staged = await stageUpdate(plan);
	if (staged.ok) {
		state.preStaged = plan.version;
		state.preStageFailures = 0;
		state.lastPreStageFailureMs = null;
		log.info("Pre-staged the pending update so a restart is fast", { version: plan.version });
		return;
	}
	state.preStageFailures += 1;
	state.lastPreStageFailureMs = now;
	log.warn("Could not pre-stage the pending update; it will be fetched when applied", {
		version: plan.version,
		error: staged.error,
		attempt: state.preStageFailures,
		nextTryInMs: retryBackoffMs(state.preStageFailures),
	});
}

/**
 * Start the 30-minute check. Idempotent — a second call is a no-op, so a caller
 * cannot accidentally double the cadence.
 */
export function startSelfUpdateWatch(push: (name: string, payload: unknown) => void): void {
	if (timer) return;
	const tick = (): void => {
		checkOnce(push).catch((err) => log.error("Self-update check failed", { error: String(err) }));
	};
	setTimeout(tick, FIRST_CHECK_DELAY_MS);
	timer = setInterval(tick, CHECK_INTERVAL_MS);
	timer.unref?.();
	log.info("Self-update watch scheduled", { intervalMs: CHECK_INTERVAL_MS });
}

export function stopSelfUpdateWatch(): void {
	if (timer) clearInterval(timer);
	timer = null;
}

/** Reset module state — only for tests. */
export function _resetWatchState(): void {
	stopSelfUpdateWatch();
	state.pendingVersion = null;
	state.pendingSinceMs = 0;
	state.quietSinceMs = null;
	state.failedAttempts = 0;
	state.lastFailureMs = null;
	state.gaveUpLogged = false;
	state.preStaged = null;
	state.preStageFailures = 0;
	state.lastPreStageFailureMs = null;
	state.announced.clear();
	state.loggedRefusals.clear();
}
