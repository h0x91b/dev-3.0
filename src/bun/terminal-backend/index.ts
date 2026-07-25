/**
 * The product terminal-backend seam (MIG-002, seq 1280).
 *
 * One backend-neutral contract ({@link ./contract}) plus two real adapters:
 * tmux ({@link ./tmux-backend}) and native ({@link ./native-backend}). tmux
 * remains the production backend; this module adds NO selector, feature flag,
 * fallback, migration, or persisted backend identity and has no product callers
 * yet (guarded by `__tests__/isolation.test.ts`).
 *
 * Nothing tmux-shaped is exported here on purpose — see `README.md`.
 */

export {
	isTerminalSessionId,
	isTerminalSize,
	TERMINAL_SESSION_ID_RULE,
	type TerminalAttachment,
	type TerminalBackend,
	type TerminalBackendKind,
	type TerminalCapture,
	type TerminalCaptureOptions,
	type TerminalSessionId,
	type TerminalSessionSpec,
	type TerminalSessionState,
	type TerminalSize,
	type TerminalTeardownOptions,
	type TerminalViewId,
	type TerminalViewSpec,
	type TerminalViewState,
} from "./contract";
export {
	isTerminalBackendError,
	TerminalBackendError,
	type TerminalBackendErrorCode,
} from "./errors";
// Only the classes: their option types carry backend-internal seams (tmux port,
// native deps) that exist for tests and must not become part of the seam.
export { NativeTerminalBackend } from "./native-backend";
export { TmuxTerminalBackend } from "./tmux-backend";
