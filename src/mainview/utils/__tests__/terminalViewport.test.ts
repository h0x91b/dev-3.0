import { describe, expect, it, vi } from "vitest";
import { writePreservingViewport } from "../terminalViewport";

function makeTerminal({
	viewportY,
	scrollbackBefore,
	scrollbackAfter,
	targetViewportY = viewportY,
}: {
	viewportY: number;
	scrollbackBefore: number;
	scrollbackAfter: number;
	targetViewportY?: number;
}) {
	let currentViewportY = viewportY;
	let scrollbackLength = scrollbackBefore;
	const scrollToLine = vi.fn((line: number) => {
		currentViewportY = Math.max(0, Math.min(scrollbackLength, line));
	});
	const terminal = {
		targetViewportY,
		getViewportY: vi.fn(() => currentViewportY),
		getScrollbackLength: vi.fn(() => scrollbackLength),
		write: vi.fn(() => {
			scrollbackLength = scrollbackAfter;
			// ghostty-web 0.4.0 currently forces every write back to the live bottom.
			currentViewportY = 0;
		}),
		scrollToLine,
	};
	return { terminal, scrollToLine };
}

describe("writePreservingViewport", () => {
	it("restores a scrolled viewport after ghostty jumps to the live bottom", () => {
		const { terminal, scrollToLine } = makeTerminal({
			viewportY: 18,
			scrollbackBefore: 100,
			scrollbackAfter: 100,
		});

		writePreservingViewport(terminal, "output");

		expect(terminal.write).toHaveBeenCalledWith("output");
		expect(scrollToLine).toHaveBeenCalledWith(18);
		expect(terminal.targetViewportY).toBe(18);
	});

	it("tracks scrollback growth so the same content stays visible", () => {
		const { terminal, scrollToLine } = makeTerminal({
			viewportY: 18,
			scrollbackBefore: 100,
			scrollbackAfter: 104,
			targetViewportY: 30,
		});

		writePreservingViewport(terminal, "more output");

		expect(scrollToLine).toHaveBeenCalledWith(22);
		// Cancel any in-flight smooth-scroll target that could move the viewport again.
		expect(terminal.targetViewportY).toBe(22);
	});

	it("keeps following output when the terminal was already at the live bottom", () => {
		const { terminal, scrollToLine } = makeTerminal({
			viewportY: 0,
			scrollbackBefore: 100,
			scrollbackAfter: 101,
		});

		writePreservingViewport(terminal, "live output");

		expect(terminal.write).toHaveBeenCalledWith("live output");
		expect(scrollToLine).not.toHaveBeenCalled();
		expect(terminal.getScrollbackLength).not.toHaveBeenCalled();
	});
});
