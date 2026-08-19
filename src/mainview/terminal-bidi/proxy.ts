import type { GhosttyCell } from "ghostty-web";
import { type BidiEngine, defaultBidiEngine } from "./engine";
import { type ReorderedRow, reorderRow } from "./reorder";

/** The buffer contract ghostty-web's CanvasRenderer actually consumes. */
export interface BidiRenderable {
	getLine(y: number): GhosttyCell[] | null;
	getCursor(): { x: number; y: number; visible: boolean };
	getDimensions(): { cols: number; rows: number };
	isRowDirty(y: number): boolean;
	needsFullRedraw?(): boolean;
	clearDirty(): void;
	getGraphemeString?(row: number, col: number): string;
	/** One-WASM-call read of the whole viewport into the emulator's cell pool. */
	getViewport?(): GhosttyCell[] | null;
	/** Refreshes the render state the pool is parsed from. */
	update?(): unknown;
}

export interface BidiScrollbackProvider {
	getScrollbackLine(offset: number): GhosttyCell[] | null;
	getScrollbackLength(): number;
}

/**
 * A render-time view of the terminal buffer in visual order.
 *
 * Three ordering facts about `CanvasRenderer.render` this leans on:
 *  - `getCursor()` is the FIRST buffer call of a frame, before any `getLine`, so
 *    the cursor's row is reordered here and memoized for the frame rather than
 *    read from a "last row seen" cache (which would lag one frame).
 *  - `renderLine(cells, row, cols)` runs synchronously after the `getLine` that
 *    produced those cells, so `getGraphemeString(row, col)` can map its column
 *    back through that row's mapping.
 *  - the renderer compares the cursor's x against its own previous value, so a
 *    logical move that maps to the same visual column must force a row repaint.
 */
export function createBidiRenderable(
	inner: BidiRenderable,
	engine: BidiEngine = defaultBidiEngine(),
): BidiRenderable & { beginFrame(): void } {
	// Mapping of the most recent line handed to the renderer, for grapheme lookups.
	let mappedRow = -1;
	let visualToLogical: Int32Array | null = null;

	// Per-frame memo of the cursor's row, so it is reordered exactly once.
	let cursorRow = -1;
	let cursorLine: GhosttyCell[] | null = null;
	let cursorReorder: ReorderedRow | null = null;
	let cursorComputed = false;

	// Cursor-repaint mitigation state.
	let lastLogicalX = -1;
	let lastVisualX = -1;
	let forcedDirtyRow = -1;

	// Per-frame viewport cache. The vendor's `getLine(y)` re-reads and re-parses
	// the ENTIRE viewport for every row it is asked for, so a 46-row repaint pays
	// 46 full-screen parses. The pool is read once per frame here and sliced.
	let pool: GhosttyCell[] | null = null;
	let poolCols = 0;
	let poolRows = 0;
	let poolUnusable = false;

	function remember(row: number, reordered: ReorderedRow | null) {
		mappedRow = row;
		visualToLogical = reordered ? reordered.visualToLogical : null;
	}

	/**
	 * A row of cells, copied out of the shared pool exactly as the vendor's own
	 * `getLine` copies it — the pool is reused, so handing it out raw would alias.
	 */
	function readLine(y: number): GhosttyCell[] | null {
		if (poolUnusable || !inner.getViewport || !inner.update) return inner.getLine(y);
		if (!pool) {
			const { cols, rows } = inner.getDimensions();
			inner.update();
			const cells = inner.getViewport();
			if (!cells || cols <= 0 || rows <= 0 || cells.length < cols * rows) {
				poolUnusable = true;
				return inner.getLine(y);
			}
			pool = cells;
			poolCols = cols;
			poolRows = rows;
		}
		if (y < 0 || y >= poolRows) return null;
		const start = y * poolCols;
		const row: GhosttyCell[] = new Array(poolCols);
		for (let i = 0; i < poolCols; i++) row[i] = { ...pool[start + i] };
		return row;
	}

	function reorderCursorRow(y: number) {
		if (cursorComputed && cursorRow === y) return;
		cursorRow = y;
		cursorLine = readLine(y);
		cursorReorder = cursorLine ? reorderRow(cursorLine, engine) : null;
		cursorComputed = true;
	}

	return {
		beginFrame() {
			cursorComputed = false;
			cursorRow = -1;
			cursorLine = null;
			cursorReorder = null;
			mappedRow = -1;
			visualToLogical = null;
			pool = null;
		},

		getLine(y: number) {
			if (cursorComputed && y === cursorRow) {
				remember(y, cursorReorder);
				return cursorReorder ? cursorReorder.cells : cursorLine;
			}
			const cells = readLine(y);
			if (!cells) {
				remember(-1, null);
				return cells;
			}
			const reordered = reorderRow(cells, engine);
			remember(y, reordered);
			return reordered ? reordered.cells : cells;
		},

		getCursor() {
			const cursor = inner.getCursor();
			reorderCursorRow(cursor.y);
			const map = cursorReorder?.logicalToVisual;
			const x =
				map && cursor.x >= 0 && cursor.x < map.length ? map[cursor.x] : cursor.x;
			forcedDirtyRow =
				lastLogicalX !== cursor.x && lastVisualX === x ? cursor.y : -1;
			lastLogicalX = cursor.x;
			lastVisualX = x;
			return { ...cursor, x };
		},

		getDimensions: () => inner.getDimensions(),

		isRowDirty: (y: number) => inner.isRowDirty(y) || y === forcedDirtyRow,

		...(inner.needsFullRedraw
			? { needsFullRedraw: () => inner.needsFullRedraw?.() ?? false }
			: {}),

		clearDirty: () => inner.clearDirty(),

		...(inner.getGraphemeString
			? {
					getGraphemeString(row: number, col: number) {
						const map = row === mappedRow ? visualToLogical : null;
						const logicalCol =
							map && col >= 0 && col < map.length ? map[col] : col;
						return inner.getGraphemeString?.(row, logicalCol) ?? "";
					},
				}
			: {}),
	};
}

