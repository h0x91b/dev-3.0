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
 *   - renderer `stalled`                               → sent, never came back
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

/**
 * Boundaries, in the order a healthy operation crosses them. `optimistic-rendered` is
 * a UI state the renderer painted BEFORE the request settled (both Dev Server gestures
 * do this), so it is measured from the gesture, never from a settle that has not
 * happened. `stalled` fires from a timer when a request has still not settled.
 */
type Boundary =
	| "gesture"
	| "sent"
	| "stalled"
	| "settled"
	| "rejected"
	| "optimistic-rendered"
	| "rendered";

/** Only the operations a user gesture starts are worth a full trace. */
const GESTURE_OPS: ReadonlySet<DevServerOp> = new Set(["runDevServer", "stopDevServer"]);

/**
 * A poll that has not come back is the incident's own signature, so it must leave
 * evidence — but the poll runs every few seconds for every open task, and tracing its
 * happy path would bury the gestures it exists to explain. A poll therefore reaches
 * the sink only when it stalls past the threshold or rejects. Gestures are rare and
 * always traced.
 */
function shouldEmit(op: DevServerOp, boundary: Boundary): boolean {
	if (op !== "checkDevServer") return true;
	return boundary === "stalled" || boundary === "rejected";
}

/**
 * How long a request may stay unsettled before it is worth a line. Comfortably past a
 * healthy round trip (tens of milliseconds) and past the poll interval, so a normal
 * tick can never trip it.
 */
const STALL_THRESHOLD_MS = 8_000;

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
	/** Drop any armed stall timer — for a caller that is going away (unmount). */
	cancel(): void;
	/** Right before the request object leaves the renderer. Arms the stall timer. */
	sent(): void;
	/** The promise resolved. */
	settled(): void;
	/** The promise rejected. */
	rejected(error: unknown): void;
	/** A UI state painted before the request settled — measured from the gesture. */
	optimisticRendered(state: string): void;
	/** A UI state painted after the request settled — measured from the settle. */
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
	let stallTimer: ReturnType<typeof setTimeout> | null = null;
	const base = { opId, taskId: taskId.slice(0, 8) };

	if (GESTURE_OPS.has(op)) emit("debug", op, "gesture", base);

	function clearStallTimer(): void {
		if (stallTimer === null) return;
		clearTimeout(stallTimer);
		stallTimer = null;
	}

	return {
		opId,
		cancel() {
			clearStallTimer();
		},
		sent() {
			sentAt = performance.now();
			emit("info", op, "sent", { ...base, clickToSendMs: Math.round(sentAt - gestureAt) });
			clearStallTimer();
			const armedAt = sentAt;
			stallTimer = setTimeout(() => {
				stallTimer = null;
				if (settledAt !== null) return;
				// Actual elapsed, not the threshold: a blocked event loop can fire this
				// timer tens of seconds late, and that lateness is the finding.
				emit("warn", op, "stalled", {
					...base,
					unsettledForMs: Math.round(performance.now() - armedAt),
					thresholdMs: STALL_THRESHOLD_MS,
				});
			}, STALL_THRESHOLD_MS);
		},
		settled() {
			settledAt = performance.now();
			clearStallTimer();
			emit("info", op, "settled", {
				...base,
				sendToSettleMs: Math.round(settledAt - (sentAt ?? gestureAt)),
			});
		},
		rejected(error: unknown) {
			settledAt = performance.now();
			clearStallTimer();
			emit("warn", op, "rejected", {
				...base,
				sendToSettleMs: Math.round(settledAt - (sentAt ?? gestureAt)),
				error: String(error instanceof Error ? error.message : error).slice(0, 200),
			});
		},
		optimisticRendered(state: string) {
			emit("debug", op, "optimistic-rendered", {
				...base,
				state,
				gestureToRenderMs: Math.round(performance.now() - gestureAt),
			});
		},
		rendered(state: string) {
			if (settledAt === null) {
				// Refuse to invent a settle-relative number for a paint that happened
				// first; the caller wanted optimisticRendered.
				emit("warn", op, "rendered", { ...base, state, settleToRenderMs: null });
				return;
			}
			emit("debug", op, "rendered", {
				...base,
				state,
				settleToRenderMs: Math.round(performance.now() - settledAt),
			});
		},
	};
}
