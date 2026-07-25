/**
 * Typed failures of the product terminal-backend contract (MIG-002, seq 1280).
 *
 * One error class with a discriminated `code` so callers branch on data instead
 * of instanceof chains across backends, and so a native-only limitation
 * (`unsupported`) is distinguishable from a real breakage. Backend-specific
 * errors (TmuxError, native adapter errors) are wrapped in `backend-failure`
 * with the original on `cause` — they never escape the seam.
 */

import type { TerminalSessionId, TerminalSize, TerminalViewId } from "./contract";
import { TERMINAL_SESSION_ID_RULE } from "./contract";

export type TerminalBackendErrorCode =
	/** The session is absent, already gone, or not owned by this app. */
	| "session-not-found"
	/** `openSession` on an id that already exists — no adoption, no re-spawn. */
	| "session-exists"
	/** The view is not part of the session (or its process already exited). */
	| "view-not-found"
	/** The session id is not portable across backends. */
	| "invalid-session-id"
	/** A resize with non-positive or non-integer geometry. */
	| "invalid-size"
	/** The attachment was released — get a fresh one via `attachView`. */
	| "detached"
	/** The backend cannot serve this product operation (documented, not a bug). */
	| "unsupported"
	/** The backend failed for its own reasons; see `cause`. */
	| "backend-failure";

export class TerminalBackendError extends Error {
	readonly code: TerminalBackendErrorCode;
	readonly sessionId?: TerminalSessionId;
	readonly viewId?: TerminalViewId;

	constructor(
		code: TerminalBackendErrorCode,
		message: string,
		context: { sessionId?: TerminalSessionId; viewId?: TerminalViewId; cause?: unknown } = {},
	) {
		super(message, context.cause === undefined ? undefined : { cause: context.cause });
		this.name = "TerminalBackendError";
		this.code = code;
		this.sessionId = context.sessionId;
		this.viewId = context.viewId;
	}
}

/** True for a contract failure. Name-tagged so a duplicated class still matches. */
export function isTerminalBackendError(err: unknown): err is TerminalBackendError {
	return (
		err instanceof TerminalBackendError || (err as { name?: string })?.name === "TerminalBackendError"
	);
}

export function sessionNotFound(sessionId: TerminalSessionId): TerminalBackendError {
	return new TerminalBackendError(
		"session-not-found",
		`terminal session ${JSON.stringify(sessionId)} is not present`,
		{ sessionId },
	);
}

export function sessionExists(sessionId: TerminalSessionId): TerminalBackendError {
	return new TerminalBackendError(
		"session-exists",
		`terminal session ${JSON.stringify(sessionId)} already exists`,
		{ sessionId },
	);
}

export function viewNotFound(
	sessionId: TerminalSessionId,
	viewId: TerminalViewId,
): TerminalBackendError {
	return new TerminalBackendError(
		"view-not-found",
		`view ${JSON.stringify(viewId)} is not part of session ${JSON.stringify(sessionId)}`,
		{ sessionId, viewId },
	);
}

export function invalidSessionId(sessionId: string): TerminalBackendError {
	return new TerminalBackendError(
		"invalid-session-id",
		`terminal session id ${JSON.stringify(sessionId)} is not portable — allowed: ${TERMINAL_SESSION_ID_RULE}`,
		{ sessionId },
	);
}

export function invalidSize(size: TerminalSize): TerminalBackendError {
	return new TerminalBackendError(
		"invalid-size",
		`invalid terminal size ${size?.cols}x${size?.rows} — cols and rows must be positive integers`,
	);
}

export function attachmentReleased(
	sessionId: TerminalSessionId,
	viewId: TerminalViewId,
): TerminalBackendError {
	return new TerminalBackendError(
		"detached",
		`attachment to view ${JSON.stringify(viewId)} of session ${JSON.stringify(sessionId)} was released`,
		{ sessionId, viewId },
	);
}

export function unsupported(operation: string, reason: string): TerminalBackendError {
	return new TerminalBackendError("unsupported", `${operation} is unsupported: ${reason}`);
}

/** Wrap a backend's own failure so tmux/native error types never escape. */
export function backendFailure(
	operation: string,
	cause: unknown,
	context: { sessionId?: TerminalSessionId; viewId?: TerminalViewId } = {},
): TerminalBackendError {
	const reason = cause instanceof Error ? cause.message : String(cause);
	return new TerminalBackendError("backend-failure", `${operation} failed: ${reason}`, {
		...context,
		cause,
	});
}
