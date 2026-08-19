import { describe, expect, it } from "vitest";
import { menuFlyoutAnchorRect } from "../menuFlyout";
import { computeAnchoredPosition } from "../popoverPosition";

/** The header kebab: a 208px menu hanging off the right edge of a 1600px viewport. */
const MENU = { top: 60, bottom: 400, height: 340, left: 1376, right: 1584, width: 208 };
/** The "tmux Sessions" row inside it. */
const ROW = { top: 150, bottom: 186, height: 36, left: 1376, right: 1584, width: 208 };

describe("menuFlyoutAnchorRect", () => {
	it("takes the horizontal extent from the menu and the vertical from the row", () => {
		const anchor = menuFlyoutAnchorRect(ROW, MENU);
		expect(anchor.left).toBe(MENU.left);
		expect(anchor.right).toBe(MENU.right);
		expect(anchor.top).toBe(ROW.top);
		expect(anchor.bottom).toBe(ROW.bottom);
	});

	it("falls back to the row when there is no menu around it", () => {
		expect(menuFlyoutAnchorRect(ROW, null)).toEqual(ROW);
	});
});

describe("a flyout placed from a menu row", () => {
	const pop = { width: 360, height: 400 };

	it("never covers the menu — it ends before the menu's left edge", () => {
		const anchor = menuFlyoutAnchorRect(ROW, MENU);
		const { top, left, placement } = computeAnchoredPosition(anchor, pop, {
			placement: "left",
			align: "start",
			viewport: { width: 1600, height: 900 },
		});
		expect(placement).toBe("left");
		expect(left + pop.width).toBeLessThanOrEqual(MENU.left);
		// Level with the row the pointer is on, not with the top of the menu.
		expect(top).toBe(ROW.top);
	});

	it("anchors on the MENU's edge, so a narrower row cannot slide it under the list", () => {
		const rowOnly = computeAnchoredPosition(ROW, pop, {
			placement: "left",
			align: "start",
			viewport: { width: 1600, height: 900 },
		});
		const viaMenu = computeAnchoredPosition(menuFlyoutAnchorRect(ROW, MENU), pop, {
			placement: "left",
			align: "start",
			viewport: { width: 1600, height: 900 },
		});
		// Same here (row spans the menu), and both must clear the menu's left edge.
		expect(viaMenu.left).toBe(rowOnly.left);
		expect(viaMenu.left + pop.width).toBeLessThanOrEqual(MENU.left);
	});

	it("keeps a tall flyout inside the viewport instead of running off the bottom", () => {
		const tall = { width: 360, height: 700 };
		const { top } = computeAnchoredPosition(menuFlyoutAnchorRect(ROW, MENU), tall, {
			placement: "left",
			align: "start",
			viewport: { width: 1600, height: 900 },
		});
		expect(top).toBeGreaterThanOrEqual(8);
		expect(top + tall.height).toBeLessThanOrEqual(900 - 8);
	});
});
