import { describe, expect, it } from "vitest";
import {
	createSplitTree,
	getPaneRects,
	listPaneIds,
	splitPane,
	validateSplitTree,
	zoomPane,
	type SplitTree,
} from "../../shared/split-tree";
import {
	applySplitLayout,
	nextSplitLayoutPreset,
	SPLIT_LAYOUT_PRESETS,
	type SplitLayoutPreset,
} from "../../shared/split-tree-layouts";

function treeWith(paneCount: number): SplitTree {
	let tree = createSplitTree();
	while (listPaneIds(tree).length < paneCount) {
		tree = splitPane(tree, tree.activePaneId, "horizontal");
	}
	return tree;
}

const COUNTS = [2, 3, 4, 5, 6, 7, 8, 9, 12, 16];

describe("applySplitLayout", () => {
	it("leaves a single-pane tree untouched", () => {
		const tree = createSplitTree();
		for (const preset of SPLIT_LAYOUT_PRESETS) {
			expect(applySplitLayout(tree, preset)).toBe(tree);
		}
	});

	it("produces a valid tree for every preset and pane count", () => {
		for (const count of COUNTS) {
			const tree = treeWith(count);
			for (const preset of SPLIT_LAYOUT_PRESETS) {
				const laid = applySplitLayout(tree, preset);
				expect(validateSplitTree(laid), `${preset} with ${count} panes`).toEqual({ valid: true, errors: [] });
			}
		}
	});

	it("keeps the same pane ids in the same order", () => {
		for (const count of COUNTS) {
			const tree = treeWith(count);
			const before = listPaneIds(tree);
			for (const preset of SPLIT_LAYOUT_PRESETS) {
				expect(listPaneIds(applySplitLayout(tree, preset))).toEqual(before);
			}
		}
	});

	it("keeps the active and zoomed pane", () => {
		const tree = zoomPane(treeWith(4));
		const laid = applySplitLayout(tree, "tiled");
		expect(laid.activePaneId).toBe(tree.activePaneId);
		expect(laid.zoomedPaneId).toBe(tree.zoomedPaneId);
	});

	it("gives every pane an identical rect for the even presets", () => {
		for (const count of COUNTS) {
			const tree = treeWith(count);
			for (const preset of ["even-horizontal", "even-vertical"] as SplitLayoutPreset[]) {
				const rects = [...getPaneRects(applySplitLayout(tree, preset)).values()];
				const expected = 1 / count;
				for (const rect of rects) {
					const size = preset === "even-horizontal" ? rect.width : rect.height;
					expect(size, `${preset} with ${count} panes`).toBeCloseTo(expected, 10);
					const cross = preset === "even-horizontal" ? rect.height : rect.width;
					expect(cross).toBeCloseTo(1, 10);
				}
			}
		}
	});

	it("lays even-horizontal left-to-right and even-vertical top-to-bottom", () => {
		const tree = treeWith(3);
		const ids = listPaneIds(tree);
		const across = getPaneRects(applySplitLayout(tree, "even-horizontal"));
		ids.forEach((id, index) => expect(across.get(id)!.x).toBeCloseTo(index / 3, 10));
		const down = getPaneRects(applySplitLayout(tree, "even-vertical"));
		ids.forEach((id, index) => expect(down.get(id)!.y).toBeCloseTo(index / 3, 10));
	});

	it("gives the first pane a full-width top half in main-horizontal", () => {
		const tree = treeWith(4);
		const ids = listPaneIds(tree);
		const rects = getPaneRects(applySplitLayout(tree, "main-horizontal"));
		const main = rects.get(ids[0])!;
		expect(main).toMatchObject({ x: 0, y: 0, width: 1, height: 0.5 });
		for (const id of ids.slice(1)) {
			const rect = rects.get(id)!;
			expect(rect.y).toBeCloseTo(0.5, 10);
			expect(rect.height).toBeCloseTo(0.5, 10);
			expect(rect.width).toBeCloseTo(1 / 3, 10);
		}
	});

	it("gives the first pane a full-height left half in main-vertical", () => {
		const tree = treeWith(3);
		const ids = listPaneIds(tree);
		const rects = getPaneRects(applySplitLayout(tree, "main-vertical"));
		expect(rects.get(ids[0])!).toMatchObject({ x: 0, y: 0, width: 0.5, height: 1 });
		for (const id of ids.slice(1)) {
			const rect = rects.get(id)!;
			expect(rect.x).toBeCloseTo(0.5, 10);
			expect(rect.width).toBeCloseTo(0.5, 10);
			expect(rect.height).toBeCloseTo(0.5, 10);
		}
	});

	it("tiles six panes into three columns over two rows", () => {
		const tree = treeWith(6);
		const rects = getPaneRects(applySplitLayout(tree, "tiled"));
		const columns = new Set([...rects.values()].map((rect) => rect.x.toFixed(4)));
		const rows = new Set([...rects.values()].map((rect) => rect.y.toFixed(4)));
		expect(columns.size).toBe(3);
		expect(rows.size).toBe(2);
		for (const rect of rects.values()) {
			expect(rect.width).toBeCloseTo(1 / 3, 10);
			expect(rect.height).toBeCloseTo(0.5, 10);
		}
	});

	it("never reuses a split id and never rewinds the ordinal", () => {
		const tree = treeWith(7);
		for (const preset of SPLIT_LAYOUT_PRESETS) {
			const laid = applySplitLayout(tree, preset);
			expect(laid.nextSplitOrdinal).toBeGreaterThanOrEqual(tree.nextSplitOrdinal);
			const ids: string[] = [];
			const walk = (node: SplitTree["root"]): void => {
				if (node.type === "pane") return;
				ids.push(node.id);
				walk(node.first);
				walk(node.second);
			};
			walk(laid.root);
			expect(new Set(ids).size).toBe(ids.length);
			expect(ids.length).toBe(6);
		}
	});

	it("is idempotent", () => {
		const tree = treeWith(5);
		for (const preset of SPLIT_LAYOUT_PRESETS) {
			const once = applySplitLayout(tree, preset);
			const twice = applySplitLayout(once, preset);
			expect(getPaneRects(twice)).toEqual(getPaneRects(once));
		}
	});
});

describe("nextSplitLayoutPreset", () => {
	it("starts at the first preset and wraps around", () => {
		expect(nextSplitLayoutPreset(null)).toBe("even-horizontal");
		let preset = SPLIT_LAYOUT_PRESETS[0];
		const seen = [preset];
		for (let step = 0; step < SPLIT_LAYOUT_PRESETS.length - 1; step += 1) {
			preset = nextSplitLayoutPreset(preset);
			seen.push(preset);
		}
		expect(seen).toEqual([...SPLIT_LAYOUT_PRESETS]);
		expect(nextSplitLayoutPreset(preset)).toBe(SPLIT_LAYOUT_PRESETS[0]);
	});
});
