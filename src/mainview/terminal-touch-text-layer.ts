/**
 * A real-DOM copy of the visible terminal rows, laid transparently over the canvas.
 *
 * iOS offers its selection UI — the grab handles, the magnifier, the Copy /
 * Look Up / Share callout — only for genuine text nodes. A terminal is a canvas,
 * so a long press there has nothing to select and WebKit falls back to selecting
 * the whole contenteditable block ghostty marks up: the entire terminal
 * highlighted, and a Copy that yields a page archive rather than text. This layer
 * hands WebKit something real. The system does the selecting; the copy is plain
 * text straight out of the DOM, no OSC 52 round trip.
 *
 * Two properties make the illusion hold, and both are load-bearing:
 *  - `lineToText` emits exactly one UTF-16 unit per cell, so string index ===
 *    screen column, and
 *  - `letter-spacing` is tuned per refresh so one character advances by exactly
 *    the renderer's `charWidth`, which keeps column N of the text over column N
 *    of the glyphs however the font actually measures.
 */
import { lineToText, type CellLine } from "./terminal-file-links";

export interface TouchTextLayerTerminal {
	rows: number;
	/** Rows scrolled up from the live bottom; 0 while following output. */
	viewportY: number;
	buffer: { active: { getLine(y: number): CellLine | null | undefined } };
	options: { fontSize?: number; fontFamily?: string };
	renderer?: { charWidth: number; charHeight: number } | null;
	wasmTerm?: { getScrollbackLength?: () => number } | null;
}

export interface TouchTextLayer {
	element: HTMLElement;
	/** Re-read the viewport into the DOM. A no-op while a selection is live. */
	refresh(): void;
	/** Is the platform holding a selection over these rows, right now? */
	hasSelection(): boolean;
	dispose(): void;
}

/** Identifies a layer in the DOM for code that has no handle on one. */
export const TEXT_LAYER_SELECTOR = "[data-terminal-text-layer]";

/**
 * Does the current selection touch `element`?
 *
 * Asked synchronously, never cached behind a `selectionchange` listener: Blink
 * dispatches that event on a task, so a cached answer is stale for exactly the
 * frames in which the user is starting a drag — and every caller here is deciding
 * whether to move the text out from under them.
 *
 * `intersectsNode`, not `contains`: a range the browser anchored at a parent
 * still covers our rows, and treating that as "no selection" is what lets a
 * rebuild destroy it.
 */
export function selectionTouches(element: Element): boolean {
	const selection = document.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
	const range = selection.getRangeAt(0);
	try {
		if (typeof range.intersectsNode === "function") return range.intersectsNode(element);
	} catch {
		// A detached range throws; fall through to the containment test.
	}
	return element.contains(range.commonAncestorContainer);
}

/** The same question for a caller that only has a subtree, not a layer handle. */
export function terminalTextSelectionLive(root: ParentNode): boolean {
	const layer = root.querySelector(TEXT_LAYER_SELECTOR);
	return !!layer && selectionTouches(layer);
}

export function installTouchTextLayer(
	container: HTMLElement,
	canvas: HTMLCanvasElement,
	term: TouchTextLayerTerminal,
): TouchTextLayer {
	const element = document.createElement("div");
	element.setAttribute("data-terminal-text-layer", "true");
	Object.assign(element.style, {
		position: "absolute",
		margin: "0",
		padding: "0",
		overflow: "hidden",
		zIndex: "1",
		fontVariantLigatures: "none",
		whiteSpace: "pre",
		color: "transparent",
		caretColor: "transparent",
		// iOS inflates text in "narrow" columns unless told not to, which would
		// silently break the column alignment everything here depends on.
		webkitTextSizeAdjust: "none",
	} satisfies Partial<CSSStyleDeclaration>);
	// The container is user-select:none so a press on its padding selects nothing;
	// selection is exactly this layer's job, so it opts back in.
	element.style.setProperty("-webkit-user-select", "text");
	element.style.setProperty("user-select", "text");
	container.appendChild(element);

	const rowPool: HTMLDivElement[] = [];
	// One offscreen context, reused: measuring the font per refresh is what keeps
	// the layer aligned across a zoom change or a font that loads late.
	const measurer = document.createElement("canvas").getContext("2d");
	let lastFontKey = "";
	let lastAdvance = 0;

	function naturalAdvance(fontSize: number, fontFamily: string): number {
		const key = `${fontSize}px ${fontFamily}`;
		if (key === lastFontKey) return lastAdvance;
		if (!measurer) return 0;
		measurer.font = key;
		// A long run averages away per-glyph rounding in the measurement.
		lastAdvance = measurer.measureText("0".repeat(100)).width / 100;
		lastFontKey = key;
		return lastAdvance;
	}

	const hasLiveSelection = () => selectionTouches(element);

	function refresh(): void {
		// Rebuilding the text nodes would collapse a selection the user is still
		// adjusting, and terminal output arrives constantly. Their selection wins.
		if (hasLiveSelection()) return;
		const renderer = term.renderer;
		if (!renderer) return;
		const { charWidth, charHeight } = renderer;
		if (!(charWidth > 0) || !(charHeight > 0)) return;

		// The canvas is letterboxed inside the container when a viewer adopts the
		// PTY's geometry, so the layer tracks the canvas box, not the container's.
		element.style.left = `${canvas.offsetLeft}px`;
		element.style.top = `${canvas.offsetTop}px`;
		element.style.width = `${canvas.clientWidth}px`;
		element.style.height = `${canvas.clientHeight}px`;

		// Read the font off the terminal every time: size and family are both live
		// settings, and a stale family measures a different advance than ghostty
		// draws — the layer would drift a fraction of a cell per column.
		const fontSize = term.options.fontSize ?? Math.round(charHeight * 0.8);
		const fontFamily = term.options.fontFamily || "monospace";
		element.style.fontSize = `${fontSize}px`;
		element.style.fontFamily = fontFamily;
		element.style.lineHeight = `${charHeight}px`;
		element.style.letterSpacing = `${charWidth - naturalAdvance(fontSize, fontFamily)}px`;

		// `getLine` indexes the WHOLE buffer, scrollback included, so screen row 0
		// is `scrollbackLength` — not 0, which is the oldest line ever printed.
		// Same arithmetic ghostty uses to resolve a click into a buffer row.
		const scrollback = term.wasmTerm?.getScrollbackLength?.() ?? 0;
		const top = scrollback - Math.max(0, Math.floor(term.viewportY));
		const buffer = term.buffer.active;
		for (let i = 0; i < term.rows; i++) {
			let row = rowPool[i];
			if (!row) {
				row = document.createElement("div");
				row.style.height = `${charHeight}px`;
				rowPool[i] = row;
				element.appendChild(row);
			}
			row.style.height = `${charHeight}px`;
			const line = buffer.getLine(top + i);
			const text = line ? lineToText(line) : "";
			if (row.textContent !== text) row.textContent = text;
		}
		for (let i = term.rows; i < rowPool.length; i++) rowPool[i].remove();
		rowPool.length = term.rows;
	}

	return {
		element,
		refresh,
		hasSelection: hasLiveSelection,
		dispose() {
			element.remove();
			rowPool.length = 0;
		},
	};
}
