import { describe, it, expect, vi } from "vitest";
import type { Terminal } from "ghostty-web";
import { installTerminalRefHover } from "../terminal-ref-hover";

function fakeTerm() {
	const canvas = { getBoundingClientRect: () => ({ left: 100, top: 50, right: 900, bottom: 450, width: 800, height: 400 }) };
	return {
		cols: 80, rows: 20, viewportY: 0,
		buffer: { active: { length: 20 } },
		renderer: { getCanvas: () => canvas, charWidth: 10, charHeight: 20 },
		onScroll: () => ({ dispose() {} }),
	} as unknown as Terminal;
}

describe("installTerminalRefHover", () => {
	it("reports the hovered reference with its cell, once, and null when the pointer leaves it", () => {
		const frames: FrameRequestCallback[] = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
		const container = document.createElement("div");
		const onChange = vi.fn();
		const handle = installTerminalRefHover({
			term: fakeTerm(),
			container,
			refAt: (y, x) => (y === 1 && x >= 3 && x <= 11 ? "<seq:115>" : undefined),
			onChange,
		});
		const move = (col: number, row: number) => {
			container.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 + col * 10 + 5, clientY: 50 + row * 20 + 5 }));
			frames.splice(0).forEach((cb) => cb(0));
		};

		move(4, 1);
		move(5, 1);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0][0]).toEqual({ uri: "<seq:115>", anchor: { top: 70, left: 140, right: 150, bottom: 90, width: 10, height: 20 } });
		move(20, 1);
		expect(onChange).toHaveBeenLastCalledWith(null);
		move(4, 1);
		container.dispatchEvent(new MouseEvent("mouseleave"));
		expect(onChange).toHaveBeenLastCalledWith(null);
		handle.dispose();
	});
});
