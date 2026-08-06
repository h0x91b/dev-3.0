import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFilePathUnderlines, viewportRowToAbsolute } from "../terminal-link-underlines";

describe("viewportRowToAbsolute", () => {
	it("maps rows at the bottom of scrollback (not scrolled)", () => {
		// 100 scrollback lines, viewport at bottom: row 0 = screen row 0 = absolute 100.
		expect(viewportRowToAbsolute(0, 0, 100)).toBe(100);
		expect(viewportRowToAbsolute(5, 0, 100)).toBe(105);
	});

	it("maps rows while scrolled up into scrollback", () => {
		// Scrolled up 10: top 10 viewport rows show scrollback lines 90..99.
		expect(viewportRowToAbsolute(0, 10, 100)).toBe(90);
		expect(viewportRowToAbsolute(9, 10, 100)).toBe(99);
		// Rows below the scrollback window show the screen from its top.
		expect(viewportRowToAbsolute(10, 10, 100)).toBe(100);
		expect(viewportRowToAbsolute(15, 10, 100)).toBe(105);
	});

	it("ignores fractional smooth-scroll offsets like the click handler does", () => {
		expect(viewportRowToAbsolute(0, 10.7, 100)).toBe(90);
	});

	it("handles an empty scrollback", () => {
		expect(viewportRowToAbsolute(3, 0, 0)).toBe(3);
	});
});

describe("installFilePathUnderlines redraw scheduling", () => {
	let ops: string[];
	let frames: FrameRequestCallback[];
	let getContextSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		ops = [];
		frames = [];
		const ctx = {
			setTransform: () => ops.push("setTransform"),
			clearRect: () => ops.push("clearRect"),
			beginPath: () => ops.push("beginPath"),
			moveTo: () => ops.push("moveTo"),
			lineTo: () => ops.push("lineTo"),
			stroke: () => ops.push("stroke"),
			strokeStyle: "",
			lineWidth: 0,
		};
		getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
		vi.stubGlobal("cancelAnimationFrame", () => {});
	});

	afterEach(() => {
		getContextSpy.mockRestore();
		vi.unstubAllGlobals();
	});

	/** Run every frame callback queued so far, the way the browser would. */
	function flushFrames(): void {
		const queued = frames;
		frames = [];
		for (const cb of queued) cb(0);
	}

	function install(linksForRows = () => [{ start: { x: 2, y: 0 }, end: { x: 9, y: 0 } }]) {
		const container = document.createElement("div");
		const termCanvas = document.createElement("canvas");
		container.appendChild(termCanvas);
		document.body.appendChild(container);
		const term = {
			renderer: { charWidth: 9, charHeight: 17 },
			buffer: { active: { length: 24 } },
			rows: 24,
			cols: 80,
			viewportY: 0,
			onScroll: () => ({ dispose: () => {} }),
		} as never;
		return installFilePathUnderlines({ term, container, linksForRows });
	}

	it("coalesces a burst of triggers into one repaint per frame", () => {
		const handle = install();
		flushFrames(); // the install-time redraw
		ops.length = 0;
		for (let i = 0; i < 12; i++) handle.requestRedraw();
		flushFrames();
		expect(ops.filter((op) => op === "clearRect")).toHaveLength(1);
		handle.dispose();
	});

	it("keeps repainting under a sustained stream of triggers", () => {
		// A debounce here starved: writes arriving faster than its delay pushed
		// the recompute out forever, so the overlay stayed blank for the whole
		// burst and blinked at the rate of an agent's spinner.
		const handle = install();
		let strokes = 0;
		for (let i = 0; i < 10; i++) {
			handle.requestRedraw();
			flushFrames();
			strokes += ops.filter((op) => op === "stroke").length;
			ops.length = 0;
		}
		expect(strokes).toBe(10);
		handle.dispose();
	});

	it("never leaves the overlay cleared without restroking in the same pass", () => {
		const handle = install();
		handle.requestRedraw();
		flushFrames();
		expect(ops.lastIndexOf("stroke")).toBeGreaterThan(ops.lastIndexOf("clearRect"));
		handle.dispose();
	});

	it("clears the overlay when the renderer has no metrics to draw against", () => {
		const container = document.createElement("div");
		container.appendChild(document.createElement("canvas"));
		document.body.appendChild(container);
		const term = {
			renderer: { charWidth: 0, charHeight: 0 },
			buffer: { active: { length: 24 } },
			rows: 24,
			cols: 80,
			viewportY: 0,
			onScroll: () => ({ dispose: () => {} }),
		} as never;
		const handle = installFilePathUnderlines({
			term,
			container,
			linksForRows: () => [{ start: { x: 0, y: 0 }, end: { x: 5, y: 0 } }],
		});
		flushFrames();
		expect(ops).toContain("clearRect");
		expect(ops).not.toContain("stroke");
		handle.dispose();
	});
});
