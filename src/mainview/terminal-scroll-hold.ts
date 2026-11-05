import type { Terminal } from "ghostty-web";

const HISTORY_CLEAR = /\x1b\[3J|\x1bc/;

/** ghostty-web's write() jumps to live output whenever the view is in history; keep the same rows on screen. */
export function writeHoldingViewport(term: Terminal, data: string): void {
	const scrollback = term.getScrollbackLength();
	// A reset or a reflow can leave viewportY past the scrollback it counts into.
	const viewportY = Math.min(term.getViewportY(), scrollback);
	term.write(data);
	const grown = term.getScrollbackLength() - scrollback;
	// A clear (ED 3, RIS) replaced the anchored history: stay with live output.
	if (viewportY <= 0 || HISTORY_CLEAR.test(data)) return;
	// shortcut: a full scrollback prunes whole pages, so the view drifts by at most the evicted rows instead of snapping.
	term.scrollToLine(viewportY + Math.max(grown, 0));
}
