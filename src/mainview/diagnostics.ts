/**
 * In-UI diagnostics store — the renderer's black box.
 *
 * Remote (especially mobile-browser) users have no devtools/console: when the
 * app crashes, hangs on "Loading…", or throws unhandled errors, the only signal
 * today goes to console / GA4 / a backend log file — none of which they can see.
 * This store collects every renderer-side fault (uncaught errors, unhandled
 * rejections, React render crashes, and RPC/WebSocket transport failures) into a
 * small ring buffer that the UI can render so the user can SEE what went wrong,
 * copy it, and report it.
 *
 * Framework-agnostic on purpose (no React import): the {@link RootErrorBoundary}
 * fallback reads it even when the whole React provider tree is unmounted. React
 * bindings live in `hooks/useDiagnostics.ts`.
 */

/** Where a diagnostic originated. */
export type DiagnosticKind = "error" | "rejection" | "react" | "rpc";

/** Severity — drives the error badge (only `error` counts) and colouring. */
export type DiagnosticLevel = "error" | "warn" | "info";

export interface DiagnosticEntry {
	id: number;
	kind: DiagnosticKind;
	level: DiagnosticLevel;
	/** Short, human-readable one-liner (what happened). */
	message: string;
	/** Optional longer detail — stack trace, component stack, extra context. */
	detail?: string;
	/** Optional origin hint — filename, RPC method, or component name. */
	source?: string;
	/** Epoch ms of the most recent occurrence. */
	ts: number;
	/** How many times this identical entry fired back-to-back (deduped). */
	count: number;
}

export type DiagnosticInput = Omit<DiagnosticEntry, "id" | "ts" | "count">;

/** Window event: a surface asks the app to open the full diagnostics panel. */
export const DIAGNOSTICS_OPEN_EVENT = "dev3:openDiagnostics";
/** Window event: the RPC transport's connection state changed. */
export const RPC_STATUS_EVENT = "dev3:rpcStatus";

/** RPC/WebSocket transport connection state, surfaced to the bootstrap screen. */
export type RpcConnectionState =
	| "authenticating"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "closed"
	| "auth-failed";

/** Cap the buffer so a crash-loop can't grow memory without bound. */
const MAX_ENTRIES = 50;

let entries: DiagnosticEntry[] = [];
let counter = 0;
const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) {
		try {
			l();
		} catch {
			/* a broken listener must not wedge the store */
		}
	}
}

/** Timestamp source, isolated so tests can run without a real clock dependency. */
function now(): number {
	return Date.now();
}

/**
 * Record a diagnostic. Consecutive identical entries (same kind/level/message/
 * source) are deduped into a single row with an incremented `count`, so a
 * reconnect loop or a repeated throw doesn't flood the list.
 */
export function recordDiagnostic(input: DiagnosticInput): void {
	const last = entries[entries.length - 1];
	if (
		last &&
		last.kind === input.kind &&
		last.level === input.level &&
		last.message === input.message &&
		last.source === input.source
	) {
		last.count += 1;
		last.ts = now();
		if (input.detail) last.detail = input.detail;
		notify();
		return;
	}
	entries.push({ ...input, id: ++counter, ts: now(), count: 1 });
	if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
	notify();
}

/** Convenience wrapper for an uncaught `window.error` event. */
export function recordError(message: string, detail?: string, source?: string): void {
	recordDiagnostic({ kind: "error", level: "error", message, detail, source });
}

/** Convenience wrapper for an `unhandledrejection`. */
export function recordRejection(message: string, detail?: string, source?: string): void {
	recordDiagnostic({ kind: "rejection", level: "error", message, detail, source });
}

/** Snapshot of all entries, newest last (insertion order). */
export function getDiagnostics(): DiagnosticEntry[] {
	return entries.slice();
}

/** Count of distinct error-level entries — drives the diagnostics badge. */
export function getErrorCount(): number {
	let n = 0;
	for (const e of entries) if (e.level === "error") n += 1;
	return n;
}

/** Drop every recorded entry (user-initiated "Clear"). */
export function clearDiagnostics(): void {
	if (entries.length === 0) return;
	entries = [];
	notify();
}

/** Subscribe to any change; returns an unsubscribe fn. */
export function subscribeDiagnostics(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Serialize the buffer to a plain-text block the user can copy and paste into a
 * bug report. Newest first so the triggering fault is at the top.
 */
export function formatDiagnosticsForCopy(): string {
	if (entries.length === 0) return "No diagnostics captured.";
	return entries
		.slice()
		.reverse()
		.map((e) => {
			const when = new Date(e.ts).toISOString();
			const head = `[${when}] ${e.level.toUpperCase()} ${e.kind}${e.count > 1 ? ` ×${e.count}` : ""}`;
			const src = e.source ? `\n  source: ${e.source}` : "";
			const detail = e.detail ? `\n  ${e.detail.replace(/\n/g, "\n  ")}` : "";
			return `${head}\n  ${e.message}${src}${detail}`;
		})
		.join("\n\n");
}

// ── Test-only reset ──────────────────────────────────────────────────
/** Reset all module state. Intended for unit tests only. */
export function __resetDiagnosticsForTests(): void {
	entries = [];
	counter = 0;
	listeners.clear();
}
