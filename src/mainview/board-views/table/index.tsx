import type { Context } from "cordis";
import { TableOptions } from "./TableOptions";
import { TABLE_VIEW_ID, TableView } from "./TableView";

export { TABLE_VIEW_ID };

/** `builtin:table` as an ordinary plugin: it sees the board only through `ctx.board`. */
export function installTableView(ctx: Context): void {
	ctx.plugin({
		name: TABLE_VIEW_ID,
		inject: ["board", "boardViews"],
		apply(pluginCtx: Context) {
			pluginCtx.boardViews.register({
				id: TABLE_VIEW_ID,
				label: "boardView.table",
				component: TableView,
				Options: TableOptions,
				supportsNarrow: true,
			});
		},
	});
}
