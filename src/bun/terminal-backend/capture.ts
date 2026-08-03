/**
 * Read-only pane capture: the backend-neutral replacement for `capture-pane`
 * (CAP-001, seq 1412).
 *
 * ONE bounded textual view of ONE explicitly named pane. Capturing is a pure
 * read: it never focuses a task, injects input, resizes a PTY, moves writer
 * ownership, or waits for the pane's agent to cooperate. Both backends satisfy
 * it from state they already keep — tmux by asking the server for the pane's
 * rows, native by reading the host's bounded parser snapshot off disk.
 *
 * Four properties are load-bearing, and every field below serves one of them:
 *
 *  1. **Honest availability.** A missing session, a missing pane, a pane whose
 *     backend publishes nothing to capture, a pane with nothing observed yet,
 *     unreadable state, and a pane replaced mid-read are six different answers.
 *     None of them is an empty string, because "the screen is blank" and "we
 *     did not look" lead to opposite decisions. A pane that really shows nothing
 *     is a SUCCESSFUL capture with empty text.
 *  2. **Stable identity.** Every capture carries an opaque pane incarnation and
 *     the session's opaque epoch, both checked before AND after the read. A pane
 *     replaced underneath the read is reported, never silently returned as the
 *     same pane.
 *  3. **Honest bounds.** Hard ceilings, and everything the ceilings cut is
 *     counted. Loss order is fixed: oldest history first, viewport last and
 *     never without saying so. Cuts land on whole lines, so no line and no
 *     code point is ever split.
 *  4. **A deliberate content boundary.** Plain text only, history off by
 *     default, no escape sequences, no process facts.
 *
 * Deliberately absent: colours and escape sequences (see {@link sanitizeCaptureLine}),
 * rate or progress (one capture is one point in time; a caller diffs two of them),
 * subscriptions, and every process fact — pid, cwd, command, environment. Those
 * belong to `native-terminal-diagnostics`, a separate contract on purpose; this
 * module also defines its own fact and issue vocabulary rather than borrowing
 * that module's, so the two can evolve without dragging each other along.
 */

import { createHash } from "node:crypto";
import type { TerminalBackendKind, TerminalSessionId, TerminalSize, TerminalViewId } from "./contract";

export const TERMINAL_CAPTURE_VERSION = 1 as const;

/**
 * Something the backends do not answer equally. `known: false` carries the
 * reason, so a backend that genuinely cannot know (tmux keeps no account of
 * output it dropped) says so instead of returning a zero that reads as "none".
 */
export type TerminalCaptureFact<T> =
	| { readonly known: true; readonly value: T }
	| { readonly known: false; readonly reason: string };

export function knownFact<T>(value: T): TerminalCaptureFact<T> {
	return { known: true, value };
}

export function unknownFact<T>(reason: string): TerminalCaptureFact<T> {
	return { known: false, reason };
}

/**
 * What is wrong with an otherwise successful capture. Content plus an empty
 * `issues` list means "this is the whole recent picture"; anything in the list
 * means the caller is looking at less than the truth, and at what kind of less.
 */
export type TerminalCaptureIssueCode =
	/** Older history existed and was left out. */
	| "history-truncated"
	/** The viewport itself did not fit the byte budget and its top rows were cut. */
	| "viewport-truncated"
	/** The producer lost output before this capture — there is a hole in it. */
	| "sequence-gap"
	/** The producer of the text is degraded, so the screen may be behind reality. */
	| "parser-failed"
	/** Something this backend cannot determine at all; the detail says what. */
	| "unknown";

export interface TerminalCaptureIssue {
	readonly code: TerminalCaptureIssueCode;
	readonly detail: string;
}

