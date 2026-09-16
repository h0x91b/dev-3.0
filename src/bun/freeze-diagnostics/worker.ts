import { parentPort, workerData } from "node:worker_threads";
import { createCaptureStore, createStackCapture } from "./capture";
import { createFreezeMonitor } from "./monitor";
import type { FreezeMessage, FreezeWorkerOptions } from "./protocol";

const options = workerData as FreezeWorkerOptions;
const startedAt = Date.now();
const store = createCaptureStore(options.directory, `freeze-${startedAt}-${options.hostPid}`);
const monitor = createFreezeMonitor(startedAt);
const stacks = createStackCapture(options.hostPid, store.save);
let lastSnapshotAt = startedAt;
let lastDiscoveryAt = startedAt;
let discovering = false;
let capturing = false;
let stopped = false;

function log(value: unknown) {
	try { store.log(value); } catch { /* diagnostics must not affect the app */ }
}
log({ event: "started", at: startedAt, ...options });
parentPort?.postMessage({ event: "ready" });
parentPort?.on("message", (message: FreezeMessage) => {
	if (message.kind === "stop") {
		stopped = true;
		clearInterval(timer);
		clearTimeout(discovery);
		log({ event: "stopped", ...monitor.snapshot(Date.now()) });
		parentPort?.close();
		return;
	}
	monitor.receive(message, Date.now());
});

function discover() {
	if (discovering) return;
	discovering = true;
	void stacks.discover().catch(() => {}).finally(() => { discovering = false; });
}
const discovery = setTimeout(discover, 10_000);
const timer = setInterval(() => {
	if (stopped) return;
	const now = Date.now();
	if (now - lastDiscoveryAt >= 60_000) { lastDiscoveryAt = now; discover(); }
	const outcome = monitor.check(now);
	if (outcome.observerGapMs !== null) log({ event: "observer-gap", gapMs: outcome.observerGapMs, ...monitor.snapshot(now) });
	if (now - lastSnapshotAt >= 30_000) {
		lastSnapshotAt = now;
		log({ event: "snapshot", ...monitor.snapshot(now) });
	}
	if (outcome.capture && !capturing) {
		capturing = true;
		log({ event: "suspected-stall", ...outcome.capture });
		void stacks.capture(outcome.capture.captures).then(
			(results) => log({ event: "samples", at: Date.now(), results }),
			() => log({ event: "capture-failed", at: Date.now() }),
		).finally(() => { capturing = false; });
	}
}, 1_000);
