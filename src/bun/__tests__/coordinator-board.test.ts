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
		column: "In Progress",
		hibernated: false,
		draft: false,
		activity: { kind: "age", ms: 41 * 60_000, granularity: "window" },
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
	it("addresses an ordinary task by its seq alone", () => {
		expect(boardRef(row())).toBe("seq:1620");
	});

	// A live variant group is the one case where `--task seq:N` is ambiguous, so
	// the id is not decoration — it is the only address that resolves.
	it("carries the variant index and the id when the seq is still shared", () => {
		expect(boardRef(row({ seqShared: true, variantIndex: 2 }))).toBe("seq:1620:2 (b21e9f30)");
	});

	it("keeps the id but drops the index for a shared seq with no variant index", () => {
		expect(boardRef(row({ seqShared: true }))).toBe("seq:1620 (b21e9f30)");
	});

	// The survivor of a variant group keeps variantIndex forever while its seq
	// becomes unambiguous; spending bytes on its id every turn buys nothing.
	it("drops the id once the task is the last of its variant group", () => {
		expect(boardRef(row({ seqShared: false, variantIndex: 3 }))).toBe("seq:1620");
	});
});

describe("renderCoordinatorBoard", () => {
	it("renders a live row with its column, title and quiet time", () => {
		const text = renderCoordinatorBoard(snapshot(), NOW);
		expect(text).toContain("seq:1620");
		expect(text).toContain("In Progress");
		expect(text).toContain("Fix auth race in login flow");
		expect(text).toContain("quiet 41m ago");
		expect(text).toContain('live="1"');
		expect(text.endsWith("</dev3-board>")).toBe(true);
	});

	// An empty block on every turn is pure noise, and a coordinator with nothing
	// on its board learns nothing from being told so repeatedly.
	it("renders nothing at all for an empty board", () => {
		expect(renderCoordinatorBoard(snapshot({ live: [], finished: [] }), NOW)).toBe("");
	});

	it("puts tasks finished in the window in their own section with their age", () => {
		const text = renderCoordinatorBoard(snapshot({
			finished: [row({ seq: 1600, column: "Completed", finishedAt: "2026-08-25T16:00:00.000Z" })],
		}), NOW);
		expect(text).toContain("Finished in the last 24 hours:");
		expect(text).toContain("finished 2h ago");
		expect(text).toContain('finished-24h="1"');
	});

	// "Not checked" must never render as "checked and quiet" — the single most
	// expensive misread a coordinator can make about a child.
	it("never reports an unreadable activity time as quiet", () => {
		const text = renderCoordinatorBoard(snapshot({ live: [row({ activity: { kind: "unknown" } })] }), NOW);
		expect(text).toContain("activity unknown");
		expect(text).not.toContain("quiet");
	});

	it("names why a task has no terminal instead of showing a time", () => {
		const text = renderCoordinatorBoard(snapshot({
			live: [row({ activity: { kind: "no-session", reason: "not running" } })],
		}), NOW);
		expect(text).toContain("no terminal — not running");
	});

	it("reports a hibernated task as hibernated, whatever its activity says", () => {
		const text = renderCoordinatorBoard(snapshot({ live: [row({ hibernated: true })] }), NOW);
		expect(text).toContain("hibernated");
		expect(text).not.toContain("quiet 41m");
	});

	it("marks window-level activity and explains the mark once", () => {
		const text = renderCoordinatorBoard(snapshot(), NOW);
		expect(text).toContain("quiet 41m ago*");
		expect(text).toContain("* this backend reports activity per tmux window, not per pane.");
	});

	it("does not explain the mark when no row is window-level", () => {
		const text = renderCoordinatorBoard(snapshot({
			live: [row({ activity: { kind: "age", ms: 5_000, granularity: "pane" } })],
		}), NOW);
		expect(text).toContain("quiet 5s ago");
		expect(text).not.toContain("per tmux window");
	});

	// Silent truncation reads as "this is the whole board", which is exactly the
	// wrong thing to tell someone whose job is knowing the whole board.
	it("says how many rows it dropped rather than truncating silently", () => {
		const text = renderCoordinatorBoard(snapshot({ omitted: 7 }), NOW);
		expect(text).toContain(`7 more rows not shown`);
		expect(text).toContain(String(BOARD_MAX_ROWS));
	});

	it("tells the agent to read the block instead of running task list", () => {
		const text = renderCoordinatorBoard(snapshot(), NOW);
		expect(text).toContain("instead of running `dev3 task list`");
	});

	it("escapes a project name that would otherwise break the opening tag", () => {
		const text = renderCoordinatorBoard(snapshot({ projectName: 'a"b<c' }), NOW);
		expect(text).toContain('project="a&quot;b&lt;c"');
	});

	it("keeps every row on its own line", () => {
		const text = renderCoordinatorBoard(snapshot({
			live: [row({ seq: 1620 }), row({ seq: 1631, title: "Windows packaging step" })],
		}), NOW);
		const rows = text.split("\n").filter((l) => l.startsWith("seq:"));
		expect(rows).toHaveLength(2);
	});

	it("truncates an overlong title instead of letting it run the line away", () => {
		const long = "x".repeat(200);
		const text = renderCoordinatorBoard(snapshot({ live: [row({ title: long })] }), NOW);
		expect(text).toContain("…");
		expect(text).not.toContain(long);
	});
});
