import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { hideControl } from "../hidden-controls";
import type { HideableControlId } from "../hideable-controls";

/** Where a context menu opens: the pointer, or under the control for the keyboard's menu key (no pointer). */
export function contextMenuPosition(e: ReactMouseEvent): { top: number; left: number } {
	if (e.clientX !== 0 || e.clientY !== 0) return { top: e.clientY, left: e.clientX };
	const rect = (e.target as Element).getBoundingClientRect();
	return { top: rect.bottom + 4, left: rect.left };
}

/**
 * Right-click "Hide" on a global-header control (PRODUCT_UX_BIBLE.md §5.10).
 * Desktop by design — touch/remote restore through the header kebab instead.
 * Closing returns focus to whatever had it when the menu opened.
 */
export function useHideContextMenu(id: HideableControlId) {
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	const close = useCallback(() => {
		setPos(null);
		returnFocus.current?.focus();
		returnFocus.current = null;
	}, []);

	const onContextMenu = useCallback((e: ReactMouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setPos(contextMenuPosition(e));
	}, []);

	const onHide = useCallback(() => {
		void hideControl(id);
	}, [id]);

	return { pos, onContextMenu, onHide, close };
}