/** Seam ceilings, common to both backends. A caller may ask for less, never more. */
export const TERMINAL_CAPTURE_MAX_HISTORY_LINES = 2000;
export const TERMINAL_CAPTURE_MAX_BYTES = 256 * 1024;
/** Defaults: the visible screen only, in a budget a coordination glance fits. */
export const TERMINAL_CAPTURE_DEFAULT_HISTORY_LINES = 0;
export const TERMINAL_CAPTURE_DEFAULT_MAX_BYTES = 64 * 1024;
/**
 * Whether the read can vouch that what it returned is what the pane shows now.
 *
 * `current` is only claimable by a backend that reads the pane itself. A backend
 * that reads what a producer wrote ON CHANGE cannot claim it: a quiet pane and a
 * wedged producer are indistinguishable without a heartbeat, so freshness there
 * is `unknown` — not `lagging`, and emphatically not derived from age. That
 * distinction is why there is no age threshold in this file.
 */
export type TerminalCaptureFreshness = "current";

export interface TerminalPaneCaptureRequest {
	/**
	 * Lines that scrolled off the screen to include BEFORE the viewport, the
	 * newest of them adjacent to it. `0` (the default) is the visible screen only.
	 * Clamped to {@link TERMINAL_CAPTURE_MAX_HISTORY_LINES}.
	 */
	readonly historyLines?: number;
	/** UTF-8 byte ceiling. Clamped to {@link TERMINAL_CAPTURE_MAX_BYTES}. */
	readonly maxBytes?: number;
}

/**
 * Which pane, and which incarnation of it.
 *
 * `incarnation` and `epoch` are OPAQUE by construction — digests, not pids or
 * paths, so identity carries no process fact. `incarnation` changes when the
 * pane's own processes are replaced; `epoch` changes when the session's pane set
 * or layout is republished. Two captures whose incarnation or epoch differ
 * describe different things and must not be compared or diffed: without that a
 * replacement pane passes for the one that was there a minute ago.
 */
export interface TerminalPaneCaptureIdentity {
	readonly backend: TerminalBackendKind;
	readonly sessionId: TerminalSessionId;
	readonly viewId: TerminalViewId;
	readonly incarnation: TerminalCaptureFact<string>;
	readonly epoch: TerminalCaptureFact<string>;
}

/** Opaque, stable, and short. Inputs are never recoverable from the digest. */
export function captureIncarnation(...parts: readonly (string | number)[]): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

export type TerminalPaneLiveness = "live" | "dead" | "unknown";

/** Which buffer the pane shows. History means nothing on the alternate one. */
export type TerminalPaneScreen = "normal" | "alternate";

export interface TerminalPaneCaptureText {
	/**
	 * PHYSICAL terminal rows, top row first — never joined. A logically wrapped
	 * line of 200 characters in an 80-column pane is three entries here, not one.
	 * Nothing in this contract reflows or unwraps; a caller that wants logical
	 * lines must join them itself, and cannot, in general, tell where to.
	 *
	 * Trailing blank rows are omitted: they are the pane's padding, not output.
	 */
	readonly viewport: readonly string[];
	/** Physical rows that scrolled off, oldest first, ending just above `viewport[0]`. */
	readonly history: readonly string[];
	/** Stated in the data so a consumer cannot assume logical lines. */
	readonly lineModel: "physical-rows";
}

export interface TerminalPaneCaptureBounds {
	readonly historyLinesRequested: number;
	readonly historyLinesReturned: number;
	/** History the backend holds in total, when it can say. */
	readonly historyLinesAvailable: TerminalCaptureFact<number>;
	/** History that existed and was left out, by either budget. */
	readonly historyLinesOmitted: TerminalCaptureFact<number>;
	readonly viewportRowsReturned: number;
	/** Top viewport rows cut because the viewport alone exceeded the byte budget. */
	readonly viewportRowsOmitted: number;
	/** UTF-8 bytes of the returned text, separators included. */
	readonly bytesReturned: number;
	readonly bytesLimit: number;
}

/** Output a backend KNOWS it lost before this capture. */
export interface TerminalPaneCaptureGaps {
	readonly droppedBytes: number;
	readonly droppedChunks: number;
	/** Sequence gaps the backend had to resync across. */
	readonly resyncGaps: number;
	/** The producer of this content is degraded, so it may be incomplete. */
	readonly degraded: boolean;
}

