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
 * For single-task: call `handlers.onMouseEnter(taskId)` with the same taskId.
 * For multi-task: call `handlers.onMouseEnter(taskId)` with different taskIds;
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
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const activeTaskIdRef = useRef<string | null>(null);
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
		if (intervalRef.current) {
			clearInterval(intervalRef.current);
			intervalRef.current = null;
		}
		setOpen(false);
		setHtml(null);
		setLoading(false);
		activeTaskIdRef.current = null;
		setActiveTaskId(null);
	}, [cancelTimers]);

	const scheduleClose = useCallback(() => {
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
	 * (either a ref.current or e.currentTarget).
	 */
	function onMouseEnter(taskId: string, anchorEl: HTMLElement) {
		if (isDraggingRef.current) return;
		// No hover preview on touch / narrow (mobile carousel) viewports.
		if (!hoverPreviewEnabled()) return;
		cancelTimers();
		if (activeTaskIdRef.current && activeTaskIdRef.current !== taskId) {
			close();
		}
		activeTaskIdRef.current = taskId;

		openTimerRef.current = setTimeout(async () => {
			if (!anchorEl.isConnected) return;
			const rect = anchorEl.getBoundingClientRect();
			const position = clampPosition(rect);

			setPos(position);
			setOpen(true);
			setLoading(true);
			setActiveTaskId(taskId);

			try {
				const content = await api.request.getTerminalPreview({ taskId });
				if (content) {
					setHtml(ansiToHtml(content));
				} else {
					setHtml(null);
				}
			} catch {
				setHtml(null);
			}
			setLoading(false);

			intervalRef.current = setInterval(async () => {
				try {
					const content = await api.request.getTerminalPreview({ taskId });
					if (content) {
						setHtml(ansiToHtml(content));
					}
				} catch {
					// ignore refresh errors
				}
			}, REFRESH_INTERVAL);
		}, OPEN_DELAY);
	}

	function onMouseLeave() {
		if (openTimerRef.current) {
			clearTimeout(openTimerRef.current);
			openTimerRef.current = null;
		}
		if (open) {
			scheduleClose();
		}
	}

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			cancelTimers();
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
				intervalRef.current = null;
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
