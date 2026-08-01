/**
 * NativePaneDividers — the grab handles on native SplitTree boundaries.
 *
 * Verifies: one separator per split, nothing when there is no split or the view is
 * zoomed, a drag that commits once on release, clamping at the minimum pane size,
 * cancellation (pointercancel / Escape) leaving the ratio alone, and keyboard steps.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSplitTree, splitPane, zoomPane, type SplitTree } from "../../../shared/split-tree";
import { I18nProvider } from "../../i18n";
import NativePaneDividers from "../NativePaneDividers";

const LAYER_WIDTH = 1000;
const LAYER_HEIGHT = 600;

let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
	originalRect = HTMLElement.prototype.getBoundingClientRect;
	HTMLElement.prototype.getBoundingClientRect = function () {
		return { x: 0, y: 0, top: 0, left: 0, right: LAYER_WIDTH, bottom: LAYER_HEIGHT, width: LAYER_WIDTH, height: LAYER_HEIGHT, toJSON: () => ({}) } as DOMRect;
	};
	// happy-dom has no pointer capture; the component only needs it to not throw.
	Element.prototype.setPointerCapture = vi.fn();
	Element.prototype.releasePointerCapture = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
});

afterEach(() => {
	HTMLElement.prototype.getBoundingClientRect = originalRect;
	document.body.style.cursor = "";
	document.body.style.userSelect = "";
});

/** pane-1 | pane-2, then pane-2 split into pane-2 over pane-3. */
function nestedTree(): SplitTree {
	let tree = createSplitTree();
	tree = splitPane(tree, "pane-1", "horizontal");
	return splitPane(tree, "pane-2", "vertical");
}

function renderDividers(tree: SplitTree, onCommitRatio = vi.fn()) {
	const paneIndexById = new Map([["pane-1", 1], ["pane-2", 2], ["pane-3", 3]]);
	render(
		<I18nProvider>
			<NativePaneDividers tree={tree} paneIndexById={paneIndexById} onCommitRatio={onCommitRatio} />
		</I18nProvider>,
	);
	return onCommitRatio;
}

function drag(splitId: string, from: { x: number; y: number }, to: { x: number; y: number }, release = "pointerup") {
	const strip = screen.getByTestId(`pane-divider-${splitId}`);
	fireEvent.pointerDown(strip, { button: 0, pointerId: 1, clientX: from.x, clientY: from.y });
	fireEvent.pointerMove(strip, { pointerId: 1, clientX: to.x, clientY: to.y });
	if (release === "pointerup") fireEvent.pointerUp(window, { pointerId: 1 });
	else if (release === "pointercancel") fireEvent.pointerCancel(window, { pointerId: 1 });
	else fireEvent.keyDown(window, { key: "Escape" });
	return strip;
}

