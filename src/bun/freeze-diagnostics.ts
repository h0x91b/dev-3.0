import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { createLogger, getLogPath } from "./logger";
import type { FreezeBeat, FreezeMessage } from "./freeze-diagnostics/protocol";

const log = createLogger("freeze-diagnostics");
let observer: Worker | null = null;
let stopCurrent: (() => void) | null = null;
let assets: { workerPath: string; version: string; build: string } | null = null;

/** Native stack sampling and WebKit process attribution are macOS-only. */
export function freezeDiagnosticsSupported(platform = process.platform): boolean {
	return platform === "darwin";
}

/** Where the collector writes; shown in Settings so the files are findable. */
export function freezeDiagnosticsDirectory(): string {
	return join(getLogPath(), "freeze");
}

export function freezeDiagnosticsRunning(): boolean {
	return observer !== null;
}

export function recordFreezeDiagnostic(message: FreezeMessage): void {
	try { observer?.postMessage(message); } catch { /* diagnostics only */ }
}

/** Keep the diagnostic record an allow-list even when an RPC payload has extra fields. */
export function freezeBeat(beat: FreezeBeat): FreezeBeat {
	const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
	return {
		clientId: String(beat.clientId).slice(0, 32),
		visible: beat.visible === true, hiddenSinceLastBeat: beat.hiddenSinceLastBeat === true,
		sinceLastBeatMs: number(beat.sinceLastBeatMs), terminals: number(beat.terminals), frameErrorPanes: number(beat.frameErrorPanes),
		artifactOpen: beat.artifactOpen === true, artifactIdleMs: beat.artifactIdleMs == null ? null : number(beat.artifactIdleMs),
		focused: beat.focused === true, animationFrameAgeMs: number(beat.animationFrameAgeMs),
		...(beat.viewport ? { viewport: { width: number(beat.viewport.width), height: number(beat.viewport.height), dpr: number(beat.viewport.dpr) } } : {}),
	};
}

/** Remember where the packaged worker lives so a later toggle can start it. */
export function configureFreezeDiagnostics(options: { workerPath: string; version: string; build: string }): void {
	assets = options;
}

/**
 * Start or stop the collector to match the saved setting. Idempotent, so the
 * settings handler can call it on every save without restarting a live worker.
 */
export function applyFreezeDiagnosticsSetting(enabled: boolean, platform = process.platform): void {
	if (!enabled || !freezeDiagnosticsSupported(platform)) {
		stopFreezeDiagnostics();
		return;
	}
	if (observer || !assets) return;
	startCollector(assets);
}

export function stopFreezeDiagnostics(): void {
	stopCurrent?.();
}

function startCollector(options: { workerPath: string; version: string; build: string }): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let worker: Worker | null = null;
	const stop = () => {
		if (timer) clearInterval(timer);
		if (observer === worker) observer = null;
		if (stopCurrent === stop) stopCurrent = null;
		try { worker?.postMessage({ kind: "stop" }); } catch { /* worker already exited */ }
	};
	stopCurrent = stop;
	try {
		if (!existsSync(options.workerPath)) {
			log.warn("Local freeze diagnostics unavailable: worker asset missing");
			stop();
			return;
		}
		worker = new Worker(options.workerPath, { workerData: {
			hostPid: process.pid, directory: freezeDiagnosticsDirectory(), version: options.version, build: options.build,
		} });
		observer = worker;
		worker.unref();
		worker.on("message", () => log.info("Local freeze diagnostics enabled", { hostPid: process.pid, directory: freezeDiagnosticsDirectory() }));
		worker.on("error", () => { log.warn("Local freeze diagnostics worker failed; app continues"); stop(); });
		worker.on("exit", () => stop());
		timer = setInterval(() => recordFreezeDiagnostic({ kind: "host" }), 1_000);
		timer.unref();
	} catch {
		log.warn("Local freeze diagnostics could not start; app continues");
		stop();
	}
}
