import type { NoteSource, TaskMovementKind, TaskStatus } from "./types";

/**
 * What kind of thing happened. `note` is something an agent or the user wrote
 * down; `move` is the card changing its position on the board — created, a
 * status change (completion and cancellation included), or a custom-column move.
 */
export type BoardEventKind = "note" | "move";

/** One thing that happened on the board, addressable by a cursor. */
export interface BoardEvent {
	kind: BoardEventKind;
	/** Normalised ISO instant — the sort key, never the raw stored string. */
	at: string;
	/** Source record id (a note id), shown so `dev3 note show` can fetch the body. */
	id: string;
	projectId: string;
	projectName: string;
	taskId: string;
	seq: number | null;
	taskTitle: string;
	taskStatus: TaskStatus;
	/** Who wrote it. Notes only — a movement has no author the board records. */
	source?: NoteSource;
	/** Movements only: the structured move behind the rendered `text`. */
	movement?: {
		kind: TaskMovementKind;
		from?: TaskStatus;
		to: TaskStatus;
		fromColumn?: string | null;
		toColumn?: string | null;
	};
	text: string;
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
	/**
	 * The instant `--from` actually resolved to. Set by the app, because an id
	 * prefix can only be resolved there — without it a quiet sweep started from
	 * an id would leave the caller with no position at all.
	 */
	from?: string | null;
	/**
	 * Movements the per-task cap destroyed on tasks whose oldest surviving move is
	 * newer than the cursor — so some of them fell inside what was asked for and
	 * can never be shown. Reported rather than hidden: a trimmed log presented as
	 * a complete one is the same silent-loss failure a cursor exists to prevent.
	 */
	movementsEvicted?: number;
}

/**
 * One line describing a move, in the same voice a note's body reads in. Column
 * names win over the status they share, because "On hold" is what the board
 * shows and the status underneath it is an implementation detail.
 */
export function formatMovementText(
	movement: NonNullable<BoardEvent["movement"]>,
	formatStatusLabel: (status: TaskStatus) => string,
): string {
	const where = (status: TaskStatus, column?: string | null) => column || formatStatusLabel(status);
	const to = where(movement.to, movement.toColumn);
	if (movement.kind === "created") return `created in ${to}`;
	return `${where(movement.from ?? movement.to, movement.fromColumn)} → ${to}`;
}

/** Default look-back when the caller supplies no cursor. */
export const DEFAULT_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EVENT_LIMIT = 100;
export const MAX_EVENT_LIMIT = 1000;

/**
 * The cursor is a bare instant to the millisecond: `2026-08-28T20:22:22.303`.
 * No `Z`, no id half — it is copied by hand into a prompt often enough that ten
 * wasted characters are a real cost.
 *
 * Milliseconds are NOT decoration. Measured over the 1805 notes on the dev-3.0
 * board: 73 individual seconds carry more than one note, and no millisecond
 * carries two. A second-precision cursor would therefore have to either re-show
 * the last event on every call or skip its same-second siblings — roughly 8% of
 * notes sit in such a group.
 */
const CURSOR_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DURATION_RE = /^(\d+)\s*(s|m|h|d|w)$/i;

