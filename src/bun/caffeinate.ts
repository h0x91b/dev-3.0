/**
 * Sleep prevention for macOS (`caffeinate`) and Linux (`systemd-inhibit`).
 *
 * While the setting is enabled (or remote access is active) it keeps the
 * platform command running for the whole time the app runs, agents busy or
 * idle. Toggling the setting off kills the process.
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
let detectedBackendPath: string | null = null; // absolute path from `which`
let consecutiveSpawnFailures = 0;

// After this many consecutive failures (a spawn that throws, or an inhibit
// process refused at once), stop retrying for the process lifetime. A broken
// environment otherwise logs an error + forks every 10-second poll, forever.
const MAX_SPAWN_FAILURES = 3;

// An inhibit process that exits non-zero this soon after spawning was refused
// (bad flags, or polkit denying the lock - e.g. WSL, where there is no logind
// seat). It counts toward MAX_SPAWN_FAILURES like a failed spawn does.
const QUICK_EXIT_MS = 5000;

// Safety timeout: the inhibit process exits on its own after this period.
// The 10-second poll cycle restarts it if sessions are still active.
// This prevents the process from running forever if the app crashes
// or the poll loop breaks.
const INHIBIT_TIMEOUT_SECS = 3600; // 1 hour

// The successor is spawned this long before the safety timeout fires, and only
// then is the old process killed. Letting it simply expire leaves a gap until
// the next poll, and an idle machine sleeps in that same second.
const RENEW_BEFORE_EXPIRY_MS = 5 * 60_000;
let renewTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Detect which sleep inhibit backend is available.
 * macOS → caffeinate, Linux → systemd-inhibit.
 * Result is cached for the lifetime of the process.
 */
function detectBackend(): "caffeinate" | "systemd-inhibit" | null {
	if (detectedBackend !== null) return detectedBackend;

	// Try caffeinate first (macOS, always present)
	try {
		const result = spawnSync(["which", "caffeinate"], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode === 0) {
			detectedBackend = "caffeinate";
			detectedBackendPath = new TextDecoder().decode(result.stdout).trim() || null;
			return detectedBackend;
		}
	} catch { /* not found */ }

	// Try systemd-inhibit (Linux with systemd)
	try {
		const result = spawnSync(["which", "systemd-inhibit"], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode === 0) {
			detectedBackend = "systemd-inhibit";
			detectedBackendPath = new TextDecoder().decode(result.stdout).trim() || null;
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
		// Use the absolute path resolved by `which` — spawning the bare name
		// intermittently failed with posix_spawn ENOENT (PATH drift at runtime).
		return [detectedBackendPath ?? "caffeinate", "-s", "-t", String(INHIBIT_TIMEOUT_SECS)];
	}

	// systemd-inhibit wraps a command; we use `sleep` as the payload
	return [
		detectedBackendPath ?? "systemd-inhibit",
		"--what=sleep",
		"--who=dev-3.0",
		"--why=Agents running",
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
		const proc = spawn(cmd);
		const startedAt = performance.now(); // monotonic: a clock step must not hide a refusal
		sleepInhibitProc = proc;
		log.info("Sleep inhibit started", { backend: detectedBackend, pid: proc.pid });
		armRenewal(proc);

		proc.exited.then((code) => {
			log.info("Sleep inhibit exited", { backend: detectedBackend, pid: proc.pid, code });
			// stopInhibit() drops the reference synchronously and this handler runs
			// later, so a process that is no longer current was stopped on purpose.
			const stoppedOnPurpose = sleepInhibitProc !== proc;
			if (!stoppedOnPurpose) sleepInhibitProc = null;
			if (performance.now() - startedAt >= QUICK_EXIT_MS) {
				consecutiveSpawnFailures = 0; // it held the lock, so the backend works
			} else if (!stoppedOnPurpose && code !== 0) {
				recordFailure("Sleep inhibit exited immediately", { code });
			}
		}).catch(() => {
			if (sleepInhibitProc === proc) sleepInhibitProc = null;
		});
	} catch (err) {
		sleepInhibitProc = null;
		recordFailure("Failed to start sleep inhibit", { error: String(err) });
	}
}

function armRenewal(proc: ReturnType<typeof spawn>): void {
	if (renewTimer) clearTimeout(renewTimer);
	renewTimer = setTimeout(() => handOver(proc), INHIBIT_TIMEOUT_SECS * 1000 - RENEW_BEFORE_EXPIRY_MS);
}

/** Replace a still-current inhibit process with a fresh one, overlapping the two. */
function handOver(previous: ReturnType<typeof spawn>): void {
	renewTimer = null;
	if (sleepInhibitProc !== previous) return;
	sleepInhibitProc = null;
	startInhibit();
	if (!sleepInhibitProc) {
		// The successor failed to start: keep the old one until its own timeout.
		sleepInhibitProc = previous;
		return;
	}
	try {
		previous.kill();
	} catch (err) {
		log.warn("Failed to kill the replaced sleep inhibit", { backend: detectedBackend, error: String(err) });
	}
}

function recordFailure(message: string, detail: Record<string, unknown>): void {
	consecutiveSpawnFailures++;
	log.error(message, { backend: detectedBackend, ...detail, attempt: consecutiveSpawnFailures });
	if (consecutiveSpawnFailures >= MAX_SPAWN_FAILURES) {
		inhibitAvailable = false;
		log.error("Sleep inhibit disabled after repeated failures", { backend: detectedBackend });
	}
}

/**
 * Stop the sleep inhibit process if running.
 */
function stopInhibit(): void {
	if (renewTimer) {
		clearTimeout(renewTimer);
		renewTimer = null;
	}
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
 * Called from resource-monitor's poll cycle. Starts or stops sleep
 * inhibition. While the setting is enabled, sleep is inhibited for the whole
 * time the app is running (the recurring poll keeps the inhibit process
 * alive). When remote access is active, inhibition is forced on regardless of
 * the setting, since the machine must stay reachable.
 */
export function updateCaffeinateState(remoteActive: boolean): void {
	const enabled = remoteActive || isPreventSleepEnabled();
	if (enabled) {
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
