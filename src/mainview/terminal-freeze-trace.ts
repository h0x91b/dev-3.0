export type TerminalFreezeTraceEvent = Record<string, string | number | boolean | null>;

export interface TerminalFreezeTrace {
	/** Metadata must describe geometry or counts, never terminal text. */
	arm(metadata: TerminalFreezeTraceEvent): void;
	/** Trace synchronous work; a missing end marks a candidate stalled callback. */
	run<T>(stage: string, fn: () => T, metadata?: TerminalFreezeTraceEvent): T;
}

export function createTerminalFreezeTrace(
	emit: (event: TerminalFreezeTraceEvent) => void,
	options: { now?: () => number; windowMs?: number; maxSpans?: number } = {},
): TerminalFreezeTrace {
	const now = options.now ?? (() => performance.now());
	const windowMs = options.windowMs ?? 10_000;
	const maxSpans = options.maxSpans ?? 2_000;
	const traceId = crypto.randomUUID();
	let capture = 0;
	let spanId = 0;
	let expiresAt = -Infinity;
	let spans = 0;
	let limitReported = false;

	function send(event: TerminalFreezeTraceEvent): void {
		try {
			emit(event);
		} catch {
			// Diagnostic delivery must not change terminal behavior.
		}
	}

	return {
		arm(metadata) {
			const atMs = now();
			capture++;
			expiresAt = atMs + windowMs;
			spans = 0;
			limitReported = false;
			send({ ...metadata, traceId, capture, phase: "arm", atMs, windowMs, maxSpans });
		},
		run<T>(stage: string, fn: () => T, metadata: TerminalFreezeTraceEvent = {}): T {
			const atMs = now();
			if (capture === 0 || atMs >= expiresAt) return fn();
			if (spans >= maxSpans) {
				if (!limitReported) {
					limitReported = true;
					send({ traceId, capture, phase: "limit-reached", atMs, maxSpans });
				}
				return fn();
			}
			spans++;
			const identity = { traceId, capture, spanId: ++spanId, stage };
			send({ ...metadata, ...identity, phase: "begin", atMs });
			let outcome = "ok";
			try {
				return fn();
			} catch (error) {
				outcome = "throw";
				throw error;
			} finally {
				const endedAt = now();
				send({ ...identity, phase: "end", atMs: endedAt, durationMs: endedAt - atMs, outcome });
			}
		},
	};
}
