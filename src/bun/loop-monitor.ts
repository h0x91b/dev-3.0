import { createLogger } from "./logger";

const log = createLogger("loop");

// We tick every TICK_MS and measure how much extra wall-clock elapsed
// before the timer actually fired. If the extra delay exceeds STALL_MS,
// something blocked the Bun event loop for that long. Only those stalls
// produce a log line — quiet during normal operation, loud when it matters.
const TICK_MS = 250;
const STALL_MS = 500;

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function startLoopMonitor(): void {
	if (started) return;
	started = true;
	let last = Date.now();
	timer = setInterval(() => {
		const now = Date.now();
		const drift = now - last - TICK_MS;
		last = now;
		if (drift >= STALL_MS) {
			log.warn("Event loop stall detected", { stallMs: drift, tickMs: TICK_MS });
		}
	}, TICK_MS);
}

export function _stopLoopMonitorForTests(): void {
	if (timer) clearInterval(timer);
	timer = null;
	started = false;
}
