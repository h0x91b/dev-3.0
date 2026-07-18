import { describe, it, expect } from "vitest";
import {
	encodeResizeSequence,
	isResizeSequence,
	parseResizeSequence,
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
