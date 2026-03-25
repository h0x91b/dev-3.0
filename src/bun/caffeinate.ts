/**
 * Sleep prevention for macOS (`caffeinate`) and Linux (`systemd-inhibit`).
 *
 * When enabled in global settings and at least one agent tmux session is active,
 * spawns the appropriate platform command to prevent the system from sleeping.
 * When all sessions end (or the setting is toggled off), the process is killed.
 *
 * Both tools are optional dependencies — if not found on PATH, the feature
 * defaults to off and the settings UI shows a hint.
 */

import { spawn, spawnSync } from "./spawn";
import { loadSettingsSync } from "./settings";
import { createLogger } from "./logger";

const log = createLogger("caffeinate");

let sleepInhibitProc: ReturnType<typeof spawn> | null = null;
let inhibitAvailable: boolean | null = null; // cached after first check
let detectedBackend: "caffeinate" | "systemd-inhibit" | null = null;

// Safety timeout: the inhibit process exits on its own after this period.
// The 10-second poll cycle restarts it if sessions are still active.
// This prevents the process from running forever if the app crashes
// or the poll loop breaks.
const INHIBIT_TIMEOUT_SECS = 3600; // 1 hour

/**
 * Detect which sleep inhibit backend is available.
 * macOS → caffeinate, Linux → systemd-inhibit.
 * Result is cached for the lifetime of the process.
 */
function detectBackend(): "caffeinate" | "systemd-inhibit" | null {
	if (detectedBackend !== null) return detectedBackend;

	// Try caffeinate first (macOS, always present)
	try {
		if (spawnSync(["which", "caffeinate"]).exitCode === 0) {
			detectedBackend = "caffeinate";
			return detectedBackend;
		}
	} catch { /* not found */ }

	// Try systemd-inhibit (Linux with systemd)
	try {
		if (spawnSync(["which", "systemd-inhibit"]).exitCode === 0) {
			detectedBackend = "systemd-inhibit";
			return detectedBackend;
		}
	} catch { /* not found */ }

	return null;
}

/**
 * Check whether a sleep inhibit tool is available on PATH.
 * Result is cached for the lifetime of the process.
 */
export function isCaffeinateAvailable(): boolean {
	if (inhibitAvailable !== null) return inhibitAvailable;
	inhibitAvailable = detectBackend() !== null;
	log.info("Sleep inhibit availability check", { available: inhibitAvailable, backend: detectedBackend });
	return inhibitAvailable;
}

/**
 * Returns whether sleep prevention is currently enabled per settings.
 * If `preventSleepWhileRunning` is undefined (never set), defaults to true
 * when a sleep inhibit tool is available, false otherwise.
 */
export function isPreventSleepEnabled(): boolean {
	const settings = loadSettingsSync();
	if (settings.preventSleepWhileRunning !== undefined) {
		return settings.preventSleepWhileRunning;
	}
	// Default: true if an inhibit tool is available
	return isCaffeinateAvailable();
}

/**
 * Build the command to inhibit sleep for the detected backend.
 */
function buildInhibitCommand(): string[] | null {
	const backend = detectBackend();
	if (!backend) return null;

	if (backend === "caffeinate") {
		// -s: prevent system sleep (allows display sleep)
		// -t: auto-exit after timeout
		return ["caffeinate", "-s", "-t", String(INHIBIT_TIMEOUT_SECS)];
	}

	// systemd-inhibit wraps a command; we use `sleep` as the payload
	return [
		"systemd-inhibit",
		"--what=sleep",
		"--who=dev-3.0",
		"--reason=Agents running",
		"sleep", String(INHIBIT_TIMEOUT_SECS),
	];
}

/**
 * Start the sleep inhibit process if not already running.
 */
function startInhibit(): void {
	if (sleepInhibitProc) return; // already running
	if (!isCaffeinateAvailable()) return;

	const cmd = buildInhibitCommand();
	if (!cmd) return;

	try {
		sleepInhibitProc = spawn(cmd);
		log.info("Sleep inhibit started", { backend: detectedBackend, pid: sleepInhibitProc.pid });

		// Clean up reference when the process exits (timeout or kill)
		sleepInhibitProc.exited.then((code) => {
			log.info("Sleep inhibit exited", { backend: detectedBackend, pid: sleepInhibitProc?.pid, code });
			sleepInhibitProc = null;
		}).catch(() => {
			sleepInhibitProc = null;
		});
	} catch (err) {
		log.error("Failed to start sleep inhibit", { backend: detectedBackend, error: String(err) });
		sleepInhibitProc = null;
	}
}

/**
 * Stop the sleep inhibit process if running.
 */
function stopInhibit(): void {
	if (!sleepInhibitProc) return;
	try {
		log.info("Stopping sleep inhibit", { backend: detectedBackend, pid: sleepInhibitProc.pid });
		sleepInhibitProc.kill();
	} catch (err) {
		log.warn("Failed to kill sleep inhibit", { backend: detectedBackend, error: String(err) });
	}
	sleepInhibitProc = null;
}

/**
 * Called from resource-monitor's poll cycle with the number of active
 * agent tmux sessions. Starts or stops sleep inhibition based on whether
 * agents are running and the setting is enabled.
 */
export function updateCaffeinateState(activeSessionCount: number): void {
	const enabled = isPreventSleepEnabled();
	if (enabled && activeSessionCount > 0) {
		startInhibit();
	} else {
		stopInhibit();
	}
}

/**
 * Force-stop sleep inhibition. Called on app shutdown.
 */
export function shutdownCaffeinate(): void {
	stopInhibit();
}

/**
 * Returns whether a sleep inhibit process is currently running.
 * Useful for debugging / status display.
 */
export function isCaffeinateRunning(): boolean {
	return sleepInhibitProc !== null;
}
