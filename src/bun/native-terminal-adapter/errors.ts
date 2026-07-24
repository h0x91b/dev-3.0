/**
 * Typed, catchable errors for the native single-view terminal adapter (MIG-002
 * tracer, seq 1254).
 *
 * The parity corpus's negative scenarios require that reading or operating on a
 * missing session or an already-dead view surfaces a typed, catchable result —
 * never an uncaught crash (`attach.missing-session-is-clean`,
 * `cleanup.retry-is-idempotent`). A single discriminated `code` lets callers
 * branch without instanceof chains and keeps the contract explicit.
 */

export type NativeAdapterErrorCode =
	| "session-not-found"
	| "view-gone"
	| "multi-view-unsupported";

export class NativeAdapterError extends Error {
	constructor(
		readonly code: NativeAdapterErrorCode,
		message: string,
	) {
		super(message);
		this.name = new.target.name;
	}
}

/** A read/teardown targeted a session that is not present (or no longer ours). */
export class NativeSessionNotFoundError extends NativeAdapterError {
	constructor(readonly sessionId: string) {
		super("session-not-found", `native session ${JSON.stringify(sessionId)} is not present`);
	}
}

/** An operation targeted a view whose process has already exited. */
export class NativeViewGoneError extends NativeAdapterError {
	constructor(
		readonly sessionId: string,
		readonly viewId: string,
	) {
		super("view-gone", `native view ${JSON.stringify(viewId)} of session ${JSON.stringify(sessionId)} is gone`);
	}
}

/**
 * A multi-view operation (split/second-view focus) was requested on the
 * single-view tracer. Multi-view layout is deferred to LAY-003/LAY-004; this is
 * a deliberate, documented boundary, not a runtime failure of the single view.
 */
export class MultiViewUnsupportedError extends NativeAdapterError {
	constructor(readonly operation: string) {
		super(
			"multi-view-unsupported",
			`native single-view adapter does not support ${operation}; multi-view is deferred to LAY-003/LAY-004`,
		);
	}
}
