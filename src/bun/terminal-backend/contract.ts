/**
 * The product terminal-backend contract (MIG-002, seq 1280).
 *
 * ONE backend-neutral vocabulary for everything dev3 needs from a terminal
 * backend: session/view lifecycle, attach/reconnect, input, resize,
 * capture, focus, split, close, cleanup, and typed failures ({@link ./errors}).
 * It is derived from the frozen parity corpus (`../terminal-parity/corpus.ts`)
 * and the product's own needs — deliberately NOT a promotion of the test-only
 * `ParityRunner`, which has no attach/resize and no error taxonomy.
 *
 * Hard boundaries of this seam:
 *  - No backend selection, capability negotiation, versioning, or auth. A caller
 *    holds ONE backend instance; unsupported product operations surface as a
 *    typed `unsupported` failure, never as a probe-before-call flag.
 *  - Ids are opaque product strings. tmux session names / `%pane` ids and native
 *    registry ids never leak through here (see each adapter).
 *  - Streaming output stays ABOVE this seam (the PTY/host layer owns bytes);
 *    the contract exposes point-in-time {@link TerminalCapture} snapshots.
 */

/** Which backend implementation a handle talks to — for logs and diagnostics. */
export type TerminalBackendKind = "tmux" | "native";

/** Caller-chosen stable session id (opaque to the backend). */
export type TerminalSessionId = string;
/** Backend-assigned stable view id, opaque to the product. */
export type TerminalViewId = string;

/**
 * Session ids must be safe for BOTH backends: a tmux session name (no `:` / `.`)
 * and a single native registry directory segment. One rule at the seam so a
 * session id never becomes portable-in-theory-only.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isTerminalSessionId(id: string): boolean {
	return typeof id === "string" && SESSION_ID_PATTERN.test(id);
}

/** The rule text, for error messages and docs. */
export const TERMINAL_SESSION_ID_RULE = SESSION_ID_PATTERN.source;

export interface TerminalSize {
	readonly cols: number;
	readonly rows: number;
}

export function isTerminalSize(size: TerminalSize): boolean {
	return (
		Number.isInteger(size?.cols) &&
		Number.isInteger(size?.rows) &&
		size.cols > 0 &&
		size.rows > 0
	);
}

/**
 * A structured process launch: one executable plus its exact argv, with nothing
 * re-parsing the arguments between the product and the process. It exists
 * because the native backend spawns a process directly — a single command
 * string would have to be split by guesswork — while tmux runs its command
 * through a shell. A caller whose arguments must survive verbatim (a login
 * shell running a wrapper script whose path may contain spaces) passes `launch`;
 * `command` stays the simpler form for a plain shell-ready string. When both are
 * given, `launch` wins, and every backend must honour it losslessly.
 */
export interface TerminalLaunchSpec {
	readonly executable: string;
	readonly argv: readonly string[];
}

export function isTerminalLaunchSpec(launch: TerminalLaunchSpec): boolean {
	return (
		typeof launch?.executable === "string" &&
		launch.executable.trim().length > 0 &&
		Array.isArray(launch.argv) &&
		launch.argv.every((arg) => typeof arg === "string")
	);
}

function posixQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Flatten a structured launch into the single shell-ready command string the
 * tmux backend needs. tmux is POSIX-only here, so POSIX quoting is exact.
 */
export function terminalLaunchCommand(launch: TerminalLaunchSpec): string {
	return [launch.executable, ...launch.argv].map(posixQuote).join(" ");
}

export interface TerminalSessionSpec {
	readonly id: TerminalSessionId;
	/** Working directory of the session's first process. */
	readonly cwd: string;
	/** Environment that must be visible to the session's processes. */
	readonly env?: Readonly<Record<string, string>>;
	/** Command for the first view; the user's login shell when omitted. */
	readonly command?: string;
	/** Structured launch for the first view; takes precedence over `command`. */
	readonly launch?: TerminalLaunchSpec;
	/** Initial geometry; the backend's default when omitted. */
	readonly size?: TerminalSize;
}

/** A view added to an existing session (split). */
export interface TerminalViewSpec {
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly command?: string;
	/** Structured launch for the new view; takes precedence over `command`. */
	readonly launch?: TerminalLaunchSpec;
}

export interface TerminalViewState {
	readonly id: TerminalViewId;
	/** Exactly one view of a live session is focused. */
	readonly focused: boolean;
}

export interface TerminalSessionState {
	readonly id: TerminalSessionId;
	readonly views: readonly TerminalViewState[];
	readonly focusedViewId: TerminalViewId | null;
}

export interface TerminalCaptureOptions {
	/** Include scrollback, not just the visible screen (bounded per backend). */
	readonly includeScrollback?: boolean;
}

export interface TerminalCapture {
	readonly viewId: TerminalViewId;
	readonly text: string;
}

export interface TerminalTeardownOptions {
	/** Treat "already gone" as success — makes cleanup retries idempotent. */
	readonly ignoreMissing?: boolean;
}

/**
 * A live binding to one view: the product's write/resize/read channel. Obtained
 * from {@link TerminalBackend.attachView}, including from a FRESH backend
 * instance reconnecting to a session it did not create (same ids, no adoption
 * handshake, no second spawn).
 */
export interface TerminalAttachment {
	readonly sessionId: TerminalSessionId;
	readonly viewId: TerminalViewId;
	/** Deliver input verbatim — the caller includes any CR/newline it wants. */
	write(data: string): Promise<void>;
	resize(size: TerminalSize): Promise<void>;
	capture(opts?: TerminalCaptureOptions): Promise<TerminalCapture>;
	/** Release this binding. Idempotent; never tears the session down. */
	detach(): Promise<void>;
}

/**
 * What the product may ask of a terminal backend. Every failure is a typed
 * {@link ../errors.TerminalBackendError}; reads of a missing session return
 * `null` rather than throwing so presence checks stay branch-free.
 */
export interface TerminalBackend {
	readonly kind: TerminalBackendKind;

	/** Create a NEW session. An existing id fails (`session-exists`) — the seam
	 *  never adopts, re-attaches, or double-spawns. */
	openSession(spec: TerminalSessionSpec): Promise<TerminalSessionState>;

	/** Current state, or `null` when the session is absent or not ours. */
	describeSession(id: TerminalSessionId): Promise<TerminalSessionState | null>;

	/** Bind to a view (the focused one when `viewId` is omitted). */
	attachView(id: TerminalSessionId, viewId?: TerminalViewId): Promise<TerminalAttachment>;

	focusView(id: TerminalSessionId, viewId: TerminalViewId): Promise<void>;

	splitView(
		id: TerminalSessionId,
		from: TerminalViewId,
		spec: TerminalViewSpec,
	): Promise<TerminalViewState>;

	closeView(
		id: TerminalSessionId,
		viewId: TerminalViewId,
		opts?: TerminalTeardownOptions,
	): Promise<void>;

	/** Tear the session and everything it owns down. Idempotent with
	 *  `ignoreMissing`; never touches sessions this backend does not own. */
	cleanupSession(id: TerminalSessionId, opts?: TerminalTeardownOptions): Promise<void>;

	/** Release this handle's own resources (attachments, clients). Sessions are
	 *  persistent and always survive — only `cleanupSession` tears them down. */
	dispose(): Promise<void>;
}