const DURATION_UNIT_MS: Record<string, number> = {
	s: 1000,
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
	w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * A `--from` value that is neither an instant nor a duration is read as an
 * event id prefix — the 8-hex value already sitting in the ID column, or any
 * unambiguous head of it. Four characters is the floor: shorter is ambiguous
 * across a board with hundreds of notes far more often than it is convenient.
 */
const EVENT_ID_PREFIX_RE = /^[0-9a-fA-F]{4,32}$/;

/** Prefixes an `events.list` error the CLI must report as a cursor problem. */
export const EVENT_CURSOR_UNRESOLVED_PREFIX = "event-cursor-unresolved: ";

export function isEventIdPrefix(raw: string): boolean {
	return EVENT_ID_PREFIX_RE.test(raw.trim());
}

/** What a run prints on its `Cursor:` line. */
export function formatEventCursor(event: BoardEvent): string {
	return event.at.replace(/Z$/, "");
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

/**
 * Three accepted shapes, all resolving to one instant:
 *   - `2026-08-28T20:22:22.303`  the printed cursor (a position)
 *   - `2026-08-01` / `...Z`      a plainer instant, for a deliberately wider sweep
 *   - `2h` / `30m` / `3d` / `1w` a duration back from now
 *
 * Returns null for anything else — a cursor is never guessed.
 */
export function parseEventCursor(raw: string, now: number = Date.now()): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	const duration = DURATION_RE.exec(trimmed);
	if (duration) {
		const amount = Number(duration[1]);
		if (!Number.isFinite(amount) || amount <= 0) return null;
		return new Date(now - amount * DURATION_UNIT_MS[duration[2].toLowerCase()]).toISOString();
	}

	if (DATE_RE.test(trimmed)) return normalizeEventInstant(`${trimmed}T00:00:00.000Z`);

	const stamp = CURSOR_RE.exec(trimmed);
	if (!stamp) return null;
	const millis = (stamp[7] ?? "").padEnd(3, "0");
	return normalizeEventInstant(
		`${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}.${millis}Z`,
	);
}

function compareEvents(a: BoardEvent, b: BoardEvent): number {
	if (a.at !== b.at) return a.at < b.at ? -1 : 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Turn an id prefix into the instant it points at. Throws a message the CLI
 * turns into exit 19 — an id that resolves to nothing must never be answered
 * with "no events since then", which reads as a quiet board.
 */
export function resolveEventIdPrefix(all: BoardEvent[], prefix: string): string {
	const wanted = prefix.trim().toLowerCase();
	const hits = all.filter((e) => e.id.toLowerCase().startsWith(wanted));
	if (hits.length === 1) return hits[0].at;
	if (hits.length === 0) {
		throw new Error(
			`${EVENT_CURSOR_UNRESOLVED_PREFIX}no event id starts with "${prefix}".\n`
			+ "Notes can be deleted, and a task keeps only its 50 most recent, so an old id may be gone.\n"
			+ "Use the instant form from a previous run's `Cursor:` line, or run `dev3 events` with no --from.",
		);
	}
	const sample = hits.slice(0, 5).map((e) => `${e.id.slice(0, 8)} (seq ${e.seq ?? "-"})`).join(", ");
	throw new Error(
		`${EVENT_CURSOR_UNRESOLVED_PREFIX}"${prefix}" matches ${hits.length} events: ${sample}`
		+ `${hits.length > 5 ? ", …" : ""}\nGive more characters of the id.`,
	);
}

/**
 * Oldest-first selection. The cap keeps the OLDEST matches and reports the newer
 * ones it dropped, so re-running with the returned cursor continues without a
 * hole — dropping the oldest would skip them forever. It also never splits a
 * group sharing one instant, because the cursor cannot address half of one.
 */
export function selectEvents(
	all: BoardEvent[],
	opts: { cursor: string | null; limit: number; now: number; windowMs?: number },
): EventSelection {
	const sorted = [...all].sort(compareEvents);

	let matches: BoardEvent[];
	let olderThanWindow = 0;
	if (opts.cursor) {
		matches = sorted.filter((e) => e.at > (opts.cursor as string));
	} else {
		const cutoff = new Date(opts.now - (opts.windowMs ?? DEFAULT_EVENT_WINDOW_MS)).toISOString();
		matches = sorted.filter((e) => e.at >= cutoff);
		olderThanWindow = sorted.length - matches.length;
	}

	let take = Math.max(0, Math.min(opts.limit, matches.length));
	while (take > 0 && take < matches.length && matches[take].at === matches[take - 1].at) take++;

	const events = matches.slice(0, take);
	return {
		events,
		droppedNewer: matches.length - events.length,
		olderThanWindow,
		matched: matches.length,
		cursor: events.length > 0 ? formatEventCursor(events[events.length - 1]) : null,
	};
}
