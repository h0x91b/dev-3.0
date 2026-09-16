import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { createLogger, getLogPath } from "./logger";
import type { FreezeBeat, FreezeMessage } from "./freeze-diagnostics/protocol";

const log = createLogger("freeze-diagnostics");
let observer: Worker | null = null;

export function freezeDiagnosticsEnabled(env: Record<string, string | undefined> = process.env, platform = process.platform): boolean {
	return platform === "darwin" && env.DEV3_DEBUG === "1";
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

export function startFreezeDiagnostics(options: { workerPath: string; version: string; build: string }): () => void {
	if (!freezeDiagnosticsEnabled() || observer) return () => {};
	let timer: ReturnType<typeof setInterval> | undefined;
	let worker: Worker | null = null;
	const stop = () => {
		if (timer) clearInterval(timer);
		if (observer === worker) observer = null;
		try { worker?.postMessage({ kind: "stop" }); } catch { /* worker already exited */ }
	};
	try {
		if (!existsSync(options.workerPath)) {
			log.warn("Local freeze diagnostics unavailable: worker asset missing");
			return stop;
		}
		worker = new Worker(options.workerPath, { workerData: {
			hostPid: process.pid, directory: join(getLogPath(), "freeze"), version: options.version, build: options.build,
		} });
		observer = worker;
		worker.unref();
		worker.on("message", () => log.info("Local freeze diagnostics enabled", { hostPid: process.pid, directory: join(getLogPath(), "freeze") }));
		worker.on("error", () => { log.warn("Local freeze diagnostics worker failed; app continues"); stop(); });
		worker.on("exit", () => stop());
		timer = setInterval(() => recordFreezeDiagnostic({ kind: "host" }), 1_000);
		timer.unref();
	} catch {
		log.warn("Local freeze diagnostics could not start; app continues");
		stop();
	}
	return stop;
}
