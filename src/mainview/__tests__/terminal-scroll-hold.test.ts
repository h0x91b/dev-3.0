import { init, Terminal } from "ghostty-web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recordingCtx } from "../terminal-bidi/__tests__/fixtures";
import { writeHoldingViewport } from "../terminal-scroll-hold";

beforeAll(() => init());

beforeEach(() => {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(recordingCtx().ctx as never);
	vi.stubGlobal("requestAnimationFrame", () => 1);
	vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

function filledTerminal(): Terminal {
	const term = new Terminal({ rows: 10, cols: 40, scrollback: 50_000_000 });
	term.open(document.body.appendChild(document.createElement("div")));
	for (let i = 0; i < 100; i++) term.write(`line ${i}\r\n`);
	return term;
}

function topRow(term: Terminal): string | undefined {
	const buffer = term.buffer.active;
	return buffer.getLine(buffer.length - term.rows - Math.floor(term.getViewportY()))?.translateToString(true);
}

describe("writeHoldingViewport", () => {
	// Guards the ghostty-web behaviour this wrapper depends on; if it fails after an upgrade, the wrapper may be unneeded.
	it("works around ghostty's snap to live output on a plain write", () => {
		const term = filledTerminal();
		term.scrollToLine(30);
		term.write("\rspinner");
		expect(term.getViewportY()).toBe(0);
	});

	it("keeps the same rows on screen while output arrives", () => {
		const term = filledTerminal();
		term.scrollToLine(30);
		const before = topRow(term);
		writeHoldingViewport(term, "\rspinner");
		expect(term.getViewportY()).toBe(30);
		writeHoldingViewport(term, "more 1\r\nmore 2\r\nmore 3\r\n");
		expect(term.getViewportY()).toBe(33);
		expect(topRow(term)).toBe(before);
	});

	it("follows live output when the view is at the bottom", () => {
		const term = filledTerminal();
		writeHoldingViewport(term, "more\r\n");
		expect(term.getViewportY()).toBe(0);
	});

	it("stays with live output when a write clears the scrollback", () => {
		const term = filledTerminal();
		term.scrollToLine(30);
		writeHoldingViewport(term, "\x1b[2J\x1b[3J\x1b[H");
		writeHoldingViewport(term, Array.from({ length: 80 }, (_, i) => `redraw ${i}\r\n`).join(""));
		expect(term.getViewportY()).toBe(0);
	});

	it("stays with live output when one batch clears and redraws more than it cleared", () => {
		const term = filledTerminal();
		term.scrollToLine(30);
		writeHoldingViewport(term, "\x1b[2J\x1b[3J\x1b[H" + Array.from({ length: 200 }, (_, i) => `redraw ${i}\r\n`).join(""));
		expect(term.getViewportY()).toBe(0);
	});

	it("ignores a viewport left past the scrollback by a reset", () => {
		const term = filledTerminal();
		term.scrollToLine(30);
		term.reset();
		writeHoldingViewport(term, Array.from({ length: 200 }, (_, i) => `after ${i}\r\n`).join(""));
		expect(term.getViewportY()).toBe(0);
	});

	it("stays with live output when RIS and the redraw arrive in one write", () => {
		const term = filledTerminal();
		term.scrollToLine(30);
		writeHoldingViewport(term, "\x1bc" + Array.from({ length: 80 }, (_, i) => `redraw ${i}\r\n`).join(""));
		expect(term.getViewportY()).toBe(0);
	});

	it("does not snap to live output when a full scrollback prunes", () => {
		const term = new Terminal({ rows: 10, cols: 40, scrollback: 1000 });
		term.open(document.body.appendChild(document.createElement("div")));
		let length = 0;
		for (let i = 0; i < 2000 && length < 2300; i++) {
			term.write(`line ${i}\r\n`);
			length = term.getScrollbackLength();
		}
		term.scrollToLine(100);
		let pruned = false;
		for (let i = 0; i < 2000 && !pruned; i++) {
			const before = term.getScrollbackLength();
			writeHoldingViewport(term, `more ${i}\r\n`);
			pruned = term.getScrollbackLength() < before;
		}
		expect(pruned).toBe(true);
		expect(term.getViewportY()).toBeGreaterThan(0);
	});
});
