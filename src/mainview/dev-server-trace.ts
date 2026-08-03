/**
 * Dev Server action tracing (seq 1407).
 *
 * A native task froze the whole UI on Stop Dev Server while the backend finished
 * its teardown in 539 ms and kept running for another 49 s. In a later reproduction
 * attempt the Start button flipped to "starting…" and NO handler ran at all, with
 * animation frames perfectly healthy — so the open question is whether a Dev Server
 * click even reaches its handler, and where it dies when it does not.
 *
 * This traces exactly four boundaries per operation — gesture, send, settle, and the
 * local UI state transition — and carries one renderer-minted `opId` into the RPC
 * params, which the matching handler echoes. That makes the decisive distinction
 * readable straight from the log:
 *
 *   - renderer `sent` + backend `→ method` with the same opId  → the request arrived
 *   - renderer `sent` with NO backend line for that opId       → it died in transport
 *   - no renderer line at all                                  → see the caveat below
 *
 * Caveat, and it is load-bearing: this sink is itself an RPC. When the bridge is
 * dead, the trace cannot arrive either. That is not a blind spot so much as a
 * different signal — the last opId present on either side brackets the moment the
 * bridge stopped carrying traffic. The console mirror below is what survives in that
 * case, which is why it is not gated on the sink succeeding.
 *
 * Scoped deliberately to the three Dev Server methods. This is not an RPC
 * interceptor and must not grow into one.
 */

import { api } from "./rpc";

export type DevServerOp = "runDevServer" | "stopDevServer" | "checkDevServer";

/** Boundaries, in the order a healthy operation crosses them. */
type Boundary = "gesture" | "sent" | "settled" | "rejected" | "rendered";

/** Only the operations a user gesture starts are worth a full trace. */
const GESTURE_OPS: ReadonlySet<DevServerOp> = new Set(["runDevServer", "stopDevServer"]);

function mintOpId(): string {
	const random = globalThis.crypto?.randomUUID?.();
	if (random) return random.slice(0, 8);
	return Math.random().toString(16).slice(2, 10);
}

function emit(
	level: "debug" | "info" | "warn",
	op: DevServerOp,
	boundary: Boundary,
	extra: Record<string, string | number | boolean | null>,
): void {
	// The console mirror is what remains when the bridge cannot carry the sink.
	// `debug` keeps it out of the way unless the reader is looking for it.
	const consoleFn = level === "warn" ? console.warn : console.debug;
	consoleFn(`[dev-server] ${op} ${boundary}`, extra);
	try {
		const request = api.request.logRendererEvent({
			level,
			tag: "dev-server",
			message: `${op} ${boundary}`,
			extra,
		});
		// A trace must never be able to break the action it is tracing.
		if (request && typeof (request as Promise<void>).catch === "function") {
			(request as Promise<void>).catch(() => {});
		}
	} catch {
		/* the sink is diagnostics only */
	}
}

export interface DevServerTrace {
	readonly opId: string;
	/** Right before the request object leaves the renderer. */
	sent(): void;
	/** The promise resolved. `settleToRenderMs` is filled in by {@link rendered}. */
	settled(): void;
	/** The promise rejected. */
	rejected(error: unknown): void;
	/** The local UI state actually changed to `state`. */
	rendered(state: string): void;
}

/**
 * Open a trace for one Dev Server operation. Call at the moment the gesture is
 * received, so click-to-send is measured rather than guessed.
 */
export function traceDevServerOp(op: DevServerOp, taskId: string): DevServerTrace {
	const opId = mintOpId();
	const gestureAt = performance.now();
	let sentAt: number | null = null;
	let settledAt: number | null = null;
	const base = { opId, taskId: taskId.slice(0, 8) };

	if (GESTURE_OPS.has(op)) emit("debug", op, "gesture", base);

	return {
		opId,
		sent() {
			sentAt = performance.now();
			emit("info", op, "sent", { ...base, clickToSendMs: Math.round(sentAt - gestureAt) });
		},
		settled() {
			settledAt = performance.now();
			emit("info", op, "settled", {
				...base,
				sendToSettleMs: Math.round(settledAt - (sentAt ?? gestureAt)),
			});
		},
		rejected(error: unknown) {
			settledAt = performance.now();
			emit("warn", op, "rejected", {
				...base,
				sendToSettleMs: Math.round(settledAt - (sentAt ?? gestureAt)),
				error: String(error instanceof Error ? error.message : error).slice(0, 200),
			});
		},
		rendered(state: string) {
			emit("debug", op, "rendered", {
				...base,
				state,
				settleToRenderMs: Math.round(performance.now() - (settledAt ?? gestureAt)),
			});
		},
	};
}
