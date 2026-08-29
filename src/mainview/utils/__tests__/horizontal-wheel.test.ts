import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { installHorizontalWheelBridge, resolveHorizontalWheelTarget } from "../horizontal-wheel";

/** happy-dom reports zero for every layout box, so scroll metrics are stubbed. */
function sized(el: HTMLElement, m: { sw?: number; cw?: number; sh?: number; ch?: number }) {
	Object.defineProperty(el, "scrollWidth", { value: m.sw ?? 0, configurable: true });
	Object.defineProperty(el, "clientWidth", { value: m.cw ?? 0, configurable: true });
	Object.defineProperty(el, "scrollHeight", { value: m.sh ?? 0, configurable: true });
	Object.defineProperty(el, "clientHeight", { value: m.ch ?? 0, configurable: true });
	return el;
}

function make(overflowX: string, overflowY: string, m: Parameters<typeof sized>[1]) {
	const el = document.createElement("div");
	el.style.overflowX = overflowX;
	el.style.overflowY = overflowY;
	document.body.appendChild(el);
	return sized(el, m);
}

beforeEach(() => {
	document.body.innerHTML = "";
	sized(document.body, { sw: 100, cw: 100, sh: 100, ch: 100 });
	sized(document.documentElement, { sw: 100, cw: 100, sh: 100, ch: 100 });
});

describe("resolveHorizontalWheelTarget", () => {
	it("hands a vertical delta to a horizontal-only container — the Kanban board", () => {
		// overflow-x-auto + overflow-y-hidden, 572px of columns off-screen.
		const board = make("auto", "hidden", { sw: 2172, cw: 1600, sh: 876, ch: 876 });
		const card = document.createElement("div");
		board.appendChild(sized(card, {}));

		expect(resolveHorizontalWheelTarget(card, 120)).toBe(board);
	});

	it("refuses when an ancestor can scroll vertically — a wide code block inside the diff", () => {
		const diff = make("auto", "auto", { sw: 1001, cw: 1001, sh: 7601, ch: 803 });
		const pre = document.createElement("pre");
		pre.style.overflowX = "auto";
		pre.style.overflowY = "hidden";
		diff.appendChild(sized(pre, { sw: 2616, cw: 860, sh: 39, ch: 39 }));

		// The pre is horizontal-only, but the diff behind it owns the wheel.
		expect(resolveHorizontalWheelTarget(pre, 120)).toBeNull();
	});

	it("refuses when the horizontal container is already at that edge", () => {
		const strip = make("auto", "hidden", { sw: 900, cw: 500, sh: 40, ch: 40 });
		strip.scrollLeft = 400;
		expect(resolveHorizontalWheelTarget(strip, 120)).toBeNull();
		expect(resolveHorizontalWheelTarget(strip, -120)).toBe(strip);
	});

	it("refuses a container whose overflow-x is hidden even when the content is wider", () => {
		const clipped = make("hidden", "hidden", { sw: 2000, cw: 500, sh: 40, ch: 40 });
		expect(resolveHorizontalWheelTarget(clipped, 120)).toBeNull();
	});

	it("lets an opted-in strip win over a scrolling page — the contribution heatmap", () => {
		const page = make("hidden", "auto", { sw: 1600, cw: 1600, sh: 2800, ch: 917 });
		const heatmap = document.createElement("div");
		heatmap.setAttribute("data-wheel-x", "");
		heatmap.style.overflowX = "auto";
		heatmap.style.overflowY = "hidden";
		page.appendChild(sized(heatmap, { sw: 1400, cw: 900, sh: 137, ch: 137 }));

		expect(resolveHorizontalWheelTarget(heatmap, 120)).toBe(heatmap);
	});

	it("still gives the page the wheel when the opted-in strip has no room left", () => {
		const page = make("hidden", "auto", { sw: 1600, cw: 1600, sh: 2800, ch: 917 });
		const strip = document.createElement("div");
		strip.setAttribute("data-wheel-x", "");
		strip.style.overflowX = "auto";
		strip.style.overflowY = "hidden";
		page.appendChild(sized(strip, { sw: 1400, cw: 900, sh: 137, ch: 137 }));
		strip.scrollLeft = 500;

		expect(resolveHorizontalWheelTarget(strip, 120)).toBeNull();
	});

	it("returns null when nothing scrolls at all", () => {
		const plain = make("visible", "visible", { sw: 500, cw: 500, sh: 40, ch: 40 });
		expect(resolveHorizontalWheelTarget(plain, 120)).toBeNull();
	});
});

describe("installHorizontalWheelBridge", () => {
	let teardown: () => void;
	afterEach(() => teardown?.());

	/** happy-dom's WheelEvent silently drops `ctrlKey`, so it is defined by hand. */
	function wheel(target: Element, init: WheelEventInit & { ctrlKey?: boolean }) {
		const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
		Object.defineProperty(e, "ctrlKey", { value: !!init.ctrlKey, configurable: true });
		target.dispatchEvent(e);
		return e;
	}

	it("scrolls the board sideways by the vertical delta and consumes the event", () => {
		const board = make("auto", "hidden", { sw: 2172, cw: 1600, sh: 876, ch: 876 });
		teardown = installHorizontalWheelBridge();

		const e = wheel(board, { deltaX: 0, deltaY: 120 });

		expect(board.scrollLeft).toBe(120);
		expect(e.defaultPrevented).toBe(true);
	});

	it("leaves a horizontal delta alone — the trackpad path is untouched", () => {
		const board = make("auto", "hidden", { sw: 2172, cw: 1600, sh: 876, ch: 876 });
		teardown = installHorizontalWheelBridge();

		const e = wheel(board, { deltaX: 120, deltaY: 0 });

		expect(board.scrollLeft).toBe(0);
		expect(e.defaultPrevented).toBe(false);
	});

	it("leaves ctrl+wheel alone so pinch-zoom keeps working", () => {
		const board = make("auto", "hidden", { sw: 2172, cw: 1600, sh: 876, ch: 876 });
		teardown = installHorizontalWheelBridge();

		const e = wheel(board, { deltaX: 0, deltaY: 120, ctrlKey: true });

		expect(board.scrollLeft).toBe(0);
		expect(e.defaultPrevented).toBe(false);
	});

	it("stops listening after teardown", () => {
		const board = make("auto", "hidden", { sw: 2172, cw: 1600, sh: 876, ch: 876 });
		teardown = installHorizontalWheelBridge();
		teardown();

		wheel(board, { deltaX: 0, deltaY: 120 });

		expect(board.scrollLeft).toBe(0);
	});
});
