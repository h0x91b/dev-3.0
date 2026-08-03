/**
 * Dev Server action tracing (seq 1407).
 *
 * Tells apart two failures that look identical after the fact: a Dev Server click
 * whose request never reached its handler, and one whose handler ran and hung.
 *
 * Four boundaries per operation — gesture, send, settle, local UI state transition —
 * each carrying one renderer-minted `opId` that the matching handler echoes:
 *
 *   - renderer `sent` + backend `→ method`, same opId  → the request arrived
 *   - renderer `sent`, no backend line for that opId   → it died in transport
 *   - no renderer line at all                          → see the caveat
 *
 * Load-bearing caveat: the sink is itself an RPC, so a dead bridge stops these traces
 * too. Nothing here can PROVE bridge death — it can only bracket it by the last opId
 * seen on either side. The console mirror is what survives that case, which is why it
 * is not gated on the sink succeeding. See decision 199.
 *
 * Scoped to the three Dev Server methods on purpose. Not an RPC interceptor.
 */

import { api } from "./rpc";

export type DevServerOp = "runDevServer" | "stopDevServer" | "checkDevServer";

/** Boundaries, in the order a healthy operation crosses them. */
type Boundary = "gesture" | "sent" | "settled" | "rejected" | "rendered";

/** Only the operations a user gesture starts are worth a full trace. */
const GESTURE_OPS: ReadonlySet<DevServerOp> = new Set(["runDevServer", "stopDevServer"]);

/**
 * The state poll runs every few seconds for every open task, so tracing its happy
 * path would bury the gestures it is meant to explain. A poll is only interesting
 * when it FAILS or never settles, so only those reach the sink; a healthy poll is
 * silent. Gestures are rare and always traced.
 */
function shouldEmit(op: DevServerOp, boundary: Boundary): boolean {
	if (op !== "checkDevServer") return true;
	return boundary === "rejected";
}

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
	if (!shouldEmit(op, boundary)) return;
	const consoleFn = level === "warn" ? console.warn : console.debug;
	consoleFn(`[dev-server] ${op} ${boundary}`, extra);
	try {
		const request = api.request.logRendererDiagnostic({
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
