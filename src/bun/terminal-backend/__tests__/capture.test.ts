/**
 * The pure shaping rules of a read-only pane capture (seq 1412).
 *
 * These are the invariants both adapters inherit rather than re-implement, so
 * they are asserted once, here, without a backend: the content boundary, the
 * fixed order of loss, UTF-8 accounting, freshness, and the identity bracket.
 */

import { describe, expect, it } from "vitest";
import {
	boundCaptureLines,
	lastChangeAge,
	captureIncarnation,
	clampHistoryLines,
	clampMaxBytes,
	knownFact,
	paneCaptureMiss,
	paneIdentityDrift,
	sanitizeCaptureLine,
	TERMINAL_CAPTURE_DEFAULT_HISTORY_LINES,
	TERMINAL_CAPTURE_MAX_BYTES,
	TERMINAL_CAPTURE_MAX_HISTORY_LINES,
	unknownFact,
	type TerminalPaneCaptureIdentity,
} from "../capture";

const identity = (over: Partial<TerminalPaneCaptureIdentity> = {}): TerminalPaneCaptureIdentity => ({
	backend: "tmux",
	sessionId: "task-alpha",
	viewId: "%0",
	incarnation: knownFact("abc"),
	epoch: knownFact("gen-1"),
	...over,
});

describe("capture content boundary", () => {
	it("strips colours, cursor moves, and every OSC payload", () => {
		expect(sanitizeCaptureLine("\u001B[31mred\u001B[0m")).toBe("red");
		expect(sanitizeCaptureLine("a\u001B[2Kb")).toBe("ab");
		// The three OSC payloads that would leak real secrets or targets.
		expect(sanitizeCaptureLine("x\u001B]0;my-private-title\u0007y")).toBe("xy");
		expect(sanitizeCaptureLine("x\u001B]52;c;c2VjcmV0\u0007y")).toBe("xy"); // clipboard
		expect(sanitizeCaptureLine("\u001B]8;;https://token@host/secret\u0007link")).toBe("link");
	});

	it("strips control bytes and C1, and trims only the trailing padding", () => {
		expect(sanitizeCaptureLine("a\tb\rc\u0000d")).toBe("abcd");
		expect(sanitizeCaptureLine("  indented  ")).toBe("  indented");
	});

	it("keeps wide glyphs, combining marks, and emoji intact", () => {
		expect(sanitizeCaptureLine("日本語 café 🎉")).toBe("日本語 café 🎉");
	});
});

describe("capture request clamping", () => {
	it("defaults to the visible screen and refuses to exceed the ceilings", () => {
		expect(clampHistoryLines(undefined)).toBe(TERMINAL_CAPTURE_DEFAULT_HISTORY_LINES);
		expect(clampHistoryLines(50)).toBe(50);
		expect(clampHistoryLines(-10)).toBe(0);
		expect(clampHistoryLines(10_000)).toBe(TERMINAL_CAPTURE_MAX_HISTORY_LINES);
		expect(clampMaxBytes(1024)).toBe(1024);
		expect(clampMaxBytes(10 * TERMINAL_CAPTURE_MAX_BYTES)).toBe(TERMINAL_CAPTURE_MAX_BYTES);
		// A non-integer is not a budget; fall back to the default rather than NaN.
		expect(clampMaxBytes(12.5)).toBe(clampMaxBytes(undefined));
	});
});

