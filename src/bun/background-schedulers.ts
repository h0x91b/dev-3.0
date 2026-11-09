import { startFocusTracker, stopFocusTracker } from "./focus-tracker";
import { startAutomationsScheduler, stopAutomationsScheduler } from "./automations-scheduler";
import { startScheduledLaunchScheduler, stopScheduledLaunchScheduler } from "./scheduled-launch-scheduler";
import { startScheduledMessageScheduler, stopScheduledMessageScheduler } from "./scheduled-message-scheduler";
import { startTaskKeepAliveScheduler, stopTaskKeepAliveScheduler } from "./task-keep-alive-scheduler";
import { startWorktreeCleanupScheduler, stopWorktreeCleanupScheduler } from "./worktree-cleanup-scheduler";
import { discoverPeerSockets } from "./instance-broadcast";
import { startLogArchiveScheduler, stopLogArchiveScheduler } from "./log-archive-scheduler";
import { createLogger } from "./logger";

const log = createLogger("background-schedulers");

/** How often a yielding process re-checks whether it should own the schedulers. */
const OWNERSHIP_CHECK_MS = 10_000;

export interface BackgroundSchedulerOptions {
	/**
	 * Run the clock-driven schedulers only while no other dev3 app process is alive.
	 * Their ticks have no cross-process claim, so two processes on one `~/.dev3.0`
	 * would fire every automation and "Send later" message twice.
	 */
	yieldToPeers?: boolean;
	/** Injected for tests; defaults to the live peer-socket probe. */
	hasPeers?: () => boolean;
}

let clockJobsRunning = false;
let ownershipTimer: ReturnType<typeof setInterval> | null = null;

function startClockJobs(): void {
	if (clockJobsRunning) return;
	clockJobsRunning = true;
	// Scheduled agent runs. The first tick also surfaces occurrences missed offline.
	startAutomationsScheduler();
	// "Start in" deferred task launches. One-shot; the first tick catches up launches due offline.
	startScheduledLaunchScheduler();
	// "Send later" prompts into a task's live agent. One-shot; late fires notify.
	startScheduledMessageScheduler();
	// Revives opted-in tasks whose agent conversation died (exit, rate limit, network).
	startTaskKeepAliveScheduler();
	// Daily `doctor --worktrees --prune-older-than 14d`. First check an hour after boot.
	startWorktreeCleanupScheduler();
	// Packs day logs older than three days into `.tgz`. First pass five minutes after boot.
	startLogArchiveScheduler();
}

function stopClockJobs(): void {
	clockJobsRunning = false;
	const stops = [
		stopAutomationsScheduler,
		stopScheduledLaunchScheduler,
		stopScheduledMessageScheduler,
		stopTaskKeepAliveScheduler,
		stopWorktreeCleanupScheduler,
		stopLogArchiveScheduler,
	];
	for (const stop of stops) {
		try { stop(); } catch (err) { log.warn(`${stop.name} failed`, { error: String(err) }); }
	}
}

function reconcileOwnership(hasPeers: () => boolean): void {
	let peers: boolean;
	try {
		peers = hasPeers();
	} catch (err) {
		// Unknown is treated as "someone else may fire": a missed tick is cheaper than a double fire.
		log.warn("Peer probe failed; leaving schedulers to the other process", { error: String(err) });
		peers = true;
	}
	if (peers && clockJobsRunning) {
		log.info("Another dev3 process is running; it owns the schedulers");
		stopClockJobs();
	} else if (!peers && !clockJobsRunning) {
		log.info("No other dev3 process; this one owns the schedulers");
		startClockJobs();
	}
}

/**
 * Every background job, started by both entries: the desktop app (index.ts) and
 * `dev3 remote` (headless-entry.ts). A scheduler started from one entry only
 * silently never fires on the other, so a new one goes here, not into an entry.
 */
export function startBackgroundSchedulers(options: BackgroundSchedulerOptions = {}): void {
	// Per-task attention time ("your time" on the Productivity dashboard), from the window
	// focus and active task this process's own clients report, so it never yields.
	startFocusTracker();
	if (!options.yieldToPeers) {
		startClockJobs();
		return;
	}
	if (ownershipTimer) return;
	const hasPeers = options.hasPeers ?? (() => discoverPeerSockets().length > 0);
	reconcileOwnership(hasPeers);
	ownershipTimer = setInterval(() => reconcileOwnership(hasPeers), OWNERSHIP_CHECK_MS);
}

/** Stops every job. The promise settles once the focus tracker's pending time is on disk. */
export function stopBackgroundSchedulers(): Promise<void> {
	if (ownershipTimer) clearInterval(ownershipTimer);
	ownershipTimer = null;
	stopClockJobs();
	try {
		return stopFocusTracker();
	} catch (err) {
		log.warn("stopFocusTracker failed", { error: String(err) });
		return Promise.resolve();
	}
}
