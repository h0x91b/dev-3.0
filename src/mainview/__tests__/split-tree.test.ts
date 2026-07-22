import { describe, expect, it } from "vitest";
import {
	activatePane,
	closePane,
	createSplitTree,
	focusPane,
	listPaneIds,
	MAX_SPLIT_RATIO,
	MIN_SPLIT_RATIO,
	resizeSplit,
	restoreSplitTree,
	serializeSplitTree,
	setSplitRatio,
	splitPane,
	toggleZoom,
	unzoomPane,
	validateSplitTree,
	zoomPane,
} from "../../shared/split-tree";

describe("SplitTree", () => {
	it("creates one valid active pane and splits it deterministically", () => {
		const initial = createSplitTree();
		expect(listPaneIds(initial)).toEqual(["pane-1"]);
		expect(initial.activePaneId).toBe("pane-1");
		expect(validateSplitTree(initial)).toEqual({ valid: true, errors: [] });

		const split = splitPane(initial, "pane-1", "horizontal");
		expect(listPaneIds(split)).toEqual(["pane-1", "pane-2"]);
		expect(split.activePaneId).toBe("pane-2");
		expect(split.root).toMatchObject({
			type: "split",
			id: "split-1",
			orientation: "horizontal",
			ratio: 0.5,
		});
		expect(validateSplitTree(split)).toEqual({ valid: true, errors: [] });

		const repeated = splitPane(createSplitTree(), "pane-1", "horizontal");
		expect(repeated).toEqual(split);
	});

	it("closes a pane without leaving an empty branch and keeps the last pane", () => {
		const onlyPane = createSplitTree();
		expect(closePane(onlyPane, "pane-1")).toBe(onlyPane);

		const split = splitPane(onlyPane, "pane-1", "vertical");
		const firstActive = activatePane(split, "pane-1");
		const closed = closePane(firstActive, "pane-1");

		expect(closed.root).toEqual({ type: "pane", id: "pane-2" });
		expect(closed.activePaneId).toBe("pane-2");
		expect(listPaneIds(closed)).toEqual(["pane-2"]);
		expect(validateSplitTree(closed)).toEqual({ valid: true, errors: [] });
	});

	it("moves directional focus by layout geometry without changing the tree", () => {
		let grid = splitPane(createSplitTree(), "pane-1", "horizontal");
		grid = splitPane(grid, "pane-1", "vertical");
		grid = splitPane(grid, "pane-2", "vertical");
		grid = activatePane(grid, "pane-1");

		expect(focusPane(grid, "right").activePaneId).toBe("pane-2");
		expect(focusPane(grid, "down").activePaneId).toBe("pane-3");

		const lowerLeft = focusPane(grid, "down");
		expect(focusPane(lowerLeft, "right").activePaneId).toBe("pane-4");
		expect(focusPane(lowerLeft, "up").activePaneId).toBe("pane-1");
		expect(focusPane(grid, "left")).toBe(grid);
		expect(focusPane(grid, "up")).toBe(grid);
	});

	it("resizes a branch ratio within hard bounds", () => {
		const tree = splitPane(createSplitTree(), "pane-1", "horizontal");
		const larger = setSplitRatio(tree, "split-1", 2);
		expect(larger.root).toMatchObject({ ratio: MAX_SPLIT_RATIO });
		expect(tree.root).toMatchObject({ ratio: 0.5 });

		const smaller = resizeSplit(larger, "split-1", -2);
		expect(smaller.root).toMatchObject({ ratio: MIN_SPLIT_RATIO });
		expect(validateSplitTree(smaller)).toEqual({ valid: true, errors: [] });
		expect(setSplitRatio(tree, "missing", 0.7)).toBe(tree);
	});

	it("zooms exactly one pane and restores the full layout", () => {
		const tree = splitPane(createSplitTree(), "pane-1", "horizontal");
		const zoomed = zoomPane(tree, "pane-1");
		expect(zoomed.activePaneId).toBe("pane-1");
		expect(zoomed.zoomedPaneId).toBe("pane-1");
		expect(validateSplitTree(zoomed)).toEqual({ valid: true, errors: [] });

		expect(toggleZoom(zoomed, "pane-1").zoomedPaneId).toBeNull();
		expect(unzoomPane(zoomed).zoomedPaneId).toBeNull();
		expect(zoomPane(tree, "missing")).toBe(tree);

		const splitWhileZoomed = splitPane(zoomed, "pane-1", "vertical");
		expect(splitWhileZoomed.activePaneId).toBe("pane-3");
		expect(splitWhileZoomed.zoomedPaneId).toBe("pane-3");
	});

	it("round-trips a layout without changing logical pane ids", () => {
		let tree = splitPane(createSplitTree(), "pane-1", "horizontal");
		tree = splitPane(tree, "pane-2", "vertical");
		tree = setSplitRatio(tree, "split-1", 0.37);
		tree = zoomPane(tree, "pane-2");

		const restored = restoreSplitTree(serializeSplitTree(tree));
		expect(restored).toEqual(tree);
		expect(listPaneIds(restored!)).toEqual(["pane-1", "pane-2", "pane-3"]);
	});

	it("rejects malformed restores instead of materializing an invalid tree", () => {
		const valid = createSplitTree();
		const malformed = [
			"not-json",
			JSON.stringify({ ...valid, activePaneId: "missing" }),
			JSON.stringify({ ...valid, root: { type: "split", id: "split-1", orientation: "horizontal", ratio: 0.5, first: null, second: valid.root } }),
			JSON.stringify({ ...valid, root: { type: "split", id: "split-1", orientation: "horizontal", ratio: 0.01, first: valid.root, second: valid.root } }),
		];

		for (const serialized of malformed) {
			expect(() => restoreSplitTree(serialized)).not.toThrow();
			expect(restoreSplitTree(serialized)).toBeNull();
		}
	});

	it("preserves structural invariants across deterministic operation sequences", () => {
		const directions = ["left", "right", "up", "down"] as const;
		for (let seed = 1; seed <= 40; seed++) {
			let randomState = seed;
			const next = () => {
				randomState ^= randomState << 13;
				randomState ^= randomState >>> 17;
				randomState ^= randomState << 5;
				return randomState >>> 0;
			};
			let tree = createSplitTree();

			for (let step = 0; step < 80; step++) {
				const previous = tree;
				const before = serializeSplitTree(tree);
				const panes = listPaneIds(tree);
				const paneId = panes[next() % panes.length];
				const splitIds: string[] = [];
				const collectSplits = (node: typeof tree.root) => {
					if (node.type === "pane") return;
					splitIds.push(node.id);
					collectSplits(node.first);
					collectSplits(node.second);
				};
				collectSplits(tree.root);

				switch (next() % 8) {
					case 0:
						tree = splitPane(tree, paneId, next() % 2 === 0 ? "horizontal" : "vertical");
						break;
					case 1:
						tree = closePane(tree, paneId);
						break;
					case 2:
						tree = activatePane(tree, paneId);
						break;
					case 3:
						tree = focusPane(tree, directions[next() % directions.length]);
						break;
					case 4:
						if (splitIds.length > 0) {
							tree = setSplitRatio(tree, splitIds[next() % splitIds.length], (next() % 180) / 100 - 0.4);
						}
						break;
					case 5:
						tree = toggleZoom(tree, paneId);
						break;
					case 6:
						tree = unzoomPane(tree);
						break;
					default:
						tree = restoreSplitTree(serializeSplitTree(tree))!;
				}

				expect(serializeSplitTree(previous)).toBe(before);
				const ids = listPaneIds(tree);
				expect(ids.length).toBeGreaterThan(0);
				expect(new Set(ids).size).toBe(ids.length);
				expect(ids).toContain(tree.activePaneId);
				expect(validateSplitTree(tree)).toEqual({ valid: true, errors: [] });
				expect(restoreSplitTree(serializeSplitTree(tree))).toEqual(tree);
			}
		}
	});
});
