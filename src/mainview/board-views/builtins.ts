import type { Context, Fiber } from "cordis";
import { KANBAN_VIEW_ID } from "../../shared/board-view-state";
import { installKanbanView } from "./kanban";
import { installTableView, TABLE_VIEW_ID } from "./table";

export interface BuiltinBoardView {
	id: string;
	install(ctx: Context): Fiber;
}

/**
 * Every built-in board view, in switcher order. Kanban is the fallback and is
 * never disabled (D16); the rest follow Settings → Extensions. A new built-in
 * adds its entry here and its id to `TOGGLEABLE_BUILTIN_VIEWS`.
 */
export const BUILTIN_BOARD_VIEWS: readonly BuiltinBoardView[] = [
	{ id: KANBAN_VIEW_ID, install: installKanbanView },
	{ id: TABLE_VIEW_ID, install: installTableView },
];
