import { describe, expect, it } from "vitest";
import {
	isRawSessionJournal,
	journalOutputByteLength,
	journalToFixture,
	splitAtDetach,
	type RawSessionJournal,
} from "../session-journal";

function sample(): RawSessionJournal {
	return {
		schema: "dev3-windows-session-journal",
		version: 1,
		target: "claude",
		kind: "agent",
		initial: { cols: 80, rows: 24, scrollback: 1000 },
		finalDimensions: { cols: 100, rows: 30 },
		detachIndex: 2,
		events: [
			{ type: "output", encoding: "utf8", data: "boot" },
			{ type: "resize", cols: 100, rows: 30 },
			{ type: "output", encoding: "utf8", data: "after" },
		],
		responderReplies: 3,
		queryCounts: { DA1: 1, "DSR-cursor": 2 },
		provenance: {
			command: "claude",
			platform: "Windows 10.0.19045 x86_64; Bun 1.3.14",
			capturedAt: "2026-07-22",
			exitCode: 0,
		},
	};
}

describe("session-journal helpers", () => {
	it("recognizes a raw session journal", () => {
		expect(isRawSessionJournal(sample())).toBe(true);
		expect(isRawSessionJournal({ schema: "other" })).toBe(false);
	});

	it("splits events at the detach boundary", () => {
		const { events, afterReplay } = splitAtDetach(sample());
		expect(events).toHaveLength(2);
		expect(afterReplay).toHaveLength(1);
		expect(afterReplay[0]).toEqual({ type: "output", encoding: "utf8", data: "after" });
	});

	it("converts a journal into a harness fixture with a post-detach section", () => {
		const fixture = journalToFixture(sample(), "real-claude", {
			expected: { activeBuffer: "normal" },
			expectedAfterReplay: { dimensions: { cols: 100, rows: 30 } },
		});
		expect(fixture.name).toBe("real-claude");
		expect(fixture.source).toBe("captured");
		expect(fixture.events).toHaveLength(2);
		expect(fixture.afterReplay).toHaveLength(1);
		expect(fixture.provenance?.platform).toContain("Windows");
	});

	it("counts decoded output bytes across encodings", () => {
		expect(journalOutputByteLength(sample())).toBe("boot".length + "after".length);
	});
});
