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
 * everything here just measures the three inputs it needs.
 */

import { createLogger } from "./logger";
import { evaluateQuietWindow, MAX_UPDATE_ATTEMPTS, PTY_QUIET_MS, retryBackoffMs } from "../shared/self-update";
import type { UpdateChannel } from "../shared/update-channel";
import { buildPlan, runSelfUpdate } from "./self-update";

const log = createLogger("self-update-watch");

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60_000;

interface WatchState {
	/** Version currently on offer, so a new release resets the pending clock. */
	pendingVersion: string | null;
	pendingSinceMs: number;
	/** When the three quiet conditions last STARTED holding. Owned by the evaluator. */
	quietSinceMs: number | null;
	/** Failed attempts at `pendingVersion`. Reset only by a NEW version appearing. */
	failedAttempts: number;
	lastFailureMs: number | null;
	/** True once the give-up has been logged, so it is said loudly exactly once. */
	gaveUpLogged: boolean;
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
	announced: new Set(),
	loggedRefusals: new Set(),
};

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * How many tasks sit in the `in-progress` column right now, across every project
 * including the virtual "Operations" boards.
 *
 * A restart does NOT kill an agent — tmux sessions are detached and the headless
 * entry rehydrates lifecycles at boot — so this is not a safety gate. It is the
 * one condition strict enough to still apply past the 72-hour ceiling, because a
 * restart landing mid-worktree-creation is the one case that leaves real mess.
 */
async function countTasksInProgress(): Promise<number> {
	const data = await import("./data");
	const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
	let count = 0;
	for (const project of projects) {
		const tasks = await data.loadTasks(project);
		count += tasks.filter((task) => task.status === "in-progress").length;
	}
	return count;
}

/**
 * Milliseconds since the freshest terminal output on the box, or null when it
 * cannot be read.
 *
 * tmux has no per-pane activity variable, so `window_activity` (epoch seconds,
 * per WINDOW) is the freshest honest signal — the same one `dev3 peek` reports and
 * labels as window-level. NULL, NOT INFINITY, is the answer when a session has no
 * tmux socket (the native terminal backend publishes no equivalent) or tmux
 * refuses: a probe that cannot see is not evidence of quiet.
 */
export async function probePtyIdleMs(now: number = Date.now()): Promise<number | null> {
	try {
		const { getActiveSessionIds } = await import("./pty-server");
		const sessions = getActiveSessionIds();
		if (sessions.length === 0) return Number.MAX_SAFE_INTEGER; // nothing running at all
		// A session with no tmux socket is on the native backend, which publishes no
		// activity time at all — so the box as a whole becomes unreadable, not partly readable.
		if (sessions.some((session) => !session.tmuxSocket)) return null;
		const sockets = new Set(sessions.map((session) => session.tmuxSocket));
		const { tmux } = await import("./tmux");
		const { PEEK_PANE_FORMAT } = await import("./tmux/formats");
		let newest = 0;
		for (const socket of sockets) {
			const rows = await tmux.listPanes(PEEK_PANE_FORMAT, { scope: "server", socket });
			for (const row of rows) {
				if (row.windowActivity > newest) newest = row.windowActivity;
			}
		}
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

async function checkOnce(push: (name: string, payload: unknown) => void): Promise<void> {
	const channel = await selectedChannel();
	const { plan, install, summary } = await buildPlan(channel);

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
		log.info("Update pending", { version: plan.version, summary });
	}

	// Let any connected browser show the ordinary header plaque, once per version.
	if (!state.announced.has(plan.version)) {
		state.announced.add(plan.version);
		push("updateAvailable", { version: plan.version });
	}

	if (!(await silentUpdatesEnabled())) {
		log.info("Silent updates are off in settings — waiting for someone to press Update", {
			version: plan.version,
		});
		return;
	}

	const [tasksInProgress, ptyIdleMs, browserClients] = await Promise.all([
		countTasksInProgress(),
		probePtyIdleMs(),
		browserClientCount(),
	]);
	const verdict = evaluateQuietWindow({
		tasksInProgress,
		ptyIdleMs,
		browserClients,
		quietSinceMs: state.quietSinceMs,
		pendingSinceMs: state.pendingSinceMs,
		failedAttempts: state.failedAttempts,
		lastFailureMs: state.lastFailureMs,
		now: Date.now(),
	});
	state.quietSinceMs = verdict.quietSinceMs;

	if (verdict.decision === "wait") {
		const givingUp = state.failedAttempts >= MAX_UPDATE_ATTEMPTS;
		if (givingUp && !state.gaveUpLogged) {
			state.gaveUpLogged = true;
			log.error("Giving up on this version — it has to be installed by hand", {
				version: plan.version,
				attempts: state.failedAttempts,
			});
		} else if (!givingUp) {
			log.info("Holding off the silent update", {
				version: plan.version,
				reason: verdict.reason,
				tasksInProgress,
				browserClients,
				ptyQuietThresholdMs: PTY_QUIET_MS,
			});
		}
		return;
	}

	log.info("Applying update silently", { version: plan.version, reason: verdict.reason });
	const outcome = await runSelfUpdate({ channel, restart: true });
	if (!outcome.ok) {
		state.failedAttempts += 1;
		state.lastFailureMs = Date.now();
		state.quietSinceMs = null;
		log.error("Silent update failed — the server is still running the old build", {
			error: outcome.message,
			attempt: state.failedAttempts,
			nextTryInMs: retryBackoffMs(state.failedAttempts),
		});
	}
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
	state.announced.clear();
	state.loggedRefusals.clear();
}
