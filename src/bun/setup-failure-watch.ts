/**
 * Watch for a `setupScript` that failed inside a task pane.
 *
 * The setup wrapper runs in the pane, so bun never sees its exit code. The
 * wrapper writes the code to `setupExitCodePath(taskId)` and this watcher picks
 * it up, which is what raises the pane's "start the agent anyway" card.
 *
 * It deliberately does NOT go through the dev3 CLI. `~/.dev3.0/bin/dev3` is
 * rewritten by whichever instance launched last (16 times in one morning on a
 * dev machine), and its socket resolves to any live app, not the one that owns
 * this task — so a shelled-out ping reached the wrong process or an older build
 * that had never heard of the method, and failed silently. The app that started
 * the launch is the only one that must learn about the failure, and it is
 * already right here.
 *
 * Polling, not fs.watch: the file does not exist yet when the watch starts, and
 * watching its directory means watching the whole temp root.
 */

import { existsSync, readFileSync } from "node:fs";
import { createLogger } from "./logger";
import { setupExitCodePath } from "./temp-paths";

const log = createLogger("setup-failure-watch");

/** How often to look for the file. Setup failures are not latency-sensitive. */
const POLL_INTERVAL_MS = 1000;

/**
 * Give up after this long. A setup script may legitimately run for a long time
 * (a cold `bun install` plus a build), so this is only a leak stop, not a
 * verdict — a launch that outlives it simply loses the card.
 */
const MAX_WATCH_MS = 60 * 60 * 1000;

const timers = new Map<string, ReturnType<typeof setInterval>>();

/** Parse the recorded code. A missing/garbled file still means "it failed". */
export function parseSetupExitCode(raw: string): number {
	const parsed = Number.parseInt(raw.trim(), 10);
	return Number.isFinite(parsed) && parsed !== 0 ? parsed : 1;
}

/** Stop watching a task, if it is being watched. Safe to call unconditionally. */
export function stopSetupFailureWatch(taskId: string): void {
	const timer = timers.get(taskId);
	if (!timer) return;
	clearInterval(timer);
	timers.delete(taskId);
}

/** Tasks currently under watch — for tests and diagnostics. */
export function watchedSetupFailureTasks(): string[] {
	return [...timers.keys()];
}

/**
 * Start watching for `taskId`'s setup verdict. Replaces any previous watch for
 * the same task, so a relaunch never leaves two timers behind. `onFailure` is
 * invoked at most once, with the recorded exit code.
 */
export function watchSetupFailure(
	taskId: string,
	onFailure: (exitCode: number) => void | Promise<void>,
	opts?: { intervalMs?: number; maxMs?: number },
): void {
	stopSetupFailureWatch(taskId);
	const path = setupExitCodePath(taskId);
	const intervalMs = opts?.intervalMs ?? POLL_INTERVAL_MS;
	const deadline = Date.now() + (opts?.maxMs ?? MAX_WATCH_MS);

	const timer = setInterval(() => {
		if (Date.now() > deadline) {
			log.info("Setup watch expired", { taskId: taskId.slice(0, 8) });
			stopSetupFailureWatch(taskId);
			return;
		}
		if (!existsSync(path)) return;
		let raw = "";
		try {
			raw = readFileSync(path, "utf-8");
		} catch {
			// Caught mid-write: the next tick reads it.
			return;
		}
		if (raw.trim() === "") return;
		stopSetupFailureWatch(taskId);
		const exitCode = parseSetupExitCode(raw);
		log.info("Setup script failed", { taskId: taskId.slice(0, 8), exitCode });
		void (async () => {
			try {
				await onFailure(exitCode);
			} catch (err) {
				log.warn("Failed to report a setup failure (non-fatal)", { error: String(err) });
			}
		})();
	}, intervalMs);

	// Never hold the process open for a launch nobody is waiting on.
	timer.unref?.();
	timers.set(taskId, timer);
}
