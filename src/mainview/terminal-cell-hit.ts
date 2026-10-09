import type { Terminal } from "ghostty-web";
import { viewportRowToAbsolute } from "./terminal-link-underlines";

/** A terminal cell under the pointer: absolute buffer row, viewport column. */
export interface TerminalCell {
	y: number;
	x: number;
	/** The same row counted from the top of the viewport, for positioning. */
	viewportRow: number;
}

/**
 * The cell a mouse event points at, or undefined when it lands outside the
 * grid. Same math ghostty-web's own click handler uses, shared by the OSC 8
 * hover tooltip and the OSC 8 click so both read the same cell.
 */
export function cellFromMouseEvent(term: Terminal, event: Pick<MouseEvent, "clientX" | "clientY">): TerminalCell | undefined {
	const renderer = term.renderer;
	const canvas = renderer?.getCanvas();
	if (!renderer || !canvas || !renderer.charWidth || !renderer.charHeight) return undefined;
	const rect = canvas.getBoundingClientRect();
	const x = Math.floor((event.clientX - rect.left) / renderer.charWidth);
	const viewportRow = Math.floor((event.clientY - rect.top) / renderer.charHeight);
	if (x < 0 || x >= term.cols || viewportRow < 0 || viewportRow >= term.rows) return undefined;
	const scrollback = Math.max(0, term.buffer.active.length - term.rows);
	return { y: viewportRowToAbsolute(viewportRow, term.viewportY, scrollback), x, viewportRow };
}
