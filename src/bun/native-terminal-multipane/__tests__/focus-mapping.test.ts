import { describe, expect, it } from "vitest";
import { createSplitTree, listPaneIds, splitPane, zoomPane, type SplitTree } from "../../../shared/split-tree";
import { CoordinatorClientView } from "../client-view";
import { directionalFocusTarget, normalizeSharedLayout } from "../focus-mapping";

function grid(count: number): SplitTree {
	let tree = createSplitTree();
	let last = "pane-1";
	for (let index = 1; index < count; index++) {
		tree = splitPane(tree, last, index % 2 === 1 ? "horizontal" : "vertical");
		last = tree.activePaneId;
	}
	return normalizeSharedLayout(tree);
}

describe("shared layout normalization", () => {
	it("parks focus on the first pane and clears zoom", () => {
		const zoomed = zoomPane(splitPane(createSplitTree(), "pane-1", "horizontal"), "pane-2");
		const shared = normalizeSharedLayout(zoomed);
		expect(shared.activePaneId).toBe("pane-1");
		expect(shared.zoomedPaneId).toBeNull();
		expect(listPaneIds(shared)).toEqual(["pane-1", "pane-2"]);
	});

	it("returns the same reference when already normalized", () => {
		const shared = grid(4);
		expect(normalizeSharedLayout(shared)).toBe(shared);
	});
});

describe("directional focus mapping", () => {
	it("moves right and back left across a horizontal split", () => {
		const tree = grid(2);
		expect(directionalFocusTarget(tree, "pane-1", "right")).toBe("pane-2");
		expect(directionalFocusTarget(tree, "pane-2", "left")).toBe("pane-1");
	});

	it("stays put when there is no pane that way", () => {
		const tree = grid(2);
		expect(directionalFocusTarget(tree, "pane-1", "left")).toBe("pane-1");
		expect(directionalFocusTarget(tree, "pane-1", "up")).toBe("pane-1");
	});

	it("never mutates the shared tree, even across six panes", () => {
		const tree = grid(6);
		const snapshot = structuredClone(tree);
		for (const paneId of listPaneIds(tree)) {
			for (const direction of ["left", "right", "up", "down"] as const) {
				expect(listPaneIds(tree)).toContain(directionalFocusTarget(tree, paneId, direction));
			}
		}
		expect(tree).toEqual(snapshot);
	});

	it("falls back to the first pane for an unknown origin", () => {
		expect(directionalFocusTarget(grid(3), "pane-99", "down")).toBe("pane-1");
	});
});

describe("coordinator client views", () => {
	it("keeps focus and zoom local to each view", () => {
		const tree = grid(4);
		const paneIds = listPaneIds(tree);
		const viewA = new CoordinatorClientView("a", paneIds);
		const viewB = new CoordinatorClientView("b", paneIds);

		viewA.focusDirection(tree, "right");
		viewA.toggleZoom();
		expect(viewB.focusedPaneId).toBe(paneIds[0]);
		expect(viewB.zoomedPaneId).toBeNull();
		expect(viewA.zoomedPaneId).toBe(viewA.focusedPaneId);
	});

	it("reconciles a removed pane per view without touching the other", () => {
		const tree = grid(3);
		const paneIds = listPaneIds(tree);
		const viewA = new CoordinatorClientView("a", paneIds);
		const viewB = new CoordinatorClientView("b", paneIds);
		viewA.focus(paneIds[2]!);
		viewA.zoom(paneIds[2]!);

		const remaining = paneIds.filter((id) => id !== paneIds[2]);
		viewA.observe(remaining);
		expect(viewA.zoomedPaneId).toBeNull();
		expect(remaining).toContain(viewA.focusedPaneId);
		expect(viewB.layout.paneIds).toEqual(paneIds);
	});
});