/** Why a capture carries no content. Never overloaded onto an empty screen. */
export type TerminalPaneCaptureMissReason =
	/** No such session, or it is not owned by this app. */
	| "session-absent"
	/** The session is here; this pane is not part of it. */
	| "view-absent"
	/** This pane's backend publishes nothing to capture — configuration, not failure. */
	| "not-enabled"
	/** Capturable in principle; nothing observed yet (host still booting). */
	| "unavailable"
	/** State exists but could not be believed — corrupt, partial, rejected version. */
	| "unreadable"
	/** The pane or its session changed identity between the two identity checks. */
	| "replaced";

interface TerminalPaneCaptureBase {
	readonly version: typeof TERMINAL_CAPTURE_VERSION;
	readonly identity: TerminalPaneCaptureIdentity;
	/** When THIS call read the backend. */
	readonly readAt: string;
}

export interface TerminalPaneCaptureContent extends TerminalPaneCaptureBase {
	readonly availability: "captured";
	/**
	 * When the source of this text was last updated. tmux answers synchronously,
	 * so it equals `readAt`; native reads a snapshot the host persists on a
	 * cadence, so it legitimately lags (~1s worst case, decision 169). Separate
	 * from `readAt` on purpose — conflating them makes every capture look fresh.
	 */
	readonly sourceUpdatedAt: TerminalCaptureFact<string>;
	/**
	 * How long ago the content last CHANGED — plain data, no verdict attached. A
	 * big number means the pane has been quiet that long, which is usually the
	 * most useful thing a coordinator can learn from one read. It is NOT staleness:
	 * a quiet healthy pane is current.
	 */
	readonly lastChangeAgeMs: TerminalCaptureFact<number>;
	/**
	 * Whether this read can vouch the content is current. `unknown` is a real and
	 * common answer — it means the producer offers no heartbeat, so freshness
	 * cannot be established either way.
	 */
	readonly freshness: TerminalCaptureFact<TerminalCaptureFreshness>;
	/** `dead` WITH content is a real answer: the pane's final screen. */
	readonly liveness: TerminalPaneLiveness;
	readonly size: TerminalCaptureFact<TerminalSize>;
	readonly screen: TerminalCaptureFact<TerminalPaneScreen>;
	/** Empty arrays are a successful capture of a pane that shows nothing. */
	readonly content: TerminalPaneCaptureText;
	readonly bounds: TerminalPaneCaptureBounds;
	readonly gaps: TerminalCaptureFact<TerminalPaneCaptureGaps>;
	/** Empty means "this is the whole recent picture". */
	readonly issues: readonly TerminalCaptureIssue[];
}

export interface TerminalPaneCaptureMiss extends TerminalPaneCaptureBase {
	readonly availability: TerminalPaneCaptureMissReason;
	/** Why, in one sentence, so a log line needs no second call. */
	readonly reason: string;
	readonly liveness: TerminalPaneLiveness;
}

/**
 * Identity and `readAt` are on EVERY outcome, so a miss can be logged without
 * asking again. Only `"captured"` carries content, so reading text off a miss
 * does not type-check.
 */
export type TerminalPaneCapture = TerminalPaneCaptureContent | TerminalPaneCaptureMiss;

export function isCapturedPane(capture: TerminalPaneCapture): capture is TerminalPaneCaptureContent {
	return capture.availability === "captured";
}

// ── Pure shaping, shared by both adapters so their answers cannot drift ──

/**
 * Escape sequences and control bytes, stripped before any text leaves the seam.
 *
 * This is the content boundary, not cosmetics: it is what keeps OSC 52 clipboard
 * payloads, OSC 8 hyperlink targets, and title strings out of a capture. Both
 * backends deliver column-expanded rows, so no tab or carriage return should
 * survive to be stripped here.
 */
