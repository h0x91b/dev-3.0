import type { Terminal } from "ghostty-web";
import type { BufferRange } from "./terminal-file-links";

/**
 * Persistent underlines for file-path links in the terminal. ghostty-web only
 * underlines the ONE link range currently hovered, so detected paths are
 * invisible until the mouse finds them — this overlay canvas (pointer-events:
 * none, stacked over the terminal canvas) underlines every resolved path link
 * in the viewport so they read as links at a glance.
 *
 * Refresh triggers: ghostty-web 0.4.0 never fires `onRender` (the emitter has
 * no `.fire()` call in the bundle), so content changes are reported by
 * TerminalView's own write batch via `requestRedraw()`; `onScroll` covers
 * viewport moves and a ResizeObserver covers layout.
 *
 * Redraws coalesce into the next animation frame and clear-and-stroke in the
 * same pass, so the overlay is never left blank waiting for a recompute. A
 * debounce here would starve: under a stream of writes it never fires, which
 * blanked the underlines for the whole output burst and blinked them at the
 * refresh rate of an agent's spinner. One frame costs ~0.25 ms for a typical
 * 160×48 viewport and ~0.9 ms for a screen that is nothing but full-width
 * paths, so per-frame recompute is cheaper than the bookkeeping to avoid it.
 */

// Same blue ghostty-web hardcodes for its hover underline (#4A90E2), slightly
// translucent so the persistent decoration stays quieter than the hover state.
const UNDERLINE_COLOR = "rgba(74, 144, 226, 0.55)";

/**
 * Map a viewport row to an absolute buffer row (scrollback + screen), the
 * same math ghostty-web's click handler uses.
 */
export function viewportRowToAbsolute(viewportRow: number, viewportY: number, scrollbackLength: number): number {
	const n = Math.max(0, Math.floor(viewportY));
	if (n > 0 && viewportRow < n) return scrollbackLength - n + viewportRow;
	return scrollbackLength + (viewportRow - n);
}

export interface FilePathUnderlinesHandle {
	/** Content, viewport or resolutions changed — repaint on the next frame. */
	requestRedraw(): void;
	dispose(): void;
}

export function installFilePathUnderlines(options: {
	term: Terminal;
	container: HTMLElement;
	linksForRows: (absoluteRows: number[]) => BufferRange[];
}): FilePathUnderlinesHandle {
	const { term, container, linksForRows } = options;
	if (typeof getComputedStyle === "function" && getComputedStyle(container).position === "static") {
		container.style.position = "relative";
	}
	const overlay = document.createElement("canvas");
	overlay.style.position = "absolute";
	overlay.style.pointerEvents = "none";
	overlay.style.left = "0";
	overlay.style.top = "0";
	overlay.dataset.role = "file-path-underlines";
	container.appendChild(overlay);
	const ctx = overlay.getContext("2d");

	let disposed = false;
	let frameId: number | null = null;

	function termCanvas(): HTMLCanvasElement | null {
		for (const canvas of container.querySelectorAll("canvas")) {
			if (canvas !== overlay) return canvas;
		}
		return null;
	}

	/**
	 * Mirror the terminal canvas's box. Style writes are conditional: this runs
	 * inside every frame, and writing unchanged values would invalidate layout
	 * and make the next read a forced reflow.
	 */
	function syncSize(): { w: number; h: number; dpr: number } | null {
		const canvas = termCanvas();
		if (!canvas) return null;
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		const left = `${canvas.offsetLeft}px`;
		const top = `${canvas.offsetTop}px`;
		if (overlay.style.left !== left) overlay.style.left = left;
		if (overlay.style.top !== top) overlay.style.top = top;
		if (overlay.style.width !== `${w}px`) overlay.style.width = `${w}px`;
		if (overlay.style.height !== `${h}px`) overlay.style.height = `${h}px`;
		if (overlay.width !== w * dpr || overlay.height !== h * dpr) {
			overlay.width = w * dpr;
			overlay.height = h * dpr;
		}
		return { w, h, dpr };
	}

	function clearNow(): void {
		// Resizing the backing store also clears it; this covers the no-resize case.
		ctx?.clearRect(0, 0, overlay.width, overlay.height);
	}

	function redraw(): void {
		if (disposed || !ctx) return;
		// No renderer or no metrics yet: drop whatever is drawn rather than leave
		// underlines standing at positions we can no longer verify.
		if (!term.renderer) return clearNow();
		const size = syncSize();
		if (!size) return clearNow();
		const charWidth = term.renderer.charWidth;
		const charHeight = term.renderer.charHeight;
		if (!charWidth || !charHeight) return clearNow();
		const buffer = term.buffer.active;
		const scrollback = Math.max(0, buffer.length - term.rows);
		const viewportY = term.viewportY;
		const n = Math.max(0, Math.floor(viewportY));
		const absoluteRows = Array.from({ length: term.rows }, (_, viewportRow) =>
			viewportRowToAbsolute(viewportRow, viewportY, scrollback),
		);
		const ranges = linksForRows(absoluteRows);
		ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
		ctx.clearRect(0, 0, size.w, size.h);
		ctx.strokeStyle = UNDERLINE_COLOR;
		ctx.lineWidth = 1;
		for (const range of ranges) {
			for (let absRow = range.start.y; absRow <= range.end.y; absRow++) {
				// Inverse of viewportRowToAbsolute — both branches reduce to this.
				const viewportRow = absRow - scrollback + n;
				if (viewportRow < 0 || viewportRow >= term.rows) continue;
				const fromX = absRow === range.start.y ? range.start.x : 0;
				const toX = absRow === range.end.y ? range.end.x : term.cols - 1;
				const y = (viewportRow + 1) * charHeight - 1.5;
				ctx.beginPath();
				ctx.moveTo(fromX * charWidth, y);
				ctx.lineTo((toX + 1) * charWidth, y);
				ctx.stroke();
			}
		}
	}

	/** Coalesce every trigger into one repaint on the next frame. */
	function requestRedraw(): void {
		if (disposed || frameId !== null) return;
		frameId = requestAnimationFrame(() => {
			frameId = null;
			redraw();
		});
	}

	const subscriptions = [term.onScroll(() => requestRedraw())];
	const resizeObserver =
		typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => requestRedraw()) : null;
	resizeObserver?.observe(container);
	requestRedraw();

	return {
		requestRedraw,
		dispose() {
			disposed = true;
			if (frameId !== null) cancelAnimationFrame(frameId);
			for (const sub of subscriptions) sub.dispose();
			resizeObserver?.disconnect();
			overlay.remove();
		},
	};
}
