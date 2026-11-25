/**
 * Rendering and selection rules of `dev3 peek` — pure functions, no mocks.
 * Lives under the bun config because the shared/ tree has no test project.
 */
import { describe, it, expect } from "vitest";
import {
	clampPeekLines,
	dropFaintText,
	formatAge,
	PEEK_DEFAULT_LINES,
	PEEK_MAX_LINES,
	renderTaskPeek,
	selectPeekPane,
	stripTerminalEscapes,
	tailLines,
	type PeekPane,
	type TaskPeekSnapshot,
} from "../../shared/task-peek";

const NOW = new Date("2026-08-04T10:00:30.000Z");

function pane(extra: Partial<PeekPane> = {}): PeekPane {
	return {
		index: 1,
		paneId: "%1",
		label: "claude",
		alive: true,
		focused: true,
		lastOutputAt: "2026-08-04T10:00:27.000Z",
		lastOutputAgeMs: 3_000,
		granularity: "pane",
		...extra,
	};
}

function snapshot(extra: Partial<TaskPeekSnapshot> = {}): TaskPeekSnapshot {
	return {
		taskId: "aaaaaaaa-0000-0000-0000-000000000001",
		seq: 42,
		title: "Fix auth race",
		status: "in-progress",
		backend: "native",
		observedAt: "2026-08-04T10:00:30.000Z",
		sessionPresent: true,
		unavailable: null,
		panes: [pane()],
		tail: { paneIndex: 1, paneId: "%1", lines: 2, text: "running tests\nall good" },
		...extra,
	};
}

describe("renderTaskPeek", () => {
	it("opens with the task header, prints one line per pane, names the tail's pane, and says nothing of windows for per-pane backends", () => {
		const out = renderTaskPeek(
			snapshot({
				panes: [
					pane(),
					pane({ index: 2, paneId: "%2", label: "bun", focused: false, lastOutputAt: "2026-08-04T09:59:30.000Z" }),
				],
			}),
			NOW,
		);

		expect(out.split("\n")[0]).toBe("<seq:42> · Fix auth race · in-progress · backend=native · 2 panes");
		expect(out).toContain("pane 1  claude  alive, focused  last output 3s ago");
		expect(out).toContain("pane 2  bun  alive  last output 1m ago");
		expect(out).toContain("--- pane 1 (%1), last 2 lines ---");
		expect(out.trimEnd().endsWith("all good")).toBe(true);
		expect(out).not.toContain("window");
		// No seq: a short task id stands in.
		expect(renderTaskPeek(snapshot({ seq: null }), NOW).startsWith("Task aaaaaaaa ·")).toBe(true);
	});

	it("says unknown instead of inventing an age", () => {
		const out = renderTaskPeek(snapshot({ panes: [pane({ lastOutputAt: null })] }), NOW);

		const paneLine = out.split("\n").find((l) => l.startsWith("pane 1"));
		expect(paneLine).toContain("last output unknown");
		expect(paneLine).not.toMatch(/ago/);
	});

	it("marks window-level freshness and explains it once", () => {
		const out = renderTaskPeek(
			snapshot({ backend: "tmux", panes: [pane({ granularity: "window" })] }),
			NOW,
		);

		expect(out).toContain("(window-level)");
		expect(out).toContain("reports activity per window, not per pane");
	});

	it("states the reason when there is no session, and says a failed read tells us nothing about the task", () => {
		const noSession = renderTaskPeek(
			snapshot({
				sessionPresent: false,
				unavailable: { kind: "no-session", detail: "task is hibernated" },
				panes: [],
				tail: null,
			}),
			NOW,
		);
		expect(noSession).toContain("no terminal session — task is hibernated");
		expect(noSession).not.toContain("pane 1");

		const failed = renderTaskPeek(
			snapshot({
				sessionPresent: false,
				unavailable: { kind: "read-failed", detail: "Error: tmux exploded" },
				panes: [],
				tail: null,
			}),
			NOW,
		);
		expect(failed).toContain("could not read the terminal — Error: tmux exploded");
		expect(failed).toContain("says nothing about whether the task is working");
		expect(failed).not.toContain("no terminal session");
	});

	it("keeps the pane summary and names the missing pane", () => {
		const out = renderTaskPeek(
			snapshot({ unavailable: { kind: "pane-not-found", detail: 'no pane "9" in this session' }, tail: null }),
			NOW,
		);

		expect(out).toContain("pane 1  claude");
		expect(out).toContain('no such pane — no pane "9" in this session');
		expect(out).not.toContain("--- pane");
	});
});