const ESCAPE_SEQUENCES = new RegExp(
	[
		// 7-bit forms: ESC ] / P / ^ / _ / X, terminated by BEL or ST.
		"\\u001B\\][^\\u0007\\u001B\\u009C]*(?:\\u0007|\\u001B\\\\|\\u009C)?",
		"\\u001B[P^_X][^\\u001B\\u009C]*(?:\\u001B\\\\|\\u009C)?",
		"\\u001B\\[[0-?]*[ -/]*[@-~]",
		"\\u001B[ -/]*[0-~]",
		// 8-bit C1 forms of the same sequences. Stripping the introducer alone leaves
		// the BODY as visible text — which is how an OSC 52 clipboard payload survives
		// a naive sanitizer.
		"\\u009D[^\\u0007\\u009C\\u001B]*(?:\\u0007|\\u009C|\\u001B\\\\)?",
		"[\\u0090\\u0098\\u009E\\u009F][^\\u0007\\u009C\\u001B]*(?:\\u0007|\\u009C|\\u001B\\\\)?",
		"\\u009B[0-?]*[ -/]*[@-~]",
	].join("|"),
	"g",
);
/** C0 (tab and CR included), DEL, and C1 — nothing control-shaped survives. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

export function sanitizeCaptureLine(line: string): string {
	return line.replace(ESCAPE_SEQUENCES, "").replace(CONTROL_CHARACTERS, "").trimEnd();
}

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
	return encoder.encode(value).length;
}

function trimTrailingBlankRows(rows: readonly string[]): string[] {
	let end = rows.length;
	while (end > 0 && rows[end - 1]!.trim() === "") end--;
	return rows.slice(0, end);
}

export function clampHistoryLines(requested: number | undefined): number {
	const value = Number.isInteger(requested)
		? (requested as number)
		: TERMINAL_CAPTURE_DEFAULT_HISTORY_LINES;
	return Math.min(Math.max(value, 0), TERMINAL_CAPTURE_MAX_HISTORY_LINES);
}

export function clampMaxBytes(requested: number | undefined): number {
	const value = Number.isInteger(requested) ? (requested as number) : TERMINAL_CAPTURE_DEFAULT_MAX_BYTES;
	return Math.min(Math.max(value, 0), TERMINAL_CAPTURE_MAX_BYTES);
}

export interface RawCaptureLines {
	readonly viewport: readonly string[];
	/** Every history row the backend produced, oldest first. */
	readonly history: readonly string[];
	/** History rows the backend holds in total, when it can say. */
	readonly historyAvailable?: number;
}

export interface BoundedCapture {
	readonly content: TerminalPaneCaptureText;
	readonly bounds: TerminalPaneCaptureBounds;
	readonly issues: readonly TerminalCaptureIssue[];
}

/**
 * Sanitize, then fit the budget in ONE pass per list, newest row first, so a huge
 * screen costs a linear walk rather than a slice-and-re-encode per row.
 *
 * The order of loss is fixed: history beyond `historyLines` goes first from its
 * oldest end, then history that does not fit the bytes, and only then the
 * viewport's TOP rows — always with a `viewport-truncated` issue. Every cut lands
 * on a whole physical row, so neither a row nor a code point is ever split, and
 * budgets are UTF-8 bytes. Trailing blank rows are dropped once, here, for every
 * backend and producer surface, so none of them can disagree about the same pane.
 */
