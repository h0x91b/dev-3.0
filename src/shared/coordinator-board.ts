/**
 * The `<dev3-board>` snapshot a coordinator agent receives on every turn.
 *
 * A coordinator's picture of the board used to be a snapshot it had to refresh
 * by hand (`COORDINATOR_PROMPT`: "not a feed"), which cost a tool call and only
 * happened when the agent remembered. The gap that actually burned: the user
 * walks the child tasks, changes things, comes back to the coordinator and asks
 * a question — and the coordinator answers from a picture taken before that walk.
 *
 * So the snapshot rides the turn instead. It is injected by the
 * `UserPromptSubmit` hook, which fires for EVERY turn — the user's own Enter and
 * a peer agent's `dev3 message` alike, since a delivered message is text plus an
 * Enter and reaches the harness as an ordinary prompt.
 *
 * Two rules hold this together:
 *  - Board state is a PASSENGER of a turn, never its driver. Nothing here may
 *    wake an agent up; a timer that pushed the board into a pane on its own
 *    would make the coordinator chatter and burn tokens on "nothing changed".
 *  - It reports what the board IS, not what changed. Marking changed rows would
 *    need the previous snapshot kept somewhere, and the freshly-finished tasks
 *    section covers the one delta that actually matters — a task the user
 *    completed while the coordinator was not looking.
 *  - The right-hand column is how long the task has sat in its column, NOT how
 *    long its terminal has been silent. tmux's `window_activity` looked like the
 *    better signal and is not: an app-wide redraw repaints every idle shell at
 *    once, so 45 of 60 panes carry one identical timestamp that jumps in a herd.
 *    See `decisions/2026/08/25/board-age-is-column-age-not-terminal-silence.md`.
 *
 * Rendering is pure and lives in shared/ so the socket payload and the hook
 * output can never drift apart. See
 * `decisions/2026/08/25/inject-the-board-into-every-coordinator-turn.md`.
 */

import { formatAge } from "./task-peek";

/** How far back a finished task still shows up in the snapshot. */
export const BOARD_FINISHED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Safety valve, not a product limit. A real board carries 20-30 live tasks and
 * a similar number finished in a day, which is well inside this. The cap exists
 * so a filter that one day stops filtering cannot pour a 1700-row board into
 * every single turn.
 */
export const BOARD_MAX_ROWS = 100;

export interface BoardRow {
	taskId: string;
	seq: number;
	/** Set only for a task in a live variant group; drives the `:N (id)` form. */
	variantIndex: number | null;
	/** Does another live task on this board still answer to the same seq? */
	seqShared: boolean;
	title: string;
	/** Built-in status, or the custom column's name when the task sits in one. */
	column: string;
	hibernated: boolean;
	draft: boolean;
	/** ISO time the task entered the column it is in now; null on a legacy task. */
	columnSince: string | null;
	/** ISO time the task reached completed/cancelled; null for a live task. */
	finishedAt: string | null;
}

export interface BoardSnapshot {
	/** ISO time the snapshot was taken. */
	at: string;
	projectName: string;
	live: BoardRow[];
	finished: BoardRow[];
	/** Rows dropped by {@link BOARD_MAX_ROWS}; never silently truncated. */
	omitted: number;
}

/** Titles are short imperatives by convention; this only catches the outliers. */
const MAX_TITLE = 64;

const INSTRUCTION =
	"Board state as of this message — read it instead of running `dev3 task list`. "
	+ "It does NOT arrive when the user types to you directly, so re-read the board before answering him after a silence. "
	+ "Address a task by its `seq:N`; a variant shows `:index (id)` and is addressed by that id. "
	+ "The last column is when the task landed in the column it is in — not how busy its agent is.";

/**
 * How a coordinator must name and address this task. A plain task travels as
 * the readable `seq:N`. A task whose seq is still shared by a live sibling
 * cannot: `dev3 message --task seq:N` is ambiguous there, and the id in
 * parentheses is the only address that works (see `agentReplyRef`). The variant
 * index rides along because that is what the user calls it in conversation.
 */
export function boardRef(row: BoardRow): string {
	if (!row.seqShared) return `seq:${row.seq}`;
	const variant = row.variantIndex != null ? `:${row.variantIndex}` : "";
	return `seq:${row.seq}${variant} (${row.taskId.slice(0, 8)})`;
}

function truncate(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * The right-hand column: when the task last landed where it is. Deliberately NOT
 * "quiet 41m", the wording this replaced — that promised terminal silence, and a
 * task can sit in one column for an hour with its agent typing the whole time.
 */
function activityCell(row: BoardRow, nowMs: number): string {
	// Finished wins over hibernated: once a task is done, WHEN it finished is the
	// fact the coordinator needs, and hibernation is bookkeeping about its memory.
	if (row.finishedAt !== null) {
		return `finished ${formatAge(nowMs - Date.parse(row.finishedAt))}`;
	}
	if (row.draft) return "draft, never started";
	if (row.hibernated) return "hibernated";
	if (row.columnSince === null) return "moved at an unknown time";
	return `moved ${formatAge(nowMs - Date.parse(row.columnSince))}`;
}

/** Columns are padded to the widest cell present, never to a fixed budget — the
 * padding is there so the eye finds a column, not so every board looks alike. */
function renderRows(rows: BoardRow[], nowMs: number): string[] {
	const refs = rows.map(boardRef);
	const titles = rows.map((r) => truncate(r.title, MAX_TITLE));
	const width = (cells: string[]) => Math.max(0, ...cells.map((c) => c.length));
	const refWidth = width(refs);
	const columnWidth = width(rows.map((r) => r.column));
	const titleWidth = width(titles);
	return rows.map((row, i) =>
		(`${refs[i].padEnd(refWidth)}  ${row.column.padEnd(columnWidth)}  `
			+ `${titles[i].padEnd(titleWidth)}  ${activityCell(row, nowMs)}`).trimEnd(),
	);
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Render the snapshot as the `<dev3-board>` block. `now` is injected so the
 * output is deterministic in tests. Returns "" for a snapshot with no rows at
 * all — an empty block is noise in every turn, and a coordinator with nothing
 * on its board learns nothing from being told so on repeat.
 */
export function renderCoordinatorBoard(snapshot: BoardSnapshot, now: Date): string {
	const rows = [...snapshot.live, ...snapshot.finished];
	if (rows.length === 0) return "";
	const nowMs = now.getTime();

	const out: string[] = [
		`<dev3-board at="${escapeAttr(snapshot.at)}" project="${escapeAttr(snapshot.projectName)}"`
		+ ` live="${snapshot.live.length}" finished-24h="${snapshot.finished.length}">`,
		INSTRUCTION,
		"",
		...renderRows(snapshot.live, nowMs),
	];

	if (snapshot.finished.length > 0) {
		out.push("");
		out.push("Finished in the last 24 hours:");
		out.push(...renderRows(snapshot.finished, nowMs));
	}

	if (snapshot.omitted > 0) {
		out.push("");
		out.push(`(${snapshot.omitted} more rows not shown — the board is over the ${BOARD_MAX_ROWS}-row cap.)`);
	}

	out.push("</dev3-board>");
	return out.join("\n");
}
