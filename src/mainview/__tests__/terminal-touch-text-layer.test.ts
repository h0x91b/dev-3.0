import { describe, it, expect, afterEach, vi } from "vitest";
import { installTouchTextLayer, terminalTextSelectionLive, type TouchTextLayerTerminal } from "../terminal-touch-text-layer";

function line(text: string) {
	return {
		isWrapped: false,
		length: text.length,
		getCell: (x: number) => ({ getCode: () => text.charCodeAt(x) || 0 }),
	};
}

function makeTerm(rows: string[], over: Partial<TouchTextLayerTerminal> = {}): TouchTextLayerTerminal {
	return {
		rows: rows.length,
		viewportY: 0,
		buffer: { active: { getLine: (y: number) => (rows[y] === undefined ? null : line(rows[y])) } },
		options: { fontSize: 14, fontFamily: "monospace" },
		renderer: { charWidth: 8, charHeight: 16 },
		wasmTerm: { getScrollbackLength: () => 0 },
		...over,
	};
}

function mount(term: TouchTextLayerTerminal) {
	const container = document.createElement("div");
	const canvas = document.createElement("canvas");
	// The canvas is letterboxed inside the container when a viewer adopts the
	// PTY's geometry, so the layer must track the canvas box, not the container.
	Object.defineProperty(canvas, "offsetLeft", { value: 12, configurable: true });
	Object.defineProperty(canvas, "offsetTop", { value: 4, configurable: true });
	Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
	Object.defineProperty(canvas, "clientHeight", { value: 480, configurable: true });
	container.appendChild(canvas);
	document.body.appendChild(container);
	const layer = installTouchTextLayer(container, canvas, term);
	return { container, canvas, layer, term };
}

const mounted: { layer: { dispose(): void }; container: HTMLElement }[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) {
		m.layer.dispose();
		m.container.remove();
	}
	vi.restoreAllMocks();
});

/** A selection whose range sits inside `node` — what a long press produces. */
function selectInside(node: Node) {
	vi.spyOn(document, "getSelection").mockReturnValue({
		isCollapsed: false,
		rangeCount: 1,
		getRangeAt: () => ({
			commonAncestorContainer: node,
			intersectsNode: (other: Node) => other === node || other.contains(node),
		}),
	} as unknown as Selection);
}

/** A range the browser anchored ABOVE the layer — Blink does this readily. */
function selectFromAncestor(ancestor: Node, layer: Node) {
	vi.spyOn(document, "getSelection").mockReturnValue({
		isCollapsed: false,
		rangeCount: 1,
		getRangeAt: () => ({
			commonAncestorContainer: ancestor,
			intersectsNode: (other: Node) => other === layer || other === ancestor,
		}),
	} as unknown as Selection);
}

describe("terminal touch text layer", () => {
	it("mirrors the viewport as one real text row per terminal row", () => {
		const m = mount(makeTerm(["hello", "world"]));
		mounted.push(m);
		m.layer.refresh();

		const rows = [...m.layer.element.children] as HTMLElement[];
		expect(rows.map((r) => r.textContent)).toEqual(["hello", "world"]);
		// Selectable, so the platform's own long-press selection has something real.
		expect(m.layer.element.style.getPropertyValue("user-select")).toBe("text");
	});

	// `getLine` indexes the whole buffer: row 0 is the oldest scrollback line, so
	// the screen starts at `scrollbackLength` — reading from 0 showed the terminal's
	// ancient history under the user's finger.
	it("starts at the live screen, not the oldest line in scrollback", () => {
		const m = mount(makeTerm(["old-1", "old-2", "live-1", "live-2"], {
			rows: 2,
			wasmTerm: { getScrollbackLength: () => 2 },
		}));
		mounted.push(m);
		m.layer.refresh();

		expect([...m.layer.element.children].map((r) => r.textContent)).toEqual(["live-1", "live-2"]);
	});

	it("walks back into scrollback by exactly the rows the viewport is scrolled", () => {
		const m = mount(makeTerm(["old-1", "old-2", "live-1", "live-2"], {
			rows: 2,
			viewportY: 1,
			wasmTerm: { getScrollbackLength: () => 2 },
		}));
		mounted.push(m);
		m.layer.refresh();

		expect([...m.layer.element.children].map((r) => r.textContent)).toEqual(["old-2", "live-1"]);
	});

	// Terminal font size and family are both live settings; a layer that captured
	// either at install would measure a different advance than ghostty draws with.
	it("follows a font the user changes after install", () => {
		const term = makeTerm(["x"]);
		const m = mount(term);
		mounted.push(m);
		m.layer.refresh();

		term.options.fontFamily = "'Fira Code', monospace";
		term.options.fontSize = 18;
		m.layer.refresh();

		// The DOM re-quotes the family, so compare on the name that matters.
		expect(m.layer.element.style.fontFamily).toContain("Fira Code");
		expect(m.layer.element.style.fontSize).toBe("18px");
	});

	it("pins itself over the canvas box and the renderer's cell metrics", () => {
		const m = mount(makeTerm(["x"]));
		mounted.push(m);
		m.layer.refresh();

		const style = m.layer.element.style;
		expect([style.left, style.top, style.width, style.height]).toEqual(["12px", "4px", "320px", "480px"]);
		// One row is exactly one cell tall, so row N lands on the glyphs of row N.
		expect(style.lineHeight).toBe("16px");
	});

	it("leaves a live selection alone instead of rebuilding it away", () => {
		const term = makeTerm(["before"]);
		const m = mount(term);
		mounted.push(m);
		m.layer.refresh();
		const row = m.layer.element.firstElementChild as HTMLElement;

		selectInside(row);
		term.buffer.active.getLine = () => ({
			isWrapped: false,
			length: 5,
			getCell: (x: number) => ({ getCode: () => "after".charCodeAt(x) }),
		});
		m.layer.refresh();

		expect(row.textContent).toBe("before");
	});

	// Answered from the live selection, never from a cached flag: Blink dispatches
	// `selectionchange` on a task, so a cached answer is stale for exactly the
	// frames in which the user is starting a drag.
	it("reports a held selection without waiting for a selectionchange event", () => {
		const m = mount(makeTerm(["text"]));
		mounted.push(m);
		m.layer.refresh();

		selectInside(m.layer.element.firstElementChild!);
		expect(m.layer.hasSelection()).toBe(true);
		expect(terminalTextSelectionLive(m.container)).toBe(true);

		vi.spyOn(document, "getSelection").mockReturnValue({ isCollapsed: true, rangeCount: 0 } as unknown as Selection);
		expect(m.layer.hasSelection()).toBe(false);
		expect(terminalTextSelectionLive(m.container)).toBe(false);
	});

	// `contains` alone misses this, and a rebuild would then destroy the selection
	// the user is holding — on a printing terminal, within a frame.
	it("counts a range the browser anchored above the layer", () => {
		const m = mount(makeTerm(["before"]));
		mounted.push(m);
		m.layer.refresh();
		const row = m.layer.element.firstElementChild as HTMLElement;

		selectFromAncestor(m.container, m.layer.element);
		expect(m.layer.hasSelection()).toBe(true);

		m.term.buffer.active.getLine = () => ({
			isWrapped: false, length: 5, getCell: (x: number) => ({ getCode: () => "after".charCodeAt(x) }),
		});
		m.layer.refresh();
		expect(row.textContent).toBe("before");
	});

	it("detaches cleanly on dispose", () => {
		const m = mount(makeTerm(["text"]));
		m.layer.refresh();
		const element = m.layer.element;
		m.layer.dispose();
		m.container.remove();

		expect(element.isConnected).toBe(false);
		expect(terminalTextSelectionLive(document)).toBe(false);
	});
});

