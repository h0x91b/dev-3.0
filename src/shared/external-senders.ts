/**
 * External senders: agents that run outside dev3 (an OpenClaw gateway, Claude
 * Desktop, a script) and talk to tasks through the CLI socket. Pure and shared:
 * the CLI, the socket handlers and the inbox store speak these shapes.
 *
 * Identity is self-asserted on a same-user socket — attribution, not
 * authentication. See `decisions/2026/10/26/external-senders.md`.
 */

/**
 * A sender id: lowercase `[a-z0-9._:-]`, 1-64 chars, starting with a letter or
 * digit and not ending with a dot, so `openclaw:home:main` works and the derived
 * folder name is a legal path segment on every platform.
 */
const SENDER_ID_RE = /^[a-z0-9](?:[a-z0-9._:-]{0,62}[a-z0-9_:-])?$/;
/** Underscore runs that would make the `:` → `__` slug ambiguous (`a:b` vs `a__b`). */
const AMBIGUOUS_UNDERSCORE_RE = /__|_:|:_/;
/** Windows reserves these device names in any case and with any extension. */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/;

export function isValidSenderId(id: string): boolean {
	return SENDER_ID_RE.test(id) && !AMBIGUOUS_UNDERSCORE_RE.test(id) && !WINDOWS_RESERVED_RE.test(senderInboxSlug(id));
}

/**
 * The inbox folder name for a sender id. Windows forbids `:` in file names, so it
 * becomes `__`. An id never holds `__`, `_:` or `:_`, so every even underscore run
 * in a slug is colons and the mapping stays one-to-one.
 */
export function senderInboxSlug(id: string): string {
	return id.replaceAll(":", "__");
}

export interface ExternalSender {
	id: string;
	label: string;
}

/** Stable error prefixes the CLI maps onto their own exit codes. */
export const UNKNOWN_EXTERNAL_SENDER_ERROR = "Unknown external sender";
export const SENDER_INBOX_BUSY_ERROR = "Sender inbox busy";

/** Unacknowledged items one sender's inbox holds before a post is refused. */
export const SENDER_INBOX_MAX_UNACKED = 500;
/** Days an inbox day-file is kept. */
export const SENDER_INBOX_RETENTION_DAYS = 30;
/** Longest a `sender.wait` parks; the CLI socket client gives up at 30 s. */
export const SENDER_WAIT_MAX_MS = 25_000;
/** Most items one `sender.wait` returns; more sets `more: true`. */
export const SENDER_WAIT_MAX_ITEMS = 50;
/** How long a lease outlives the wait that took it, so the holder can ack and re-wait. */
export const SENDER_LEASE_GRACE_MS = 10_000;

/** One reply a task wrote to an external sender. */
export interface SenderInboxItem {
	id: string;
	at: string;
	fromTaskId: string;
	fromSeq: number;
	fromTitle?: string;
	fromProjectId: string;
	/** The `<message-id>` the task was answering, when it said so. */
	inReplyTo?: string;
	subject: string;
	body: string;
	/** Set when the body was too large for one row and lives in this file instead. */
	spillPath?: string;
}

/**
 * One line of an inbox day-file. Append-only: an item is never rewritten, an ack
 * names items already written, and `pruned` records a day-file about to be
 * deleted so a reader can tell trimmed history from silence.
 */
export type SenderInboxRow =
	| ({ v: 1; kind: "item" } & SenderInboxItem)
	| { v: 1; kind: "ack"; at: string; ids: string[]; clientId: string }
	| { v: 1; kind: "pruned"; at: string; day: string; unacked: number };

export function parseSenderInboxRow(line: string): SenderInboxRow | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const row = JSON.parse(trimmed) as Partial<SenderInboxRow>;
		if (!row || typeof row !== "object" || row.v !== 1) return null;
		if (row.kind === "item" && typeof row.id === "string" && typeof row.body === "string") return row as SenderInboxRow;
		if (row.kind === "ack" && Array.isArray(row.ids)) return row as SenderInboxRow;
		if (row.kind === "pruned" && typeof row.day === "string") return row as SenderInboxRow;
		return null;
	} catch {
		return null;
	}
}

/** Unread replies the 30-day retention deleted from one day-file. */
export interface SenderPrunedNotice {
	day: string;
	unacked: number;
	at: string;
}

/** What `sender.wait` answers. `cursor` goes back on the next wait. */
export interface SenderWaitResult {
	items: SenderInboxItem[];
	cursor: string | null;
	more: boolean;
	/** Present only when unread replies were deleted by retention since the cursor. */
	pruned?: SenderPrunedNotice[];
}

/** Who asked for a launch when it was not a task: shown by the approval dialog. */
export interface ExternalSenderRequester {
	senderId: string;
	label: string;
}

export function isExternalSenderRequester(value: unknown): value is ExternalSenderRequester {
	return typeof value === "object" && value !== null && typeof (value as ExternalSenderRequester).senderId === "string";
}
