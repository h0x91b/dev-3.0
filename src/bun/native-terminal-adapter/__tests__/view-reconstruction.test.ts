import { describe, expect, it } from "vitest";
import type { NativeSemanticLine, NativeSemanticState } from "../../native-terminal-registry/ghostty-live";
import {
	PARSER_STATE_SCHEMA,
	PARSER_STATE_VERSION,
	type ParserStateSnapshot,
} from "../../native-terminal-registry/parser-state";
import { LIVE_PARSER_ID } from "../../native-terminal-registry/ghostty-live";
import { MonotonicSnapshotView, renderSnapshotText } from "../view-reconstruction";

function line(text: string): NativeSemanticLine {
	return { text, wrapped: null, cells: [] };
}

function semanticState(screen: string[], scrollback: string[] = []): NativeSemanticState {
	return {
		activeBuffer: "normal",
		title: "",
		dimensions: { cols: 80, rows: screen.length },
		cursor: { x: 0, y: 0, visible: true, style: "block", blink: false },
		modes: {
			applicationCursorKeys: false,
			applicationKeypad: false,
			bracketedPaste: false,
			focusEvents: false,
			insert: false,
			mouseTracking: "none",
			origin: false,
			reverseWraparound: false,
			synchronizedOutput: false,
			wraparound: true,
		},
		screen: screen.map(line),
		scrollback: scrollback.map(line),
		scrollbackLength: scrollback.length,
	};
}

function snapshot(watermarkSeq: number, state: NativeSemanticState | null): ParserStateSnapshot {
	return {
		schema: PARSER_STATE_SCHEMA,
		version: PARSER_STATE_VERSION,
		parser: LIVE_PARSER_ID,
		sessionId: "alpha",
		watermarkSeq,
		health: { status: "live", overflow: { droppedChunks: 0, droppedBytes: 0, droppedResizes: 0 } },
		ingested: { frames: 0, bytes: 0, resizes: 0, replies: 0 },
		latency: { drains: 0, totalMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 },
		memory: { rssBytes: 0, heapUsedBytes: 0 },
		state,
		updatedAt: "2026-07-24T00:00:00.000Z",
	};
}

describe("renderSnapshotText", () => {
	it("renders the visible screen and drops trailing blank rows", () => {
		const text = renderSnapshotText(semanticState(["hello", "world", "", ""]), false);
		expect(text).toBe("hello\nworld");
	});

	it("prepends capped scrollback (oldest first) when history is requested", () => {
		const state = semanticState(["screen-1", "screen-2"], ["old-1", "old-2"]);
		expect(renderSnapshotText(state, true)).toBe("old-1\nold-2\nscreen-1\nscreen-2");
		expect(renderSnapshotText(state, false)).toBe("screen-1\nscreen-2");
	});
});

describe("MonotonicSnapshotView", () => {
	it("returns null until the parser has emitted a state", () => {
		const view = new MonotonicSnapshotView("alpha", () => null);
		expect(view.capture(true)).toBeNull();
		expect(view.watermark).toBe(-1);
	});

	it("renders the current bounded snapshot and advances the watermark", () => {
		let current = snapshot(5, semanticState(["line-a"]));
		const view = new MonotonicSnapshotView("alpha", () => current);
		expect(view.capture(false)).toBe("line-a");
		expect(view.watermark).toBe(5);
		current = snapshot(9, semanticState(["line-a", "line-b"]));
		expect(view.capture(false)).toBe("line-a\nline-b");
		expect(view.watermark).toBe(9);
	});

	it("ignores a stale snapshot and returns the last good render (never rewinds)", () => {
		let current = snapshot(9, semanticState(["fresh-1", "fresh-2"]));
		const view = new MonotonicSnapshotView("alpha", () => current);
		expect(view.capture(false)).toBe("fresh-1\nfresh-2");
		// A snapshot with a lower watermark (e.g., a late duplicate) is ignored.
		current = snapshot(4, semanticState(["stale"]));
		expect(view.capture(false)).toBe("fresh-1\nfresh-2");
		expect(view.watermark).toBe(9);
	});

	it("keeps a null-state snapshot from clobbering a prior good render", () => {
		let current: ParserStateSnapshot = snapshot(3, semanticState(["good"]));
		const view = new MonotonicSnapshotView("alpha", () => current);
		expect(view.capture(false)).toBe("good");
		current = snapshot(7, null); // parser overflowed/failed after — state null
		expect(view.capture(false)).toBe("good");
	});
});
