import { describe, expect, it } from "vitest";
import {
	createSplitTree,
	getPaneRects,
	getSplitBoundaries,
	setSplitRatio,
	splitPane,
	zoomPane,
} from "../../shared/split-tree";

/** pane-1 | pane-2 side by side, then pane-2 split into top/bottom. */
function nestedTree() {
	let tree = createSplitTree();
	tree = splitPane(tree, "pane-1", "horizontal"); // split-1: pane-1 | pane-2
	tree = splitPane(tree, "pane-2", "vertical");   // split-2: pane-2 over pane-3
	return tree;
}

describe("getSplitBoundaries", () => {
	it("has nothing to grab on a single pane", () => {
		expect(getSplitBoundaries(createSplitTree())).toEqual([]);
	});

	it("reports one boundary per split, in depth-first order", () => {
		const boundaries = getSplitBoundaries(nestedTree());
		expect(boundaries.map((b) => b.splitId)).toEqual(["split-1", "split-2"]);
		expect(boundaries.map((b) => b.orientation)).toEqual(["horizontal", "vertical"]);
	});

	it("places each boundary exactly on the edge its two panes share", () => {
		const tree = setSplitRatio(nestedTree(), "split-1", 0.3);
		const rects = getPaneRects(tree);
		const [outer, inner] = getSplitBoundaries(tree);

		// Outer: vertical line at x=0.3, spanning the full height.
		expect(outer.position).toBeCloseTo(0.3, 6);
		expect(outer.position).toBeCloseTo(rects.get("pane-1")!.x + rects.get("pane-1")!.width, 6);
		expect(outer.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });

		// Inner: horizontal line at y=0.5, spanning only the right-hand column.
		expect(inner.position).toBeCloseTo(0.5, 6);
		expect(inner.rect.x).toBeCloseTo(0.3, 6);
		expect(inner.rect.width).toBeCloseTo(0.7, 6);
	});

	it("names the two panes the boundary actually separates", () => {
		const [outer, inner] = getSplitBoundaries(nestedTree());
		expect([outer.firstPaneId, outer.secondPaneId]).toEqual(["pane-1", "pane-2"]);
		expect([inner.firstPaneId, inner.secondPaneId]).toEqual(["pane-2", "pane-3"]);
	});

	it("hides every boundary while a pane is zoomed", () => {
		const zoomed = zoomPane(nestedTree(), "pane-2");
		expect(getSplitBoundaries(zoomed)).toEqual([]);
	});

	it("tracks the ratio it is drawn from", () => {
		const tree = setSplitRatio(nestedTree(), "split-2", 0.8);
		const inner = getSplitBoundaries(tree).find((b) => b.splitId === "split-2")!;
		expect(inner.ratio).toBeCloseTo(0.8, 6);
		expect(inner.position).toBeCloseTo(0.8, 6);
	});
});
