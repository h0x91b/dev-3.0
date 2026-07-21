import { describe, expect, it } from "vitest";
import type { RawSessionJournal } from "../session-journal";
import { verifyJournal } from "../verify-journal";

const ESC = "\x1b";

function syntheticJournal(): RawSessionJournal {
	return {
		schema: "dev3-windows-session-journal",
		version: 1,
		target: "synthetic-agent",
		kind: "agent",
		initial: { cols: 80, rows: 24, scrollback: 1000 },
		finalDimensions: { cols: 100, rows: 30 },
		detachIndex: 2,
		events: [
			{
				type: "output",
				encoding: "utf8",
				data:
					`${ESC}]0;verify probe${ESC}\\${ESC}[2J${ESC}[H` +
					`${ESC}[38;2;80;160;240mHELLO${ESC}[0m\r\n` +
					`wide=界 emoji=🙂\r\n`,
			},
			{ type: "resize", cols: 100, rows: 30 },
			{ type: "output", encoding: "utf8", data: `${ESC}[31mafter-detach${ESC}[0m\r\n` },
		],
		responderReplies: 4,
		queryCounts: { DA1: 1, "DSR-cursor": 3 },
		provenance: {
			command: "synthetic",
			platform: "test-runtime",
			capturedAt: "2026-07-22",
			exitCode: 0,
		},
	};
}

describe("verifyJournal", () => {
	it("proves a detach-boundary roundtrip matches and reports coverage", async () => {
		const verdict = await verifyJournal(syntheticJournal());

		expect(verdict.matchesAtDetach).toBe(true);
		expect(verdict.matchesAfterReplay).toBe(true);
		expect(verdict.detachEvents).toBe(2);
		expect(verdict.afterReplayEvents).toBe(1);
		expect(verdict.coverage.colors).toBe(true);
		expect(verdict.coverage.unicode).toBe(true);
		expect(verdict.coverage.finalDimensions).toEqual({ cols: 100, rows: 30 });
	});
});
