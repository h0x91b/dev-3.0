import { archiveOldLogs } from "./log-archive";
import { createLogger } from "./logger";

const log = createLogger("log-archive");

const DAY_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 5 * 60_000;
const INTERVAL_MS = DAY_MS;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let dailyTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function runOnce(): Promise<void> {
	if (running) return;
	running = true;
	try {
		const result = await archiveOldLogs();
		if (result.archived > 0 || result.failed > 0) log.info("Archived old log files", result);
	} catch {
		// Best-effort housekeeping: a failure here must never surface.
	} finally {
		running = false;
	}
}

/** First pass a few minutes after launch, off the startup path, then once a day. */
export function startLogArchiveScheduler(): void {
	if (startupTimer || dailyTimer) return;
	startupTimer = setTimeout(() => {
		startupTimer = null;
		void runOnce();
	}, STARTUP_DELAY_MS);
	dailyTimer = setInterval(() => void runOnce(), INTERVAL_MS);
	startupTimer.unref?.();
	dailyTimer.unref?.();
}

export function stopLogArchiveScheduler(): void {
	if (startupTimer) clearTimeout(startupTimer);
	if (dailyTimer) clearInterval(dailyTimer);
	startupTimer = null;
	dailyTimer = null;
}
