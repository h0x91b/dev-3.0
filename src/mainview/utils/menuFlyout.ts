import { computeAnchoredPosition, type RectLike, type SizeLike } from "./popoverPosition";

/**
 * Positioning for a detail panel opened from a row of the header overflow menu
 * (memory breakdown, tmux session list).
 *
 * Two rules make such a panel usable. It hangs off the **menu's** outboard edge,
 * not the row's, so it never lands on top of the menu the pointer is still
 * travelling down. And it opens on hover intent, because a row that only reacts
 * to a click looks like a label — which is exactly how the memory and tmux rows
 * became invisible after they moved into the kebab.
 */

/** Hover dwell before a row opens its flyout — long enough to scan the list past it. */
export const MENU_FLYOUT_HOVER_MS = 180;
/** Hover-out grace so the pointer can cross the gap between menu and flyout. */
export const MENU_FLYOUT_CLOSE_MS = 200;

/**
 * The rect a flyout is anchored to: the menu's horizontal extent, the row's
 * vertical one. Pure, so the geometry is unit-testable without a DOM.
 */
export function menuFlyoutAnchorRect(row: RectLike, menu: RectLike | null): RectLike {
	if (!menu) return row;
	return {
		top: row.top,
		bottom: row.bottom,
		height: row.height,
		left: menu.left,
		right: menu.right,
		width: menu.width,
	};
}

/** Place `pop` beside the menu that owns `rowEl`, level with the row. */
export function computeMenuFlyoutPosition(rowEl: HTMLElement, pop: SizeLike): { top: number; left: number } {
	const menuEl = rowEl.closest('[role="menu"]');
	const anchor = menuFlyoutAnchorRect(
		rowEl.getBoundingClientRect(),
		menuEl ? menuEl.getBoundingClientRect() : null,
	);
	const { top, left } = computeAnchoredPosition(anchor, pop, { placement: "left", align: "start" });
	return { top, left };
}
