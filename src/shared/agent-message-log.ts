/**
 * The on-disk shape of one delivered message, and the rules that keep the file
 * append-only and safe for two app instances at once.
 *
 * Until this existed, task-to-task traffic left no trace: `dev3 message` types
 * straight into the recipient's pane and the only record was a 30-second toast.
 * A user who stepped away could not reconstruct what the coordinator and its
 * workers said to each other.
 *
 * Pure and shared: the bun writer, the reader and the renderer all speak this
 * type, so a row can never mean two different things at the two ends.
 */

import type { AgentPromptDeliveryStatus } from "./agent-prompt-delivery";

/** Schema version. Bumped only when a reader must branch; readers skip unknown values. */
export const AGENT_MESSAGE_LOG_VERSION = 1;

/**
 * Hard ceiling on one serialised row, including its newline.
 *
 * Load-bearing for concurrency, not for disk. Appends from two processes are
 * interleaving-safe only while each row is a single `write()`; a buffer large
 * enough to be split by a short write could tear a line in half. Bodies over
 * {@link AGENT_MESSAGE_SPILL_THRESHOLD_BYTES} (4 KB) already travel as a
 * spill-file pointer, so a real row sits far below this.
 */
export const AGENT_MESSAGE_LOG_MAX_ROW_BYTES = 8_192;

/** Days of history kept. Older day-files are deleted, not compacted. */
export const AGENT_MESSAGE_LOG_RETENTION_DAYS = 30;

/** Marker appended to a body clipped by {@link AGENT_MESSAGE_LOG_MAX_ROW_BYTES}. */
export const AGENT_MESSAGE_LOG_TRUNCATION_MARK = "…[truncated by the message log]";

/**
 * What the recipient's pane actually received.
 *
 * - `text` — the body itself, verbatim.
 * - `spill-pointer` — the body was too large to type, so a file was written next
 *   to the task and the pane got a pointer to it. `spillPath` names that file.
 *   It lives in the task directory and dies with the task on cleanup, so an old
 *   row's pointer may name a file that no longer exists — the row then documents
 *   that a large message was sent, and nothing more.
 */
export type AgentMessageBodyKind = "text" | "spill-pointer";

/** Immediate `dev3 message` send versus a queued "Send later" fire. */
export type AgentMessageLogKind = "immediate" | "scheduled";

/** One delivered (or attempted) message. Written once, never amended. */
export interface AgentMessageLogRow {
	v: number;
	/** ISO timestamp of the delivery attempt, not of authoring. */
	at: string;
	/** Sender task, or null when no agent wrote it (a UI button, a dev3 hand-off). */
	fromTaskId: string | null;
	fromSeq: number | null;
	fromTitle?: string;
	fromProjectId?: string;
	toTaskId: string;
	toSeq: number;
	toTitle?: string;
	toProjectId: string;
	kind: AgentMessageLogKind;
	/** ISO time the message was queued for, on `scheduled` rows only. */
	scheduledFor?: string;
	body: string;
	bodyKind: AgentMessageBodyKind;
	spillPath?: string;
	/** The delivery verdict — `unconfirmed` is its own answer, never folded away. */
	status: AgentPromptDeliveryStatus;
	reason?: string;
	detail?: string;
}

/** Everything needed to write a row, minus the version and the clock. */
export type AgentMessageLogInput = Omit<AgentMessageLogRow, "v">;

/** One page of history, as the reader returns it and the renderer receives it. */
export interface AgentMessageLogPage {
	/** Newest first. */
	rows: AgentMessageLogRow[];
	/**
	 * The oldest day still on disk (`YYYY-MM-DD`), or null when there is no history
	 * at all. A reader shows this so trimmed history reads as trimmed, not as
	 * silence: everything before this day was deleted by the retention policy.
	 */
	oldestDay: string | null;
	/** Days of history the retention policy keeps. */
	retentionDays: number;
	/** True when `limit` cut the answer short and older rows still exist on disk. */
	hasMore: boolean;
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Clip `body` so the whole row fits the ceiling. Returns the body to store. */
export function clampLogBody(body: string, overheadBytes: number): string {
	const budget = AGENT_MESSAGE_LOG_MAX_ROW_BYTES - overheadBytes - utf8Bytes(AGENT_MESSAGE_LOG_TRUNCATION_MARK);
	if (utf8Bytes(body) <= AGENT_MESSAGE_LOG_MAX_ROW_BYTES - overheadBytes) return body;
	if (budget <= 0) return AGENT_MESSAGE_LOG_TRUNCATION_MARK;
	// Walk back from the byte budget so a multi-byte character is never cut in half.
	let end = Math.min(body.length, budget);
	while (end > 0 && utf8Bytes(body.slice(0, end)) > budget) end -= 1;
	return body.slice(0, end) + AGENT_MESSAGE_LOG_TRUNCATION_MARK;
}

/**
 * Serialise one row into exactly one line, guaranteed to fit the ceiling.
 *
 * The body is clamped against the size of everything else in the row, so a long
 * body shrinks and the metadata always survives — a row whose recipient or
 * outcome had been dropped would be worthless to a traffic graph.
 */
export function serializeAgentMessageLogRow(input: AgentMessageLogInput): string {
	const row: AgentMessageLogRow = { v: AGENT_MESSAGE_LOG_VERSION, ...input };
	const line = `${JSON.stringify(row)}\n`;
	if (utf8Bytes(line) <= AGENT_MESSAGE_LOG_MAX_ROW_BYTES) return line;
	const overhead = utf8Bytes(`${JSON.stringify({ ...row, body: "" })}\n`);
	return `${JSON.stringify({ ...row, body: clampLogBody(row.body, overhead) })}\n`;
}

/**
 * Parse one line, or null when it cannot be trusted.
 *
 * A torn or half-written line is expected rather than exceptional: the app can be
 * killed mid-append, and a reader that threw on one bad byte would lose the whole
 * day. Anything without a recipient and a timestamp is discarded.
 */
export function parseAgentMessageLogRow(line: string): AgentMessageLogRow | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const row = parsed as Partial<AgentMessageLogRow>;
	if (typeof row.at !== "string" || typeof row.toTaskId !== "string" || typeof row.body !== "string") return null;
	if (typeof row.toSeq !== "number" || typeof row.status !== "string") return null;
	return row as AgentMessageLogRow;
}
