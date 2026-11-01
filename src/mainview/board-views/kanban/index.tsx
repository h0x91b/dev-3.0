import type { Context } from "cordis";
import { KANBAN_VIEW_ID } from "../../../shared/board-view-state";
import { KanbanView } from "./KanbanView";

export { KanbanView };

/** `builtin:kanban` — a plugin like any other; it cannot be disabled, it is the fallback view (D16). */
export function installKanbanView(ctx: Context): void {
	ctx.plugin({
		name: KANBAN_VIEW_ID,
		inject: ["board", "boardViews"],
		apply(pluginCtx: Context) {
			pluginCtx.boardViews.register({
				id: KANBAN_VIEW_ID,
				label: "boardView.kanban",
				component: KanbanView,
				supportsNarrow: true,
			});
		},
	});
}
