/**
 * Sleep prevention via macOS `caffeinate`.
 *
 * When enabled in global settings and at least one agent tmux session is active,
 * spawns `caffeinate` to prevent the system from sleeping. When all sessions end
 * (or the setting is toggled off), the caffeinate process is killed.
 *
 * caffeinate is an optional dependency — if not found on PATH, the feature
 * defaults to off and the settings UI shows a hint.
 */

import { spawn, spawnSync } from "./spawn";
import { loadSettingsSync } from "./settings";
import { createLogger } from "./logger";

const log = createLogger("caffeinate");

let caffeinateProc: ReturnType<typeof spawn> | null = null;
let caffeinateAvailable: boolean | null = null; // cached after first check

/**
 * Check whether `caffeinate` binary is available on PATH.
 * Result is cached for the lifetime of the process.
 */
export function isCaffeinateAvailable(): boolean {
	if (caffeinateAvailable !== null) return caffeinateAvailable;
	try {
		const result = spawnSync(["which", "caffeinate"]);
		caffeinateAvailable = result.exitCode === 0;
	} catch {
		caffeinateAvailable = false;
	}
	log.info("caffeinate availability check", { available: caffeinateAvailable });
	return caffeinateAvailable;
}

/**
 * Returns whether sleep prevention is currently enabled per settings.
 * If `preventSleepWhileRunning` is undefined (never set), defaults to true
 * when caffeinate is available, false otherwise.
 */
export function isPreventSleepEnabled(): boolean {
	const settings = loadSettingsSync();
	if (settings.preventSleepWhileRunning !== undefined) {
		return settings.preventSleepWhileRunning;
	}
	// Default: true if caffeinate is available
	return isCaffeinateAvailable();
}

/**
 * Start the caffeinate process if not already running.
 * Uses `caffeinate -s` to prevent system sleep (allows display sleep).
 */
function startCaffeinate(): void {
	if (caffeinateProc) return; // already running
	if (!isCaffeinateAvailable()) return;

	try {
		caffeinateProc = spawn(["caffeinate", "-s"]);
		log.info("caffeinate started", { pid: caffeinateProc.pid });

		// Clean up reference if the process exits unexpectedly
		caffeinateProc.exited.then((code) => {
			log.info("caffeinate exited", { pid: caffeinateProc?.pid, code });
			caffeinateProc = null;
		}).catch(() => {
			caffeinateProc = null;
		});
	} catch (err) {
		log.error("Failed to start caffeinate", { error: String(err) });
		caffeinateProc = null;
	}
}

/**
 * Stop the caffeinate process if running.
 */
function stopCaffeinate(): void {
	if (!caffeinateProc) return;
	try {
		log.info("Stopping caffeinate", { pid: caffeinateProc.pid });
		caffeinateProc.kill();
	} catch (err) {
		log.warn("Failed to kill caffeinate", { error: String(err) });
	}
	caffeinateProc = null;
}

/**
 * Called from resource-monitor's poll cycle with the number of active
 * agent tmux sessions. Starts or stops caffeinate based on whether
 * agents are running and the setting is enabled.
 */
export function updateCaffeinateState(activeSessionCount: number): void {
	const enabled = isPreventSleepEnabled();
	if (enabled && activeSessionCount > 0) {
		startCaffeinate();
	} else {
		stopCaffeinate();
	}
}

/**
 * Force-stop caffeinate. Called on app shutdown.
 */
export function shutdownCaffeinate(): void {
	stopCaffeinate();
}

/**
 * Returns whether a caffeinate process is currently running.
 * Useful for debugging / status display.
 */
export function isCaffeinateRunning(): boolean {
	return caffeinateProc !== null;
}
