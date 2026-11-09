import { useState, useRef, useEffect, useCallback } from "react";
import { api } from "../rpc";
import { ansiToHtml } from "../utils/ansi-to-html";

const POP_W = 420;
const POP_H = 320;
const PAD = 8;
const OPEN_DELAY = 400;
const CLOSE_DELAY = 200;
const REFRESH_INTERVAL = 1000;

// Below this width the board renders as a one-column carousel (see MobileBoardCarousel).
const HOVER_PREVIEW_MIN_WIDTH = 768;

/**
 * Hover terminal previews are pointless on touch / narrow (mobile carousel)
 * viewports: there is no hover, and a tap-triggered popover just obscures the
 * card. Disable the preview when the device is touch-primary OR the viewport is
 * narrow. Evaluated lazily on hover so it reacts to window resizing.
 */
function hoverPreviewEnabled(): boolean {
	if (typeof window === "undefined") return true;
	const mq = window.matchMedia?.("(hover: none), (pointer: coarse)");
	const coarse = mq ? mq.matches : false;
	const narrow = window.innerWidth < HOVER_PREVIEW_MIN_WIDTH;
	return !coarse && !narrow;
}

// An open menu can cover neighbouring cards or rows (the sidebar is narrower than a
// context menu), so pointing at one of them must not slide a preview under the menu.
// Pickers that are not ARIA menus (labels, move-to, open-in) opt in with data-menu-surface.
function anyMenuOpen(): boolean {
	return typeof document !== "undefined" && document.querySelector('[role="menu"], [data-menu-surface]') !== null;
}

function clampPosition(anchorRect: DOMRect) {
	const vw = window.innerWidth;
	const vh = window.innerHeight;

	let left = anchorRect.right + 8;
	let top = anchorRect.top;

	if (left + POP_W > vw - PAD) {
		left = anchorRect.left - POP_W - 8;
	}
	if (left < PAD) left = PAD;
	if (top + POP_H > vh - PAD) {
		top = vh - POP_H - PAD;
	}
	if (top < PAD) top = PAD;

	return { top, left };
}

export interface TerminalPreviewState {
	open: boolean;
	html: string | null;
	loading: boolean;
	pos: { top: number; left: number };
	/** Task id currently rendered in the popover; null when closed. */
	activeTaskId: string | null;
	cancelClose: () => void;
	scheduleClose: () => void;
}

/**
 * Hook that manages terminal preview hover logic.
 * Works for both single-task (TaskCard) and multi-task (sidebar) scenarios.
 *
 * For single-task: call `handlers.onMouseEnter(taskId, anchorEl, e.target)` with the same taskId.
 * For multi-task: call it with different taskIds;
 * the hook handles switching between them.
 *
 * Attach `anchorRef` to the element used for positioning.
 */
export function useTerminalPreview() {
	const [open, setOpen] = useState(false);
	const [html, setHtml] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

	const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Bumped on every open and close; async continuations from an older generation must not touch state.
	const genRef = useRef(0);
	const openedRef = useRef(false);
	const activeTaskIdRef = useRef<string | null>(null);
	const activeAnchorRef = useRef<HTMLElement | null>(null);
	const isDraggingRef = useRef(false);

	const cancelTimers = useCallback(() => {
		if (openTimerRef.current) {
			clearTimeout(openTimerRef.current);
			openTimerRef.current = null;
		}
		if (closeTimerRef.current) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);

	const close = useCallback(() => {
		cancelTimers();
		genRef.current++;
		openedRef.current = false;
		if (pollTimerRef.current) {
			clearTimeout(pollTimerRef.current);
			pollTimerRef.current = null;
		}
		setOpen(false);
		setHtml(null);
		setLoading(false);
		activeTaskIdRef.current = null;
		activeAnchorRef.current = null;
		setActiveTaskId(null);
	}, [cancelTimers]);

	const scheduleClose = useCallback(() => {
		if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
		closeTimerRef.current = setTimeout(() => {
			close();
		}, CLOSE_DELAY);
	}, [close]);

	const cancelClose = useCallback(() => {
		if (closeTimerRef.current) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);

	/**
	 * Call on mouseenter. Pass the anchor element for positioning
	 * (either a ref.current or e.currentTarget) and `e.target`, so an enter
	 * from a portaled child (context menu, picker) is ignored.
	 */
	function onMouseEnter(taskId: string, anchorEl: HTMLElement, target?: EventTarget | null) {
		if (isDraggingRef.current) return;
		// React fires mouseenter along the component tree, so pointing at a portaled
		// child (context menu, submenu, popover) counts as entering the anchor. Ignore it.
		if (target instanceof Node && !anchorEl.contains(target)) return;
		// No hover preview on touch / narrow (mobile carousel) viewports.
		if (!hoverPreviewEnabled()) return;
		if (anyMenuOpen()) return;
		// Already opening or open for this task: just keep it, never restart the poll.
		if (activeTaskIdRef.current === taskId && activeAnchorRef.current === anchorEl) {
			cancelClose();
			return;
		}
		cancelTimers();
		if (activeTaskIdRef.current) {
			close();
		}
		activeTaskIdRef.current = taskId;
		activeAnchorRef.current = anchorEl;

		openTimerRef.current = setTimeout(() => {
			if (!anchorEl.isConnected || anyMenuOpen()) {
				activeTaskIdRef.current = null;
				activeAnchorRef.current = null;
				return;
			}
			const gen = ++genRef.current;
			openedRef.current = true;
			const rect = anchorEl.getBoundingClientRect();

			setPos(clampPosition(rect));
			setOpen(true);
			setLoading(true);
			setActiveTaskId(taskId);

			const capture = async (first: boolean) => {
				try {
					const content = await api.request.getTerminalPreview({ taskId });
					if (gen !== genRef.current) return;
					if (content) {
						setHtml(ansiToHtml(content));
					} else if (first) {
						setHtml(null);
					}
				} catch {
					if (gen !== genRef.current) return;
					if (first) setHtml(null);
				}
				if (first) setLoading(false);
				pollTimerRef.current = setTimeout(() => capture(false), REFRESH_INTERVAL);
			};
			capture(true);
		}, OPEN_DELAY);
	}

	function onMouseLeave() {
		if (openTimerRef.current) {
			clearTimeout(openTimerRef.current);
			openTimerRef.current = null;
		}
		if (openedRef.current) {
			scheduleClose();
		} else {
			activeTaskIdRef.current = null;
			activeAnchorRef.current = null;
		}
	}

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			cancelTimers();
			genRef.current++;
			if (pollTimerRef.current) {
				clearTimeout(pollTimerRef.current);
				pollTimerRef.current = null;
			}
		};
	}, [cancelTimers]);

	// Disable previews while a drag-and-drop is in progress.
	useEffect(() => {
		const onDragStart = () => {
			isDraggingRef.current = true;
			close();
		};
		const onDragEnd = () => {
			isDraggingRef.current = false;
		};
		window.addEventListener("dragstart", onDragStart, true);
		window.addEventListener("dragend", onDragEnd, true);
		window.addEventListener("drop", onDragEnd, true);
		return () => {
			window.removeEventListener("dragstart", onDragStart, true);
			window.removeEventListener("dragend", onDragEnd, true);
			window.removeEventListener("drop", onDragEnd, true);
		};
	}, [close]);

	return {
		state: { open, html, loading, pos, activeTaskId, cancelClose, scheduleClose },
		handlers: { onMouseEnter, onMouseLeave },
		close,
	};
}
