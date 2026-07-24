import { describe, it, expect } from "vitest";
import {
	encodeResizeSequence,
	isResizeSequence,
	parseResizeSequence,
	smallestClientSize,
	RESIZE_SEQUENCE_PREFIX,
} from "../../shared/resize-protocol";

// The single shared definition of the renderer↔pty-server resize wire format.
// The literal expectations below pin the format itself: changing either side
// unilaterally must fail here, not at runtime.

describe("resize protocol", () => {
	it("encodes the documented wire format", () => {
		expect(encodeResizeSequence(120, 40)).toBe("\x1b]resize;120;40\x07");
		expect(RESIZE_SEQUENCE_PREFIX).toBe("\x1b]resize;");
	});

	it("round-trips encode → parse", () => {
		expect(parseResizeSequence(encodeResizeSequence(220, 51))).toEqual({ cols: 220, rows: 51 });
	});

	it("isResizeSequence detects only resize reports", () => {
		expect(isResizeSequence(encodeResizeSequence(1, 1))).toBe(true);
		expect(isResizeSequence("plain keyboard input")).toBe(false);
		expect(isResizeSequence("\x1b]52;c;xyz\x07")).toBe(false);
	});

	it("parse returns null for malformed sequences (caller still swallows them)", () => {
		expect(parseResizeSequence("\x1b]resize;12;\x07")).toBeNull();
		expect(parseResizeSequence("\x1b]resize;a;b\x07")).toBeNull();
		expect(parseResizeSequence("\x1b]resize;12;34")).toBeNull();
	});
});

// Multi-window / multi-client resize: the shared PTY must be sized to the
// SMALLEST viewer so two app windows of different sizes on the same task
// don't flip-flop the geometry (last-write-wins). Mirrors tmux multi-client.
describe("smallestClientSize", () => {
	it("returns null when no client has reported a size", () => {
		expect(smallestClientSize([])).toBeNull();
		expect(smallestClientSize([{}, {}])).toBeNull();
	});

	it("returns the single client's size", () => {
		expect(smallestClientSize([{ cols: 120, rows: 40 }])).toEqual({ cols: 120, rows: 40 });
	});

	it("takes the min of cols and rows independently across clients", () => {
		// Window A is wide+short, window B is narrow+tall — the PTY must fit
		// inside both, so min width AND min height taken separately.
		expect(
			smallestClientSize([
				{ cols: 200, rows: 30 },
				{ cols: 100, rows: 50 },
			]),
		).toEqual({ cols: 100, rows: 30 });
	});

	it("ignores clients that have not reported a size yet", () => {
		// A freshly-connected window (no size) must not shrink everyone.
		expect(smallestClientSize([{ cols: 150, rows: 45 }, {}, { rows: 60 }])).toEqual({ cols: 150, rows: 45 });
	});

	it("ignores non-positive sizes", () => {
		expect(smallestClientSize([{ cols: 0, rows: 0 }, { cols: 80, rows: 24 }])).toEqual({ cols: 80, rows: 24 });
	});
});