describe("capture bounds", () => {
	const raw = {
		viewport: ["screen-1", "screen-2"],
		history: ["old-1", "old-2", "old-3", "old-4"],
		historyAvailable: 9,
	};

	it("returns the visible screen only when no history was asked for", () => {
		const bounded = boundCaptureLines(raw, { historyLines: 0, maxBytes: 4096 });
		expect(bounded.content.viewport).toEqual(["screen-1", "screen-2"]);
		expect(bounded.content.history).toEqual([]);
		expect(bounded.content.lineModel).toBe("physical-rows");
	});

	it("keeps the NEWEST history when the line budget is smaller than the history", () => {
		const bounded = boundCaptureLines(raw, { historyLines: 2, maxBytes: 4096 });
		expect(bounded.content.history).toEqual(["old-3", "old-4"]);
		expect(bounded.bounds.historyLinesReturned).toBe(2);
		expect(bounded.bounds.historyLinesAvailable).toEqual({ known: true, value: 9 });
		expect(bounded.bounds.historyLinesOmitted).toEqual({ known: true, value: 7 });
		expect(bounded.issues).toContainEqual({
			code: "history-truncated",
			detail: "7 older history row(s) were left out of this capture",
		});
	});

	it("reports history the BACKEND already truncated, not just what the seam cut", () => {
		// All four rows fit the line budget, yet the backend holds nine.
		const bounded = boundCaptureLines(raw, { historyLines: 100, maxBytes: 4096 });
		expect(bounded.content.history).toHaveLength(4);
		expect(bounded.bounds.historyLinesOmitted).toEqual({ known: true, value: 5 });
		expect(bounded.issues.map((issue) => issue.code)).toContain("history-truncated");
	});

	it("says it does not know the depth when the backend cannot report one", () => {
		const bounded = boundCaptureLines(
			{ viewport: ["a"], history: ["h"] },
			{ historyLines: 10, maxBytes: 4096 },
		);
		expect(bounded.bounds.historyLinesAvailable.known).toBe(false);
		expect(bounded.bounds.historyLinesOmitted.known).toBe(false);
		// Nothing was actually dropped, so there is no truncation issue either.
		expect(bounded.issues).toEqual([]);
	});

	it("spends the byte budget on history FIRST, oldest end first", () => {
		const bounded = boundCaptureLines(raw, { historyLines: 4, maxBytes: 30 });
		expect(bounded.content.viewport).toEqual(["screen-1", "screen-2"]);
		expect(bounded.content.history).toEqual(["old-3", "old-4"]);
		expect(bounded.bounds.bytesReturned).toBeLessThanOrEqual(30);
	});

	it("cuts the viewport's TOP rows last, and never without saying so", () => {
		const tall = { viewport: ["row-1", "row-2", "row-3"], history: ["old"], historyAvailable: 1 };
		const bounded = boundCaptureLines(tall, { historyLines: 4, maxBytes: 12 });
		// Newest output survives; the oldest rows are the ones that go.
		// "row-2\nrow-3" is 11 bytes, so exactly one row has to go.
		expect(bounded.content.viewport).toEqual(["row-2", "row-3"]);
		expect(bounded.content.history).toEqual([]);
		expect(bounded.bounds.viewportRowsOmitted).toBe(1);
		expect(bounded.issues.map((issue) => issue.code)).toEqual([
			"history-truncated",
			"viewport-truncated",
		]);
	});

	it("measures UTF-8 bytes, not UTF-16 units, and never splits a row", () => {
		// Each row is 3 characters but 9 UTF-8 bytes.
		const wide = { viewport: ["日本語", "中文字", "한국어"], history: [] };
		const bounded = boundCaptureLines(wide, { historyLines: 0, maxBytes: 20 });
		expect(bounded.bounds.bytesReturned).toBe(19); // two rows of 9 + one separator
		expect(bounded.content.viewport).toEqual(["中文字", "한국어"]);
		// Every returned row is a whole row: no half characters, no partial lines.
		for (const row of bounded.content.viewport) expect(row).toHaveLength(3);
	});

	it("treats a genuinely blank pane as a successful empty capture", () => {
		const bounded = boundCaptureLines({ viewport: [], history: [], historyAvailable: 0 }, {
			historyLines: 10,
			maxBytes: 4096,
		});
		expect(bounded.content.viewport).toEqual([]);
		expect(bounded.bounds.bytesReturned).toBe(0);
		expect(bounded.issues).toEqual([]);
	});

	it("sanitizes before it measures, so escape bytes never eat the budget", () => {
		const noisy = { viewport: ["\u001B[31mab\u001B[0m"], history: [], historyAvailable: 0 };
		const bounded = boundCaptureLines(noisy, { historyLines: 0, maxBytes: 4096 });
		expect(bounded.content.viewport).toEqual(["ab"]);
		expect(bounded.bounds.bytesReturned).toBe(2);
	});
});

