import { useCallback, useEffect, useRef, useState } from "react";

/** How long a finger must rest before a long press counts as a right click. */
const LONG_PRESS_MS = 500;
/** Movement past this many pixels is a scroll, not a press. */
const LONG_PRESS_SLOP_PX = 10;

export interface ContextMenuTrigger {
	/** Cursor position the menu opens at, or null while closed. */
	pos: { x: number; y: number } | null;
	open: (pos: { x: number; y: number }) => void;
	close: () => void;
	/** Spread onto the element that owns the menu. */
	handlers: {
		onContextMenu: (e: React.MouseEvent) => void;
		onTouchStart: (e: React.TouchEvent) => void;
		onTouchMove: (e: React.TouchEvent) => void;
		onTouchEnd: () => void;
	};
	/** True right after a long press, so the host can drop the click that follows. */
	swallowClick: () => boolean;
}

/**
 * Right-click (desktop) and long-press (touch) opener for an object's context
 * menu. Touch has no contextmenu event of its own on every engine, and React's
 * passive touch listeners cannot preventDefault the click that follows a long
 * press — so the host asks {@link ContextMenuTrigger.swallowClick} before acting
 * on its own onClick.
 */
export function useContextMenu(disabled = false): ContextMenuTrigger {
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const startRef = useRef<{ x: number; y: number } | null>(null);
	const longPressedAtRef = useRef(0);

	const cancelTimer = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	useEffect(() => cancelTimer, [cancelTimer]);

	const open = useCallback((next: { x: number; y: number }) => setPos(next), []);
	const close = useCallback(() => setPos(null), []);

	const onContextMenu = useCallback(
		(e: React.MouseEvent) => {
			if (disabled) return;
			e.preventDefault();
			e.stopPropagation();
			setPos({ x: e.clientX, y: e.clientY });
		},
		[disabled],
	);

	const onTouchStart = useCallback(
		(e: React.TouchEvent) => {
			if (disabled || e.touches.length !== 1) return;
			const touch = e.touches[0];
			startRef.current = { x: touch.clientX, y: touch.clientY };
			cancelTimer();
			timerRef.current = setTimeout(() => {
				longPressedAtRef.current = Date.now();
				setPos({ x: touch.clientX, y: touch.clientY });
			}, LONG_PRESS_MS);
		},
		[cancelTimer, disabled],
	);

	const onTouchMove = useCallback(
		(e: React.TouchEvent) => {
			const start = startRef.current;
			const touch = e.touches[0];
			if (!start || !touch) return;
			if (Math.abs(touch.clientX - start.x) > LONG_PRESS_SLOP_PX || Math.abs(touch.clientY - start.y) > LONG_PRESS_SLOP_PX) {
				cancelTimer();
			}
		},
		[cancelTimer],
	);

	const swallowClick = useCallback(() => Date.now() - longPressedAtRef.current < 600, []);

	return {
		pos,
		open,
		close,
		handlers: { onContextMenu, onTouchStart, onTouchMove, onTouchEnd: cancelTimer },
		swallowClick,
	};
}