export function createBidiScrollback(
	inner: BidiScrollbackProvider,
	engine: BidiEngine = defaultBidiEngine(),
): BidiScrollbackProvider {
	return {
		getScrollbackLine(offset: number) {
			const cells = inner.getScrollbackLine(offset);
			if (!cells) return cells;
			const reordered = reorderRow(cells, engine);
			return reordered ? reordered.cells : cells;
		},
		getScrollbackLength: () => inner.getScrollbackLength(),
	};
}

/** The renderer surface we wrap — structurally compatible with `CanvasRenderer`. */
interface WrappableRenderer {
	render(
		buffer: BidiRenderable,
		forceAll?: boolean,
		viewportY?: number,
		scrollbackProvider?: BidiScrollbackProvider,
		scrollbarOpacity?: number,
	): void;
}

const ORIGINAL_RENDER = Symbol.for("dev3.terminalBidi.originalRender");

type WrappedRenderer = WrappableRenderer & {
	[ORIGINAL_RENDER]?: WrappableRenderer["render"];
};

/**
 * Route every paint through the visual-order view. Idempotent: installing twice
 * is a no-op, so a settings toggle can call it without bookkeeping.
 */
export function installBidiRender(
	renderer: WrappableRenderer,
	engine: BidiEngine = defaultBidiEngine(),
): void {
	const target = renderer as WrappedRenderer;
	if (target[ORIGINAL_RENDER] || typeof renderer.render !== "function") return;

	const original = renderer.render;
	target[ORIGINAL_RENDER] = original;

	// The renderer is handed the same buffer object every frame, so the views are
	// built once and reused — a fresh view per frame would lose the cursor memo.
	let renderableInner: BidiRenderable | null = null;
	let renderable: (BidiRenderable & { beginFrame(): void }) | null = null;
	let scrollbackInner: BidiScrollbackProvider | null = null;
	let scrollback: BidiScrollbackProvider | null = null;

	target.render = function bidiRender(
		buffer: BidiRenderable,
		forceAll?: boolean,
		viewportY?: number,
		scrollbackProvider?: BidiScrollbackProvider,
		scrollbarOpacity?: number,
	) {
		if (renderableInner !== buffer) {
			renderableInner = buffer;
			renderable = createBidiRenderable(buffer, engine);
		}
		renderable?.beginFrame();

		if (scrollbackProvider && scrollbackInner !== scrollbackProvider) {
			scrollbackInner = scrollbackProvider;
			scrollback = createBidiScrollback(scrollbackProvider, engine);
		}

		original.call(
			this,
			renderable ?? buffer,
			forceAll,
			viewportY,
			scrollbackProvider ? (scrollback ?? scrollbackProvider) : scrollbackProvider,
			scrollbarOpacity,
		);
	};
}

/** Restore the vendor's own render. Safe to call when nothing is installed. */
export function uninstallBidiRender(renderer: WrappableRenderer): void {
	const target = renderer as WrappedRenderer;
	const original = target[ORIGINAL_RENDER];
	if (!original) return;
	target.render = original;
	delete target[ORIGINAL_RENDER];
}

export function isBidiRenderInstalled(renderer: WrappableRenderer): boolean {
	return (renderer as WrappedRenderer)[ORIGINAL_RENDER] !== undefined;
}