// Android draws handles over these rows but never a Copy toolbar, so the platform
// gives no way to act on the selection it just made. dev3's existing answer is that
// selecting IS copying; these cover carrying that rule to touch without turning a
// handle drag into dozens of clipboard writes.
describe("terminal touch text layer – auto-copy on a settled selection", () => {
	function mountWithCopy(rows: string[]) {
		const settled: string[] = [];
		const container = document.createElement("div");
		const canvas = document.createElement("canvas");
		container.appendChild(canvas);
		document.body.appendChild(container);
		const term = makeTerm(rows);
		const layer = installTouchTextLayer(container, canvas, term, {
			onSelectionSettled: (text) => settled.push(text),
		});
		return { container, layer, settled };
	}

	function selectText(node: Node, text: string) {
		vi.spyOn(document, "getSelection").mockReturnValue({
			isCollapsed: false,
			rangeCount: 1,
			toString: () => text,
			getRangeAt: () => ({ commonAncestorContainer: node, intersectsNode: () => true }),
		} as unknown as Selection);
	}

	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("copies once the selection stops changing", () => {
		const m = mountWithCopy(["hello world"]);
		m.layer.refresh();

		selectText(m.layer.element, "hello");
		document.dispatchEvent(new Event("selectionchange"));
		expect(m.settled).toEqual([]);   // nothing yet — still moving
		vi.advanceTimersByTime(300);

		expect(m.settled).toEqual(["hello"]);
		m.layer.dispose();
		m.container.remove();
	});

	// A handle drag fires selectionchange per pixel. One clipboard write, not thirty.
	it("collapses a whole drag into a single copy of the final range", () => {
		const m = mountWithCopy(["hello world"]);
		m.layer.refresh();

		for (const t of ["h", "he", "hel", "hell", "hello"]) {
			selectText(m.layer.element, t);
			document.dispatchEvent(new Event("selectionchange"));
			vi.advanceTimersByTime(50);
		}
		vi.advanceTimersByTime(300);

		expect(m.settled).toEqual(["hello"]);
		m.layer.dispose();
		m.container.remove();
	});

	it("stays quiet for a selection that is not over the terminal", () => {
		const m = mountWithCopy(["hello world"]);
		m.layer.refresh();

		vi.spyOn(document, "getSelection").mockReturnValue({
			isCollapsed: false, rangeCount: 1, toString: () => "elsewhere",
			getRangeAt: () => ({ commonAncestorContainer: document.body, intersectsNode: () => false }),
		} as unknown as Selection);
		document.dispatchEvent(new Event("selectionchange"));
		vi.advanceTimersByTime(300);

		expect(m.settled).toEqual([]);
		m.layer.dispose();
		m.container.remove();
	});

	it("stops copying after dispose", () => {
		const m = mountWithCopy(["hello world"]);
		m.layer.refresh();
		m.layer.dispose();
		m.container.remove();

		selectText(m.layer.element, "hello");
		document.dispatchEvent(new Event("selectionchange"));
		vi.advanceTimersByTime(300);

		expect(m.settled).toEqual([]);
	});
});
