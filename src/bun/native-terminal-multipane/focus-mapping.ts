/**
 * The deliberate mapping between `SplitTree` focus semantics and the
 * client-local focus/zoom model (seq 1283).
 *
 * `SplitTree` carries `activePaneId`/`zoomedPaneId` because it was written for a
 * single renderer. In a multi-client coordinator those two fields are NOT shared
 * state: focus and zoom belong to each client (see
 * `shared/native-terminal-client-layout`). So the coordinator persists a
 * NORMALIZED tree — membership, orientation, and ratios only — and asks the tree
 * for directional focus by borrowing its geometry with the caller's own focus
 * temporarily installed. Nothing here writes a client's focus back into the
 * shared layout, and no function here carries a PTY dimension.
 *
 * Pure module: shared layout types only, no fs, no process, no PTY.
 */

import {
	activatePane,
	focusPane,
	listPaneIds,
	type SplitDirection,
	type SplitTree,
} from "../../shared/split-tree";

/**
 * Strip the client-local overlays from a tree before it becomes shared state:
 * focus parks on the first pane (a `SplitTree` must always name one) and zoom
 * clears. Two clients therefore load byte-identical shared layout.
 */
export function normalizeSharedLayout(tree: SplitTree): SplitTree {
	const first = listPaneIds(tree)[0];
	if (first === undefined) return tree;
	if (tree.activePaneId === first && tree.zoomedPaneId === null) return tree;
	return { ...tree, activePaneId: first, zoomedPaneId: null };
}

/**
 * Where a client focused on `fromPaneId` lands when it moves `direction`,
 * computed from the shared geometry. Returns `fromPaneId` when there is no pane
 * that way. The input tree is never mutated.
 */
export function directionalFocusTarget(
	tree: SplitTree,
	fromPaneId: string,
	direction: SplitDirection,
): string {
	const paneIds = listPaneIds(tree);
	if (!paneIds.includes(fromPaneId)) return paneIds[0] ?? fromPaneId;
	return focusPane(activatePane(tree, fromPaneId), direction).activePaneId;
}
