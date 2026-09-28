import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { createLogger, getLogPath } from "./logger";
import type { FreezeBeat, FreezeMessage, PtyOutputRequest } from "./freeze-diagnostics/protocol";
import { PTY_OUTPUT_PIN_AFTER_MS, PTY_OUTPUT_RING_CHARS, ptyOutputRecorder } from "./freeze-diagnostics/pty-output";
import { parsePaneSessionKey } from "../shared/pane-session-key";

const log = createLogger("freeze-diagnostics");
let observer: Worker | null = null;
let stopCurrent: (() => void) | null = null;
let assets: { workerPath: string; version: string; build: string } | null = null;
/** Host-clock time of each desktop window's last heartbeat, for pinning the PTY rings. */
const lastBeatAt = new Map<number, number>();
export const PTY_OUTPUT_FILE_MAX_BYTES = 4 * 1024 * 1024;

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

export function recordFreezeDiagnostic(message: FreezeMessage, at = Date.now()): void {
	if (!observer) return;
	if (message.kind === "beat") lastBeatAt.set(message.windowId, at);
	if (message.kind === "window" && message.event === "closed") lastBeatAt.delete(message.windowId);
	try { observer.postMessage(message); } catch { /* diagnostics only */ }
}

/**
 * Pin the PTY rings while any desktop window's heartbeat is stale. A renderer stuck
 * in a terminal write keeps receiving output it never processes; minutes of that
 * would push the bytes it choked on out of a plain ring before anyone notices.
 */
export function pinPtyOutputIfStale(at = Date.now()): void {
	for (const beatAt of lastBeatAt.values()) {
		if (at - beatAt >= PTY_OUTPUT_PIN_AFTER_MS) {
			ptyOutputRecorder.pin(at);
			return;
		}
	}
	ptyOutputRecorder.unpin();
}

/** Write the recent terminal output next to the capture's stack samples. Private and local, like them. */
export function writePtyOutput(
	request: PtyOutputRequest,
	{ directory = freezeDiagnosticsDirectory(), at = Date.now(), maxBytes = PTY_OUTPUT_FILE_MAX_BYTES } = {},
): { ok: boolean; clients: number; bytes: number } {
	// The name comes over the worker channel; never let it pick a path outside the collector's own files.
	if (!/^freeze-\d+-\d+$/.test(request.session) || !Number.isSafeInteger(request.number)) return { ok: false, clients: 0, bytes: 0 };
	try {
		const clients = ptyOutputRecorder.snapshot().map((record) => {
			const key = parsePaneSessionKey(record.sessionKey);
			return {
				taskId: (key?.taskId ?? record.sessionKey).slice(0, 8), paneId: key?.paneId ?? null,
				firstAt: record.firstAt, lastAt: record.lastAt, sentChars: record.sentChars, droppedChars: record.droppedChars,
				chunks: record.chunks, pinned: record.pinned,
			};
		});
		const serialize = () => JSON.stringify({
			event: "pty-output", capturedAt: at, reasons: request.reasons,
			windows: [...lastBeatAt].map(([windowId, beatAt]) => ({ windowId, lastBeatAt: beatAt })),
			limits: { ringChars: PTY_OUTPUT_RING_CHARS, pinAfterMs: PTY_OUTPUT_PIN_AFTER_MS },
			clients,
		});
		let body = serialize();
		while (Buffer.byteLength(body) > maxBytes && clients.length > 0) {
			clients.pop();
			body = serialize();
		}
		writeFileSync(join(directory, `${request.session}.${request.number}-pty.json`), body, { mode: 0o600 });
		return { ok: true, clients: clients.length, bytes: Buffer.byteLength(body) };
	} catch {
		return { ok: false, clients: 0, bytes: 0 };
	}
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
		if (observer === worker) {
			observer = null;
			ptyOutputRecorder.setEnabled(false);
			lastBeatAt.clear();
		}
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
		ptyOutputRecorder.setEnabled(true);
		worker.unref();
		const self = worker;
		self.on("message", (message: { event?: string } | undefined) => {
			if (message?.event === "capture-pty-output") {
				const request = message as PtyOutputRequest;
				const result = writePtyOutput(request);
				try { self.postMessage({ kind: "pty-output", number: request.number, ...result } satisfies FreezeMessage); } catch { /* worker exited */ }
				return;
			}
			if (message?.event === "ready") log.info("Local freeze diagnostics enabled", { hostPid: process.pid, directory: freezeDiagnosticsDirectory() });
		});
		worker.on("error", () => { log.warn("Local freeze diagnostics worker failed; app continues"); stop(); });
		worker.on("exit", () => stop());
		timer = setInterval(() => {
			recordFreezeDiagnostic({ kind: "host" });
			pinPtyOutputIfStale();
		}, 1_000);
		timer.unref();
	} catch {
		log.warn("Local freeze diagnostics could not start; app continues");
		stop();
	}
}
