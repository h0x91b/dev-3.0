import type { Terminal } from "ghostty-web";
import { cellFromMouseEvent } from "./terminal-cell-hit";
import type { RectLike } from "./utils/popoverPosition";

export interface TerminalRefHover {
	uri: string;
	/** The hovered cell in client coordinates — where the preview card anchors. */
	anchor: RectLike;
}

/**
 * Report which `<seq:N>` / `<pr:N>` reference the mouse rests on. The terminal
 * draws links as canvas pixels, so React cannot hang a hover card on them; this
 * turns mouse moves into "hovering ref X at cell Y" and back to null.
 */
export function installTerminalRefHover(opts: {
	term: Terminal;
	container: HTMLElement;
	refAt: (y: number, x: number) => string | undefined;
	onChange: (hover: TerminalRefHover | null) => void;
}): { dispose(): void } {
	const { term, container, refAt, onChange } = opts;
	let frameId: number | null = null;
	let pending: MouseEvent | null = null;
	let current: string | null = null;

	function set(hover: TerminalRefHover | null): void {
		const key = hover ? hover.uri : null;
		if (key === current) return;
		current = key;
		onChange(hover);
	}

	function update(e: MouseEvent): void {
		const renderer = term.renderer;
		const canvas = renderer?.getCanvas();
		const cell = cellFromMouseEvent(term, e);
		if (!renderer || !canvas || !cell) return set(null);
		const uri = refAt(cell.y, cell.x);
		if (!uri) return set(null);
		const box = canvas.getBoundingClientRect();
		const left = box.left + cell.x * renderer.charWidth;
		const top = box.top + cell.viewportRow * renderer.charHeight;
		set({ uri, anchor: { top, left, right: left + renderer.charWidth, bottom: top + renderer.charHeight, width: renderer.charWidth, height: renderer.charHeight } });
	}

	function onMouseMove(e: MouseEvent): void {
		pending = e;
		if (frameId !== null) return;
		frameId = requestAnimationFrame(() => {
			frameId = null;
			if (pending) update(pending);
		});
	}
	function onMouseLeave(): void {
		pending = null;
		set(null);
	}

	container.addEventListener("mousemove", onMouseMove, { passive: true });
	container.addEventListener("mouseleave", onMouseLeave, { passive: true });
	const scrollSub = term.onScroll(() => set(null));
	return {
		dispose() {
			if (frameId !== null) cancelAnimationFrame(frameId);
			container.removeEventListener("mousemove", onMouseMove);
			container.removeEventListener("mouseleave", onMouseLeave);
			scrollSub.dispose();
		},
	};
}
