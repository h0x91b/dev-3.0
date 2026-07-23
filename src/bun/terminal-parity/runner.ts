/**
 * `ParityRunner` — the TEST-ONLY adapter shape the parity corpus is driven
 * through (MIG-001, seq 1250).
 *
 * This is deliberately NOT the production `TerminalBackend` seam and must never
 * become one: it introduces no backend selection, no persisted identity, and no
 * production import (guarded by `__tests__/isolation.test.ts`). It exists so the
 * one corpus + one set of executable checks ({@link ./checks.ts}) can run
 * against the current tmux backend today ({@link ./tmux-runner.ts}) and against
 * a native runner later, proving parity without a shared production interface.
 *
 * The vocabulary here is backend-neutral: session, view, input, focus, capture.
 * Concrete tmux argv/format strings never appear in this file — only in the
 * tmux runner implementation.
 */

/** A backend-opaque, stable session id (product-level, not a tmux name). */
export type LogicalSessionId = string;
/** A backend-opaque, stable view id (product-level, not a tmux pane id). */
export type LogicalViewId = string;

export interface CreateSessionOptions {
	/** Caller-chosen stable session id. */
	id: LogicalSessionId;
	/** Working directory the session's first process starts in. */
	cwd: string;
	/** Environment variables that must be visible to the session's process. */
	env?: Record<string, string>;
	/** Command to run in the first view (a shell if omitted). */
	command?: string;
}

export interface SplitViewOptions {
	/** Working directory for the new view's process. */
	cwd: string;
	env?: Record<string, string>;
	command?: string;
}

export interface ViewInfo {
	readonly id: LogicalViewId;
	readonly active: boolean;
}

export interface CaptureOptions {
	/**
	 * Include scrollback so a large burst can be verified in full, not just the
	 * visible screen. Backends without scrollback return what they can.
	 */
	includeHistory?: boolean;
}

export interface CleanupOptions {
	/** Swallow "already gone" as success instead of raising. */
	bestEffort?: boolean;
}

/**
 * The backend-neutral operations the corpus needs. Every method is expressed in
 * product terms; a runner maps them onto its backend. Reads that target a
 * missing session/view surface a catchable error or an empty result (never an
 * uncaught crash) so the negative scenarios can assert clean handling.
 */
export interface ParityRunner {
	/** Human-readable backend name for test output, e.g. "tmux". */
	readonly backend: string;

	createSession(opts: CreateSessionOptions): Promise<SessionHandle>;
	isSessionPresent(id: LogicalSessionId): Promise<boolean>;
	listViews(id: LogicalSessionId): Promise<ViewInfo[]>;
	activeViewId(id: LogicalSessionId): Promise<LogicalViewId | null>;

	splitView(id: LogicalSessionId, from: LogicalViewId, opts: SplitViewOptions): Promise<ViewInfo>;
	focusView(id: LogicalSessionId, view: LogicalViewId): Promise<void>;

	sendInput(id: LogicalSessionId, view: LogicalViewId, text: string): Promise<void>;
	capture(id: LogicalSessionId, view: LogicalViewId, opts?: CaptureOptions): Promise<string>;

	killView(id: LogicalSessionId, view: LogicalViewId, opts?: CleanupOptions): Promise<void>;
	cleanupSession(id: LogicalSessionId, opts?: CleanupOptions): Promise<void>;

	/** Release any test resources (throwaway backend server, temp dirs). */
	dispose(): Promise<void>;
}

export interface SessionHandle {
	readonly id: LogicalSessionId;
	/** The stable id of the session's initial view. */
	readonly firstViewId: LogicalViewId;
}

/**
 * A fresh controller reconnecting to an already-running session. Separate from
 * the runner that created it so the reconnect scenario models a NEW process
 * rediscovering state from the backend, not the original owner's in-memory
 * handle.
 */
export interface ReconnectFactory {
	/** Build a fresh runner bound to the same backend endpoint/socket. */
	reconnect(): ParityRunner;
}