export function boundCaptureLines(
	raw: RawCaptureLines,
	request: { readonly historyLines: number; readonly maxBytes: number },
): BoundedCapture {
	const viewportAll = trimTrailingBlankRows(raw.viewport.map(sanitizeCaptureLine));
	const historyAll = raw.history.map(sanitizeCaptureLine);
	const available = raw.historyAvailable;

	// The viewport is the LAST thing cut, so it claims the budget first.
	let used = 0;
	let viewportKept = 0;
	for (let i = viewportAll.length - 1; i >= 0; i--) {
		const cost = utf8Bytes(viewportAll[i]!) + (used > 0 ? 1 : 0);
		if (used + cost > request.maxBytes) break;
		used += cost;
		viewportKept++;
	}
	const viewport = viewportAll.slice(viewportAll.length - viewportKept);
	const viewportRowsOmitted = viewportAll.length - viewportKept;

	const requestedRows = Math.min(request.historyLines, historyAll.length);
	let historyKept = 0;
	for (let i = historyAll.length - 1; i > historyAll.length - 1 - requestedRows; i--) {
		const cost = utf8Bytes(historyAll[i]!) + (used > 0 ? 1 : 0);
		if (used + cost > request.maxBytes) break;
		used += cost;
		historyKept++;
	}
	const history = historyKept === 0 ? [] : historyAll.slice(historyAll.length - historyKept);

	const omitted =
		available === undefined
			? unknownFact<number>("this backend does not report its total history depth")
			: knownFact(Math.max(0, available - history.length));
	const issues: TerminalCaptureIssue[] = [];
	const omittedHistory = omitted.known ? omitted.value : historyAll.length - history.length;
	if (omittedHistory > 0) {
		issues.push({
			code: "history-truncated",
			detail: `${omittedHistory} older history row(s) were left out of this capture`,
		});
	}
	if (viewportRowsOmitted > 0) {
		issues.push({
			code: "viewport-truncated",
			detail: `the visible screen exceeded ${request.maxBytes} bytes; its ${viewportRowsOmitted} top row(s) were cut`,
		});
	}

	return {
		content: { viewport, history, lineModel: "physical-rows" },
		bounds: {
			historyLinesRequested: request.historyLines,
			historyLinesReturned: history.length,
			historyLinesAvailable:
				available === undefined
					? unknownFact("this backend does not report its total history depth")
					: knownFact(available),
			historyLinesOmitted: omitted,
			viewportRowsReturned: viewport.length,
			viewportRowsOmitted,
			bytesReturned: used,
			bytesLimit: request.maxBytes,
		},
		issues,
	};
}

/**
 * `sourceUpdatedAt` → how long ago the content last changed. Data only: no
 * threshold, no verdict, no `stale` issue. Deriving staleness from age was wrong
 * — an idle pane's snapshot is legitimately old and its screen is legitimately
 * correct — so freshness is a separate fact a backend must actually be able to
 * prove.
 */
export function lastChangeAge(
	sourceUpdatedAt: TerminalCaptureFact<string>,
	readAt: string,
): TerminalCaptureFact<number> {
	if (!sourceUpdatedAt.known) return unknownFact(sourceUpdatedAt.reason);
	const updated = Date.parse(sourceUpdatedAt.value);
	const read = Date.parse(readAt);
	if (Number.isNaN(updated) || Number.isNaN(read)) {
		return unknownFact("the source's update timestamp is not a parsable ISO instant");
	}
	return knownFact(Math.max(0, read - updated));
}

/** Build a miss. Kept here so every adapter's misses look the same. */
export function paneCaptureMiss(
	identity: TerminalPaneCaptureIdentity,
	availability: TerminalPaneCaptureMissReason,
	reason: string,
	liveness: TerminalPaneLiveness = "unknown",
): TerminalPaneCaptureMiss {
	return {
		version: TERMINAL_CAPTURE_VERSION,
		identity,
		readAt: new Date().toISOString(),
		availability,
		reason,
		liveness,
	};
}

/**
 * The identity check that brackets every read. A capture is only believable if
 * the pane it started on is the pane it ended on: without this, a pane that dies
 * and is replaced mid-read hands back the replacement's screen under the old
 * pane's name. `null` means the identities match.
 */
export function paneIdentityDrift(
	before: TerminalPaneCaptureIdentity,
	after: TerminalPaneCaptureIdentity,
): string | null {
	const drifted = (field: "incarnation" | "epoch"): string | null => {
		const a = before[field];
		const b = after[field];
		if (!a.known || !b.known) return null; // an unknown was never a promise
		return a.value === b.value ? null : `${field} changed from ${a.value} to ${b.value} during the read`;
	};
	return drifted("incarnation") ?? drifted("epoch");
}
