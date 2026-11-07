import { startFocusTracker, stopFocusTracker } from "./focus-tracker";
import { startAutomationsScheduler, stopAutomationsScheduler } from "./automations-scheduler";
import { startScheduledLaunchScheduler, stopScheduledLaunchScheduler } from "./scheduled-launch-scheduler";
import { startScheduledMessageScheduler, stopScheduledMessageScheduler } from "./scheduled-message-scheduler";
import { startTaskKeepAliveScheduler, stopTaskKeepAliveScheduler } from "./task-keep-alive-scheduler";
import { startWorktreeCleanupScheduler, stopWorktreeCleanupScheduler } from "./worktree-cleanup-scheduler";

/**
 * Every clock-driven background job, started by both entries: the desktop app (index.ts)
 * and `dev3 remote` (headless-entry.ts). A scheduler started from one entry only
 * silently never fires on the other, so a new one goes here, not into an entry.
 */
export function startBackgroundSchedulers(): void {
	// Scheduled agent runs. The first tick also surfaces occurrences missed offline.
	startAutomationsScheduler();
	// "Start in" deferred task launches. One-shot; the first tick catches up launches due offline.
	startScheduledLaunchScheduler();
	// "Send later" prompts into a task's live agent. One-shot; late fires notify.
	startScheduledMessageScheduler();
	// Revives opted-in tasks whose agent conversation died (exit, rate limit, network).
	startTaskKeepAliveScheduler();
	// Daily `doctor --worktrees --prune-older-than 14d`. First check an hour after boot.
	// A desktop app beside a headless server is safe: the shared state file claims the day.
	startWorktreeCleanupScheduler();
	// Per-task attention time ("your time" on the Productivity dashboard), from the
	// window focus and active task that any client, desktop or browser, reports.
	startFocusTracker();
}

export function stopBackgroundSchedulers(): void {
	stopAutomationsScheduler();
	stopScheduledLaunchScheduler();
	stopScheduledMessageScheduler();
	stopTaskKeepAliveScheduler();
	stopWorktreeCleanupScheduler();
	// Flushes attention time still in memory.
	stopFocusTracker();
}
