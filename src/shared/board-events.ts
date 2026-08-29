import type { NoteSource, TaskStatus } from "./types";

/**
 * What kind of thing happened. v1 emits only "note"; the field exists so board
 * movements, task creation and completion can join later without reshaping the
 * line format callers already read.
 */
export type BoardEventKind = "note";

/** One thing that happened on the board, addressable by a cursor. */
export interface BoardEvent {
	kind: BoardEventKind;
	/** Normalised ISO instant — the sort key, never the raw stored string. */
	at: string;
	/** Source record id (a note id); its 8-char prefix is the cursor tie-break. */
	id: string;
	projectId: string;
	projectName: string;
	taskId: string;
	seq: number | null;
	taskTitle: string;
	taskStatus: TaskStatus;
	source: NoteSource;
	text: string;
}

/**
 * A position in the feed, not a time window. `id` is null for the wider
 * `--from <iso>` form, which means "everything strictly after this instant".
 */
export interface EventCursor {
	at: string;
	id: string | null;
}

export interface EventSelection {
	events: BoardEvent[];
	/** Events that matched but lost to `limit`. Always newer than what is shown. */
	droppedNewer: number;
	/** Events older than the default window. Zero when a cursor was supplied. */
	olderThanWindow: number;
	/** Everything that matched before the cap. */
	matched: number;
	/** Cursor for the newest shown event, or null when nothing was shown. */
	cursor: string | null;
}

/** Default look-back when the caller supplies no cursor. */
export const DEFAULT_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EVENT_LIMIT = 100;
export const MAX_EVENT_LIMIT = 1000;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CURSOR_RE = /^(.+Z)\.([0-9a-fA-F]{8})$/;

/** The 8-char id half of a cursor — same prefix convention as `dev3 note show`. */
export function eventCursorId(id: string): string {
	return id.slice(0, 8).toLowerCase();
}

export function formatEventCursor(event: BoardEvent): string {
	return `${event.at}.${eventCursorId(event.id)}`;
}

/**
 * Normalise a stored timestamp into a lexicographically sortable ISO instant.
 * Returns null when the value is unusable, so callers decide the fallback
 * rather than silently getting 1970.
 */
export function normalizeEventInstant(raw: string | undefined | null): string | null {
	if (!raw) return null;
	const ms = Date.parse(raw);
	if (Number.isNaN(ms)) return null;
	return new Date(ms).toISOString();
}

/** Parse `<iso>.<id8>` or a bare `<iso>`. Returns null for anything else. */
export function parseEventCursor(raw: string): EventCursor | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	const withId = CURSOR_RE.exec(trimmed);
	if (withId) {
		const at = normalizeEventInstant(withId[1]);
		if (!at || !ISO_RE.test(withId[1])) return null;
		return { at, id: withId[2].toLowerCase() };
	}

	if (!ISO_RE.test(trimmed)) return null;
	const at = normalizeEventInstant(trimmed);
	return at ? { at, id: null } : null;
}

function compareEvents(a: BoardEvent, b: BoardEvent): number {
	if (a.at !== b.at) return a.at < b.at ? -1 : 1;
	const aid = eventCursorId(a.id);
	const bid = eventCursorId(b.id);
	if (aid !== bid) return aid < bid ? -1 : 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isAfterCursor(event: BoardEvent, cursor: EventCursor): boolean {
	if (event.at !== cursor.at) return event.at > cursor.at;
	if (cursor.id === null) return false;
	return eventCursorId(event.id) > cursor.id;
}

/**
 * Oldest-first selection. The cap keeps the OLDEST matches and reports the
 * newer ones it dropped, so re-running with the returned cursor continues
 * without a hole — dropping the oldest would skip them forever.
 */
export function selectEvents(
	all: BoardEvent[],
	opts: { cursor: EventCursor | null; limit: number; now: number; windowMs?: number },
): EventSelection {
	const sorted = [...all].sort(compareEvents);

	let matches: BoardEvent[];
	let olderThanWindow = 0;
	if (opts.cursor) {
		matches = sorted.filter((e) => isAfterCursor(e, opts.cursor as EventCursor));
	} else {
		const cutoff = new Date(opts.now - (opts.windowMs ?? DEFAULT_EVENT_WINDOW_MS)).toISOString();
		matches = sorted.filter((e) => e.at >= cutoff);
		olderThanWindow = sorted.length - matches.length;
	}

	const events = matches.slice(0, Math.max(0, opts.limit));
	return {
		events,
		droppedNewer: matches.length - events.length,
		olderThanWindow,
		matched: matches.length,
		cursor: events.length > 0 ? formatEventCursor(events[events.length - 1]) : null,
	};
}