describe("NativePaneDividers", () => {
	it("renders one separator per split boundary", () => {
		renderDividers(nestedTree());
		expect(screen.getAllByRole("separator")).toHaveLength(2);
		expect(screen.getByTestId("pane-divider-split-1")).toBeTruthy();
		expect(screen.getByTestId("pane-divider-split-2")).toBeTruthy();
	});

	it("renders nothing for a single pane", () => {
		renderDividers(createSplitTree());
		expect(screen.queryByTestId("native-pane-dividers")).toBeNull();
	});

	it("renders nothing while a pane is zoomed", () => {
		renderDividers(zoomPane(nestedTree(), "pane-2"));
		expect(screen.queryByTestId("native-pane-dividers")).toBeNull();
	});

	it("gives each boundary the right axis, cursor and value", () => {
		renderDividers(nestedTree());
		const vertical = screen.getByTestId("pane-divider-split-1");
		const horizontal = screen.getByTestId("pane-divider-split-2");
		expect(vertical.getAttribute("aria-orientation")).toBe("vertical");
		expect(vertical.className).toContain("cursor-col-resize");
		expect(horizontal.getAttribute("aria-orientation")).toBe("horizontal");
		expect(horizontal.className).toContain("cursor-row-resize");
		expect(vertical.getAttribute("aria-valuenow")).toBe("50");
		expect(vertical.getAttribute("aria-valuemin")).toBe("10");
		expect(vertical.getAttribute("aria-valuemax")).toBe("90");
	});

	it("commits exactly once, on release, with the dragged ratio", () => {
		const onCommit = renderDividers(nestedTree());
		drag("split-1", { x: 500, y: 300 }, { x: 700, y: 300 });
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit.mock.calls[0][0]).toBe("split-1");
		expect(onCommit.mock.calls[0][1]).toBeCloseTo(0.7, 5);
	});

	it("shows a ghost line during the drag and drops it on release", () => {
		renderDividers(nestedTree());
		const strip = screen.getByTestId("pane-divider-split-1");
		fireEvent.pointerDown(strip, { button: 0, pointerId: 1, clientX: 500, clientY: 300 });
		expect(screen.getByTestId("pane-divider-ghost")).toBeTruthy();
		expect(strip.getAttribute("data-dragging")).toBe("true");
		fireEvent.pointerUp(window, { pointerId: 1 });
		expect(screen.queryByTestId("pane-divider-ghost")).toBeNull();
	});

	it("never squeezes a pane below the minimum size", () => {
		const onCommit = renderDividers(nestedTree());
		drag("split-1", { x: 500, y: 300 }, { x: 5000, y: 300 });
		expect(onCommit.mock.calls[0][1]).toBeLessThanOrEqual(0.9);
		expect(onCommit.mock.calls[0][1]).toBeGreaterThan(0.5);
	});

	it("drags a horizontal boundary along its own axis only", () => {
		const onCommit = renderDividers(nestedTree());
		// split-2 owns the right-hand column: 700px wide, full height.
		drag("split-2", { x: 800, y: 300 }, { x: 900, y: 420 });
		expect(onCommit.mock.calls[0][0]).toBe("split-2");
		expect(onCommit.mock.calls[0][1]).toBeCloseTo(0.7, 5);
	});

	it("commits nothing when the pointer is cancelled", () => {
		const onCommit = renderDividers(nestedTree());
		drag("split-1", { x: 500, y: 300 }, { x: 700, y: 300 }, "pointercancel");
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("commits nothing when the drag is escaped", () => {
		const onCommit = renderDividers(nestedTree());
		drag("split-1", { x: 500, y: 300 }, { x: 700, y: 300 }, "escape");
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("restores the page cursor after a drag ends", () => {
		renderDividers(nestedTree());
		const strip = screen.getByTestId("pane-divider-split-1");
		fireEvent.pointerDown(strip, { button: 0, pointerId: 1, clientX: 500, clientY: 300 });
		expect(document.body.style.cursor).toBe("col-resize");
		fireEvent.pointerUp(window, { pointerId: 1 });
		expect(document.body.style.cursor).toBe("");
	});

	it("ignores a non-primary button", () => {
		const onCommit = renderDividers(nestedTree());
		const strip = screen.getByTestId("pane-divider-split-1");
		fireEvent.pointerDown(strip, { button: 2, pointerId: 1, clientX: 500, clientY: 300 });
		fireEvent.pointerUp(window, { pointerId: 1 });
		expect(onCommit).not.toHaveBeenCalled();
		expect(screen.queryByTestId("pane-divider-ghost")).toBeNull();
	});

	it("steps the ratio with the arrow keys of its own axis", () => {
		const onCommit = renderDividers(nestedTree());
		const vertical = screen.getByTestId("pane-divider-split-1");
		fireEvent.keyDown(vertical, { key: "ArrowRight" });
		expect(onCommit).toHaveBeenLastCalledWith("split-1", expect.closeTo(0.52, 5));
		fireEvent.keyDown(vertical, { key: "ArrowLeft", shiftKey: true });
		expect(onCommit).toHaveBeenLastCalledWith("split-1", expect.closeTo(0.4, 5));
		fireEvent.keyDown(vertical, { key: "ArrowDown" });
		expect(onCommit).toHaveBeenCalledTimes(2);
	});

	it("resets a boundary to the middle on double click", () => {
		const tree = nestedTree();
		const onCommit = renderDividers(tree);
		fireEvent.doubleClick(screen.getByTestId("pane-divider-split-1"));
		expect(onCommit).toHaveBeenCalledWith("split-1", 0.5);
	});

	it("names the two panes it separates", () => {
		renderDividers(nestedTree());
		expect(screen.getByTestId("pane-divider-split-2").getAttribute("aria-label")).toContain("Pane 2");
		expect(screen.getByTestId("pane-divider-split-2").getAttribute("aria-label")).toContain("Pane 3");
	});
});
