import { createContext, useContext, type ComponentProps } from "react";
import type { Context } from "cordis";
import KanbanBoard from "../../components/KanbanBoard";
import { KANBAN_VIEW_ID } from "../../../shared/board-view-state";
import { useBoard } from "../react";

/**
 * TEMPORARY adapter (board views task 1): the existing KanbanBoard mounted as
 * the only board view. Task 2 rewrites Kanban on the `ctx.board` contract and
 * deletes this file together with `LegacyKanbanBridge`.
 */
type LegacyKanbanProps = Omit<ComponentProps<typeof KanbanBoard>, "tasks" | "displayTasks">;

/** Host-only inputs the old component still takes as props. Deleted with the adapter. */
export const LegacyKanbanBridge = createContext<LegacyKanbanProps | null>(null);

export function KanbanView(_props: { ctx: Context }) {
	const board = useBoard();
	const legacy = useContext(LegacyKanbanBridge);
	if (!legacy) throw new Error("KanbanView rendered outside the board host");
	return <KanbanBoard {...legacy} tasks={board.scopeTasks() as ComponentProps<typeof KanbanBoard>["tasks"]} displayTasks={board.tasks()} />;
}

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
