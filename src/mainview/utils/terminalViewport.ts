export interface ViewportPreservingTerminal {
	getViewportY(): number;
	getScrollbackLength(): number;
	write(data: string | Uint8Array): void;
	scrollToLine(line: number): void;
}

interface GhosttySmoothScrollState {
	targetViewportY?: number;
}

/**
 * Write terminal output without pulling a user who is reading scrollback back
 * to the live bottom.
 *
 * ghostty-web 0.4.0 unconditionally calls scrollToBottom() from writeInternal.
 * Preserve the visible buffer position by compensating for lines added to the
 * scrollback during the write. At viewport zero, retain ghostty's normal
 * follow-output behavior.
 */
export function writePreservingViewport(
	terminal: ViewportPreservingTerminal,
	data: string | Uint8Array,
): void {
	const viewportBefore = terminal.getViewportY();
	if (viewportBefore <= 0) {
		terminal.write(data);
		return;
	}

	const scrollbackBefore = terminal.getScrollbackLength();
	terminal.write(data);
	const scrollbackGrowth = terminal.getScrollbackLength() - scrollbackBefore;
	terminal.scrollToLine(viewportBefore + scrollbackGrowth);

	// scrollToLine() updates viewportY but ghostty-web keeps a separate private
	// smooth-scroll target. Sync it when present so an in-flight animation cannot
	// move the restored viewport again. The public restoration still works if the
	// upstream implementation removes this field.
	const smoothScrollState = terminal as ViewportPreservingTerminal & GhosttySmoothScrollState;
	if (typeof smoothScrollState.targetViewportY === "number") {
		smoothScrollState.targetViewportY = terminal.getViewportY();
	}
}