describe("formatAge / clampPeekLines", () => {
	it("formatAge renders each unit at its boundary", () => {
		const cases: Array<[number, string]> = [
			[59_000, "59s ago"],
			[60_000, "1m ago"],
			[3_600_000, "1h ago"],
			[90_000_000, "1d ago"],
		];
		for (const [ms, expected] of cases) expect(formatAge(ms), String(ms)).toBe(expected);
	});

	it("clampPeekLines defaults missing/NaN, floors at 1 and caps at the max", () => {
		const cases: Array<[number | undefined, number]> = [
			[undefined, PEEK_DEFAULT_LINES],
			[Number.NaN, PEEK_DEFAULT_LINES],
			[0, 1],
			[40, 40],
			[PEEK_MAX_LINES + 1, PEEK_MAX_LINES],
		];
		for (const [input, expected] of cases) expect(clampPeekLines(input), String(input)).toBe(expected);
	});
});

describe("tailLines", () => {
	it("keeps the last N lines, drops trailing blanks, strips colour/title escapes, and keeps tabs", () => {
		expect(tailLines("a\nb\nc\nd", 2)).toBe("c\nd");
		expect(tailLines("a\nb\n\n\n", 10)).toBe("a\nb");
		expect(tailLines("\u001b[32mok\u001b[0m", 10)).toBe("ok");
		expect(tailLines("\u001b]0;my title\u0007text", 10)).toBe("text");
		expect(tailLines("a\tb", 10)).toBe("a\tb");
	});
});

describe("dropFaintText", () => {
	it("drops the ghost after Claude's `❯` and Codex's `›` prompt glyphs, keeps typed text and every row's newline", () => {
		// Empty input box: a live prompt, then a faint ghost of a past message.
		expect(stripTerminalEscapes(dropFaintText("\u001b[39m❯ \u001b[2mpush it and open the PR\u001b[0m"))).toBe("❯ ");
		// The glyph survives even though the whole line is faint; the placeholder goes.
		expect(stripTerminalEscapes(dropFaintText("\u001b[2m› Ask Codex to do anything\u001b[0m"))).toBe("›");
		expect(stripTerminalEscapes(dropFaintText("❯ do the thing"))).toBe("❯ do the thing");
		const text = "running tests\n\u001b[39m❯ \u001b[2mghost\u001b[0m\nall good";
		expect(stripTerminalEscapes(dropFaintText(text))).toBe("running tests\n❯ \nall good");
	});

	// The blocker Arseny caught: faint is real content off the prompt line.
	it("keeps faint tool output that is NOT on the prompt line (Codex DIM)", () => {
		const out = "│ \u001b[2mran build, 0 errors\u001b[0m\n└ \u001b[2mdone\u001b[0m";
		expect(stripTerminalEscapes(dropFaintText(out))).toBe("│ ran build, 0 errors\n└ done");
	});

	it("keeps Codex's faint `Worked for` line and a faint line-number gutter", () => {
		expect(stripTerminalEscapes(dropFaintText("\u001b[2mWorked for 2m 41s · 10:50\u001b[0m"))).toBe("Worked for 2m 41s · 10:50");
		expect(stripTerminalEscapes(dropFaintText("\u001b[2m  1\u001b[0m const x = 1"))).toBe("  1 const x = 1");
	});

	it("leaves normal-intensity and plain text untouched, and does not mistake truecolour (38;2;r;g;b) for faint", () => {
		expect(dropFaintText("plain \u001b[32mgreen\u001b[0m text")).toBe("plain \u001b[32mgreen\u001b[0m text");
		expect(dropFaintText("no escapes here")).toBe("no escapes here");
		// The `2` selects RGB colour space, not the faint attribute, so `red` stays.
		expect(stripTerminalEscapes(dropFaintText("❯ \u001b[38;2;255;0;0mred\u001b[0m"))).toBe("❯ red");
	});
});

describe("selectPeekPane", () => {
	const panes = [
		pane({ index: 1, paneId: "%1", focused: false }),
		pane({ index: 2, paneId: "%2", focused: true }),
	];

	it("defaults to the focused pane, falling back to the first when none is focused", () => {
		expect(selectPeekPane(panes)?.paneId).toBe("%2");
		expect(selectPeekPane(panes.map((p) => ({ ...p, focused: false })))?.paneId).toBe("%1");
	});

	it("accepts the printed 1-based index or a raw pane id, and returns null for anything unknown", () => {
		expect(selectPeekPane(panes, "1")?.paneId).toBe("%1");
		expect(selectPeekPane(panes, "%2")?.index).toBe(2);
		expect(selectPeekPane(panes, "9")).toBeNull();
		expect(selectPeekPane(panes, "%99")).toBeNull();
		expect(selectPeekPane([], "1")).toBeNull();
	});
});
