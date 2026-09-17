import { useCallback, useState, type MouseEvent as ReactMouseEvent } from "react";
import { hideControl } from "../hidden-controls";
import type { HideableControlId } from "../hideable-controls";
import { useEscapeKey } from "./useEscapeKey";

/**
 * Right-click "Hide" on any registered control (PRODUCT_UX_BIBLE.md §5.10).
 * Desktop-only by design — touch/remote have no right click, so those
 * surfaces offer a Hide affordance inline instead (a small icon on the row).
 */
export function useHideContextMenu(id: HideableControlId) {
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const close = useCallback(() => setPos(null), []);
	useEscapeKey(close, { enabled: pos !== null });

	const onContextMenu = useCallback((e: ReactMouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setPos({ top: e.clientY, left: e.clientX });
	}, []);

	const onHide = useCallback(() => {
		hideControl(id);
		close();
	}, [id, close]);

	return { open: pos !== null, pos, onContextMenu, onHide, close };
}