describe("last-change age", () => {
	it("is zero when the source changed at the moment of the read", () => {
		const now = "2026-08-03T10:00:00.000Z";
		expect(lastChangeAge(knownFact(now), now)).toEqual({ known: true, value: 0 });
	});

	it("is plain data with no verdict, however old it gets", () => {
		// The old contract called this "stale" past 5s. It was wrong: a quiet healthy
		// pane has an ancient last-change timestamp and a perfectly current screen.
		// Nothing here returns an issue, a threshold, or a judgement.
		const age = lastChangeAge(knownFact("2026-08-03T10:00:00.000Z"), "2026-08-03T11:00:00.000Z");
		expect(age).toEqual({ known: true, value: 3_600_000 });
	});

	it("never invents an age from an unknown or unparsable timestamp", () => {
		expect(lastChangeAge(unknownFact("no snapshot"), "2026-08-03T10:00:00.000Z").known).toBe(false);
		expect(lastChangeAge(knownFact("not-a-date"), "2026-08-03T10:00:00.000Z").known).toBe(false);
	});

	it("clamps a source clock that runs ahead of the read to zero, never negative", () => {
		expect(lastChangeAge(knownFact("2026-08-03T10:00:05.000Z"), "2026-08-03T10:00:00.000Z")).toEqual({
			known: true,
			value: 0,
		});
	});
});

describe("capture identity", () => {
	it("is opaque: the inputs do not appear in the digest", () => {
		const digest = captureIncarnation("session-x", 4242, 4243);
		expect(digest).toMatch(/^[0-9a-f]{16}$/);
		expect(digest).not.toContain("4242");
		expect(digest).not.toContain("session-x");
	});

	it("is stable for the same pane and different for a replacement", () => {
		expect(captureIncarnation("s", 1, 2)).toBe(captureIncarnation("s", 1, 2));
		expect(captureIncarnation("s", 1, 2)).not.toBe(captureIncarnation("s", 1, 3));
		// Field boundaries cannot be smeared: (1,23) is not (12,3).
		expect(captureIncarnation("s", 1, 23)).not.toBe(captureIncarnation("s", 12, 3));
	});

	it("detects a pane or a pane set replaced between the two checks", () => {
		expect(paneIdentityDrift(identity(), identity())).toBeNull();
		expect(paneIdentityDrift(identity(), identity({ incarnation: knownFact("zzz") }))).toContain(
			"incarnation changed",
		);
		expect(paneIdentityDrift(identity(), identity({ epoch: knownFact("gen-2") }))).toContain(
			"epoch changed",
		);
	});

	it("does not call drift on a field that was never known", () => {
		const blind = identity({ epoch: unknownFact("this backend publishes no generation") });
		expect(paneIdentityDrift(blind, blind)).toBeNull();
		expect(paneIdentityDrift(blind, identity({ epoch: knownFact("gen-9") }))).toBeNull();
	});
});

describe("capture misses", () => {
	it("carry identity, a readable reason, and a timestamp — but never content", () => {
		const miss = paneCaptureMiss(identity(), "not-enabled", "this host runs no parser", "live");
		expect(miss.availability).toBe("not-enabled");
		expect(miss.reason).toBe("this host runs no parser");
		expect(miss.liveness).toBe("live");
		expect(Date.parse(miss.readAt)).not.toBeNaN();
		expect(miss).not.toHaveProperty("content");
	});

	it("default to unknown liveness rather than guessing the pane is alive", () => {
		expect(paneCaptureMiss(identity(), "session-absent", "gone").liveness).toBe("unknown");
	});
});
