import type { Context } from "cordis";
import { TreeOptions } from "./TreeOptions";
import { TREE_VIEW_ID, TreeView } from "./TreeView";

export { TREE_VIEW_ID };

/** `builtin:tree` as an ordinary plugin: it sees the board only through `ctx.board`. */
export function installTreeView(ctx: Context): void {
	ctx.plugin({
		name: TREE_VIEW_ID,
		inject: ["board", "boardViews"],
		apply(pluginCtx: Context) {
			pluginCtx.boardViews.register({
				id: TREE_VIEW_ID,
				label: "boardView.tree",
				component: TreeView,
				Options: TreeOptions,
				supportsNarrow: true,
			});
		},
	});
}
