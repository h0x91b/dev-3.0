/**
 * The product terminal-backend seam (MIG-002, seq 1280; first product caller
 * MIG-004/INT-001, seq 1292).
 *
 * One backend-neutral contract ({@link ./contract}) plus two real adapters:
 * tmux ({@link ./tmux-backend}) and native ({@link ./native-backend}). tmux
 * remains the production default; the seam itself still holds NO selector,
 * feature flag, fallback, or migration — the single product caller allowed to
 * choose is `../task-terminal-backend` (guarded by `__tests__/isolation.test.ts`).
 *
 * Nothing tmux-shaped is exported here on purpose — see `README.md`.
 */

export {
	isTerminalLaunchSpec,
	isTerminalSessionId,
	isTerminalSize,
	terminalLaunchCommand,
	TERMINAL_SESSION_ID_RULE,
	type TerminalAttachment,
	type TerminalBackend,
	type TerminalBackendKind,
	type TerminalLaunchSpec,
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
	isCapturedPane,
	sanitizeCaptureLine,
	TERMINAL_CAPTURE_DEFAULT_HISTORY_LINES,
	TERMINAL_CAPTURE_DEFAULT_MAX_BYTES,
	TERMINAL_CAPTURE_MAX_BYTES,
	TERMINAL_CAPTURE_MAX_HISTORY_LINES,
	TERMINAL_CAPTURE_VERSION,
	type TerminalCaptureFact,
	type TerminalCaptureFreshness,
	type TerminalCaptureIssue,
	type TerminalCaptureIssueCode,
	type TerminalPaneCapture,
	type TerminalPaneCaptureBounds,
	type TerminalPaneCaptureContent,
	type TerminalPaneCaptureGaps,
	type TerminalPaneCaptureIdentity,
	type TerminalPaneCaptureMiss,
	type TerminalPaneCaptureMissReason,
	type TerminalPaneCaptureRequest,
	type TerminalPaneCaptureText,
	type TerminalPaneLiveness,
	type TerminalPaneScreen,
} from "./capture";
export {
	isTerminalBackendError,
	TerminalBackendError,
	type TerminalBackendErrorCode,
} from "./errors";
// The native class plus its option type: which detached host runtime this build
// launches from (packaged staged image vs development path) is a real product
// decision, so the resolver must be able to inject it. The tmux port stays
// private — nothing needs to choose a tmux implementation.
export { NativeTerminalBackend, type NativeTerminalBackendOptions } from "./native-backend";
export { TmuxTerminalBackend } from "./tmux-backend";
