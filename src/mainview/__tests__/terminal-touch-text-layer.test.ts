import { describe, it, expect, afterEach, vi } from "vitest";
import { installTouchTextLayer, SELECTING_ATTR, type TouchTextLayerTerminal } from "../terminal-touch-text-layer";

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
		options: { fontSize: 14 },
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
	const layer = installTouchTextLayer(container, canvas, term, "monospace");
	return { container, canvas, layer };
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
		getRangeAt: () => ({ commonAncestorContainer: node }),
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

	it("flags itself while a selection is held so the pane swipe stands down", () => {
		const m = mount(makeTerm(["text"]));
		mounted.push(m);
		m.layer.refresh();

		selectInside(m.layer.element.firstElementChild!);
		document.dispatchEvent(new Event("selectionchange"));
		expect(m.layer.element.hasAttribute(SELECTING_ATTR)).toBe(true);

		vi.spyOn(document, "getSelection").mockReturnValue({ isCollapsed: true, rangeCount: 0 } as unknown as Selection);
		document.dispatchEvent(new Event("selectionchange"));
		expect(m.layer.element.hasAttribute(SELECTING_ATTR)).toBe(false);
	});

	it("stops tracking selections once disposed", () => {
		const m = mount(makeTerm(["text"]));
		m.layer.refresh();
		const element = m.layer.element;
		m.layer.dispose();
		m.container.remove();

		selectInside(element);
		document.dispatchEvent(new Event("selectionchange"));
		expect(element.hasAttribute(SELECTING_ATTR)).toBe(false);
		expect(element.isConnected).toBe(false);
	});
});
