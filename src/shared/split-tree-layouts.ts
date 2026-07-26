/**
 * Named layout presets for a {@link SplitTree} — the honest native equivalent of
 * tmux's `even-horizontal`, `even-vertical`, `main-horizontal`, `main-vertical`
 * and `tiled` window layouts.
 *
 * Rebuilding is pure: pane ids keep their current order, the active and zoomed
 * pane survive, and every produced ratio stays inside the validator's bounds
 * because branches are halved by pane COUNT (`left/total`), never by a fixed
 * fraction that would collapse below `MIN_SPLIT_RATIO` on wide fan-outs.
 */

import {
	listPaneIds,
	type SplitNode,
	type SplitOrientation,
	type SplitTree,
} from "./split-tree";

export type SplitLayoutPreset =
	| "even-horizontal"
	| "even-vertical"
	| "main-horizontal"
	| "main-vertical"
	| "tiled";

/** Cycle order, matching the order tmux's `next-layout` walks its presets. */
export const SPLIT_LAYOUT_PRESETS: readonly SplitLayoutPreset[] = [
	"even-horizontal",
	"even-vertical",
	"main-horizontal",
	"main-vertical",
	"tiled",
];

/** The preset after `current`, or the first one when nothing is applied yet. */
export function nextSplitLayoutPreset(current: SplitLayoutPreset | null): SplitLayoutPreset {
	if (current === null) return SPLIT_LAYOUT_PRESETS[0];
	const index = SPLIT_LAYOUT_PRESETS.indexOf(current);
	return SPLIT_LAYOUT_PRESETS[(index + 1) % SPLIT_LAYOUT_PRESETS.length];
}

/** Mints split ids for one rebuild so no two branches can collide. */
class SplitIdMinter {
	constructor(private ordinal: number) {}

	next(): string {
		return `split-${this.ordinal++}`;
	}

	get nextSplitOrdinal(): number {
		return this.ordinal;
	}
}

function pane(id: string): SplitNode {
	return { type: "pane", id };
}

/** Balanced chain: `ratio = left/total` keeps every produced pane the same size. */
function evenChain(
	ids: readonly string[],
	orientation: SplitOrientation,
	minter: SplitIdMinter,
): SplitNode {
	if (ids.length === 1) return pane(ids[0]);
	const half = Math.floor(ids.length / 2);
	return {
		type: "split",
		id: minter.next(),
		orientation,
		ratio: half / ids.length,
		first: evenChain(ids.slice(0, half), orientation, minter),
		second: evenChain(ids.slice(half), orientation, minter),
	};
}

/** One oversized pane plus an even chain of the rest, tmux's `main-*` shape. */
function mainLayout(
	ids: readonly string[],
	rootOrientation: SplitOrientation,
	minter: SplitIdMinter,
): SplitNode {
	const restOrientation: SplitOrientation = rootOrientation === "vertical" ? "horizontal" : "vertical";
	return {
		type: "split",
		id: minter.next(),
		orientation: rootOrientation,
		ratio: 0.5,
		first: pane(ids[0]),
		second: evenChain(ids.slice(1), restOrientation, minter),
	};
}

/** Roughly square grid: `ceil(sqrt(n))` panes per row, rows stacked evenly. */
function tiled(ids: readonly string[], minter: SplitIdMinter): SplitNode {
	const columns = Math.ceil(Math.sqrt(ids.length));
	const rows: string[][] = [];
	for (let index = 0; index < ids.length; index += columns) {
		rows.push(ids.slice(index, index + columns));
	}
	return stackRows(rows, minter);
}

function stackRows(rows: readonly string[][], minter: SplitIdMinter): SplitNode {
	if (rows.length === 1) return evenChain(rows[0], "horizontal", minter);
	const half = Math.floor(rows.length / 2);
	return {
		type: "split",
		id: minter.next(),
		orientation: "vertical",
		ratio: half / rows.length,
		first: stackRows(rows.slice(0, half), minter),
		second: stackRows(rows.slice(half), minter),
	};
}

/**
 * Rebuild `tree` into `preset`. A single-pane tree has exactly one possible
 * layout, so it is returned untouched rather than churning its split ordinals.
 */
export function applySplitLayout(tree: SplitTree, preset: SplitLayoutPreset): SplitTree {
	const ids = listPaneIds(tree);
	if (ids.length < 2) return tree;
	const minter = new SplitIdMinter(tree.nextSplitOrdinal);

	let root: SplitNode;
	switch (preset) {
		case "even-horizontal":
			root = evenChain(ids, "horizontal", minter);
			break;
		case "even-vertical":
			root = evenChain(ids, "vertical", minter);
			break;
		case "main-horizontal":
			root = mainLayout(ids, "vertical", minter);
			break;
		case "main-vertical":
			root = mainLayout(ids, "horizontal", minter);
			break;
		case "tiled":
			root = tiled(ids, minter);
			break;
	}

	return { ...tree, root, nextSplitOrdinal: minter.nextSplitOrdinal };
}
