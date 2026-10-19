import { describe, it, expect } from "vitest";
import {
	encodeResizeSequence,
	encodeSizingNotice,
	encodeViewerSignal,
	isResizeSequence,
	isSizingNotice,
	isViewerSignal,
	parseResizeSequence,
	parseSizingNotice,
	parseViewerSignal,
	pickSizingViewer,
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

describe("viewer signal", () => {
	it("encodes the documented wire format", () => {
		expect(encodeViewerSignal("active")).toBe("\x1b]dev3viewer;active\x07");
		expect(encodeViewerSignal("hidden")).toBe("\x1b]dev3viewer;hidden\x07");
	});

	it("round-trips and is never mistaken for a resize report or input", () => {
		expect(parseViewerSignal(encodeViewerSignal("active"))).toBe("active");
		expect(parseViewerSignal(encodeViewerSignal("hidden"))).toBe("hidden");
		expect(isResizeSequence(encodeViewerSignal("active"))).toBe(false);
		expect(isViewerSignal(encodeResizeSequence(80, 24))).toBe(false);
		expect(isViewerSignal("plain keyboard input")).toBe(false);
	});

	it("parses an unknown signal to null (caller still swallows it)", () => {
		expect(isViewerSignal("\x1b]dev3viewer;bogus\x07")).toBe(true);
		expect(parseViewerSignal("\x1b]dev3viewer;bogus\x07")).toBeNull();
	});
});

describe("sizing notice", () => {
	it("encodes the documented wire format", () => {
		expect(encodeSizingNotice({ cols: 120, rows: 40, sizing: true })).toBe("\x1b]dev3sizing;120;40;1\x07");
		expect(encodeSizingNotice({ cols: 22, rows: 9, sizing: false })).toBe("\x1b]dev3sizing;22;9;0\x07");
	});

	it("round-trips and rejects anything else", () => {
		const notice = { cols: 132, rows: 43, sizing: false };
		expect(parseSizingNotice(encodeSizingNotice(notice))).toEqual(notice);
		expect(isSizingNotice(encodeSizingNotice(notice))).toBe(true);
		expect(isSizingNotice("terminal output")).toBe(false);
		expect(parseSizingNotice("\x1b]dev3sizing;1;2\x07")).toBeNull();
	});
});

// One shared PTY, several viewers: it follows the viewer used last (tmux's own
// `window-size latest`), never the smallest — a forgotten narrow tab must not
// clamp everyone (h0x91b/dev-3.0#2000).
describe("pickSizingViewer", () => {
	it("returns null when no viewer has reported a usable size", () => {
		expect(pickSizingViewer([])).toBeNull();
		expect(pickSizingViewer([{}, { activeAt: 3 }])).toBeNull();
		expect(pickSizingViewer([{ cols: 0, rows: 0, activeAt: 1 }])).toBeNull();
	});

	it("picks the most recently active viewer, not the smallest", () => {
		const wide = { cols: 200, rows: 50, activeAt: 7 };
		const narrow = { cols: 22, rows: 40, activeAt: 2 };
		expect(pickSizingViewer([narrow, wide])).toBe(wide);
		expect(pickSizingViewer([wide, { ...narrow, activeAt: 9 }])).toEqual({ ...narrow, activeAt: 9 });
	});

	it("ignores a hidden viewer while any visible one has a size", () => {
		const hidden = { cols: 22, rows: 40, activeAt: 9, hidden: true };
		const visible = { cols: 200, rows: 50, activeAt: 1 };
		expect(pickSizingViewer([hidden, visible])).toBe(visible);
	});

	it("falls back to the most recently active hidden viewer when all are hidden", () => {
		const older = { cols: 100, rows: 30, activeAt: 1, hidden: true };
		const newer = { cols: 80, rows: 24, activeAt: 4, hidden: true };
		expect(pickSizingViewer([older, newer])).toBe(newer);
	});

	it("keeps the earliest viewer on a tie, so connecting alone never takes over", () => {
		const first = { cols: 120, rows: 40 };
		const later = { cols: 60, rows: 20 };
		expect(pickSizingViewer([first, later])).toBe(first);
		const active = { cols: 120, rows: 40, activeAt: 5 };
		expect(pickSizingViewer([active, { cols: 60, rows: 20 }])).toBe(active);
	});

	it("never lets a viewer without a size win, however recent", () => {
		const sized = { cols: 150, rows: 45, activeAt: 1 };
		expect(pickSizingViewer([sized, { activeAt: 99 }, { rows: 60, activeAt: 98 }])).toBe(sized);
	});
});
