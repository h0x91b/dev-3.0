import { describe, it, expect } from "vitest";
import {
	BOARD_MAX_ROWS,
	boardRef,
	renderCoordinatorBoard,
	type BoardRow,
	type BoardSnapshot,
} from "../../shared/coordinator-board";

const NOW = new Date("2026-08-25T18:00:00.000Z");

function row(overrides: Partial<BoardRow> = {}): BoardRow {
	return {
		taskId: "b21e9f30-1111-2222-3333-444455556666",
		seq: 1620,
		variantIndex: null,
		seqShared: false,
		title: "Fix auth race in login flow",
		priority: "P2",
		column: "In Progress",
		hibernated: false,
		draft: false,
		columnSince: "2026-08-25T17:19:00.000Z",
		finishedAt: null,
		...overrides,
	};
}

function snapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
	return {
		at: NOW.toISOString(),
		projectName: "dev-3.0",
		live: [row()],
		finished: [],
		omitted: 0,
		...overrides,
	};
}

describe("boardRef", () => {
	// A live variant group is the one case where `--task seq:N` is ambiguous, so the id
	// is the only address that resolves; the survivor of a group keeps variantIndex
	// forever while its seq becomes unambiguous, so its id buys nothing.
	it("adds the id (and variant index) only while the seq is shared", () => {
		expect(boardRef(row())).toBe("<seq:1620>");
		expect(boardRef(row({ seqShared: true, variantIndex: 2 }))).toBe("<seq:1620> v2 (b21e9f30)");
		expect(boardRef(row({ seqShared: true }))).toBe("<seq:1620> (b21e9f30)");
		expect(boardRef(row({ seqShared: false, variantIndex: 3 }))).toBe("<seq:1620>");
	});
});

describe("renderCoordinatorBoard", () => {
	it("renders a live row with its column, title and how long it has sat there", () => {
		const text = renderCoordinatorBoard(snapshot(), NOW);
		expect(text).toContain("<seq:1620>");
		expect(text).toContain("In Progress");
		expect(text).toContain("Fix auth race in login flow");
		expect(text).toContain("moved 41m ago");
		expect(text).toContain('live="1"');
		expect(text.endsWith("</dev3-board>")).toBe(true);
		expect(text).toContain("instead of running `dev3 task list`");
		expect(text).toContain("`P0`…`P4`");
		// Column age, not terminal silence: `window_activity` moves for every idle shell.
		expect(text).not.toContain("quiet");
		expect(text).not.toContain("per tmux window");
		// The priority sits between the ref and the column.
		expect(text).toMatch(/<seq:1620>\s+P2\s+In Progress\s+Fix auth race/);
		// An empty board renders nothing at all: an empty block every turn is pure noise.
		expect(renderCoordinatorBoard(snapshot({ live: [], finished: [] }), NOW)).toBe("");
	});

	it("puts tasks finished in the window in their own section with their age", () => {
		const text = renderCoordinatorBoard(snapshot({
			finished: [row({ seq: 1600, column: "Completed", finishedAt: "2026-08-25T16:00:00.000Z" })],
		}), NOW);
		expect(text).toContain("Finished in the last 24 hours:");
		expect(text).toContain("finished 2h ago");
		expect(text).toContain('finished-24h="1"');
		// Seen on the real board: a completed-then-hibernated task said "hibernated"
		// and hid the one thing that mattered — when it finished.
		const hibernated = renderCoordinatorBoard(snapshot({
			live: [],
			finished: [row({ column: "Completed", hibernated: true, finishedAt: "2026-08-25T16:00:00.000Z" })],
		}), NOW);
		expect(hibernated).toContain("finished 2h ago");
		expect(hibernated).not.toContain("hibernated");
	});

	// A legacy task with no stamp must not read as "just moved here" — zero is the
	// one value a coordinator would act on.
	it("says the stint is unknown rather than zero, and reports hibernated and draft tasks as such", () => {
		const text = renderCoordinatorBoard(snapshot({ live: [row({ columnSince: null })] }), NOW);
		expect(text).toContain("moved at an unknown time");
		expect(text).not.toContain("moved 0s");
		// A hibernated task reads as hibernated and a draft as never started, whatever the stamp says.
		const hibernated = renderCoordinatorBoard(snapshot({ live: [row({ hibernated: true })] }), NOW);
		expect(hibernated).toContain("hibernated");
		expect(hibernated).not.toContain("moved 41m ago");
		const draft = renderCoordinatorBoard(snapshot({ live: [row({ draft: true })] }), NOW);
		expect(draft).toContain("draft, never started");
		expect(draft).not.toContain("moved 41m ago");
	});

	// Silent truncation reads as "this is the whole board", which is exactly the
	// wrong thing to tell someone whose job is knowing the whole board.
	it("says how many rows it dropped rather than truncating silently", () => {
		const text = renderCoordinatorBoard(snapshot({ omitted: 7 }), NOW);
		expect(text).toContain(`7 more rows not shown`);
		expect(text).toContain(String(BOARD_MAX_ROWS));
	});

	it("escapes a project name that would break the opening tag, and truncates an overlong title", () => {
		expect(renderCoordinatorBoard(snapshot({ projectName: 'a"b<c' }), NOW)).toContain('project="a&quot;b&lt;c"');
		const long = "x".repeat(200);
		const text = renderCoordinatorBoard(snapshot({ live: [row({ title: long })] }), NOW);
		expect(text).toContain("…");
		expect(text).not.toContain(long);
	});
});

describe("priority cell", () => {
	// The cell sits between two padded columns, so a wider ref on one row must not
	// shift the column of the row below it.
	it("keeps every row on its own line, columns aligned across rows of differing ref width", () => {
		const text = renderCoordinatorBoard(
			snapshot({ live: [row({ seq: 7, priority: "P0" }), row({ seq: 1631, priority: "P4" })] }),
			NOW,
		);
		const lines = text.split("\n").filter((l) => l.includes("In Progress"));
		expect(lines).toHaveLength(2);
		expect(lines[0].indexOf("In Progress")).toBe(lines[1].indexOf("In Progress"));
		expect(lines[0]).toContain("P0");
		expect(lines[1]).toContain("P4");
	});
});
