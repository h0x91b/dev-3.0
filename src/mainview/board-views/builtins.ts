import type { TranslationKey } from "../i18n";
import type { BuiltinPlugin } from "../plugins/runtime";
// Defines the `boardViews` slot on the app root before any built-in view installs.
import "./registry";
import { ATTENTION_VIEW_ID, KANBAN_VIEW_ID } from "../../shared/board-view-state";
import { installKanbanView } from "./kanban";
import { installTableView, TABLE_VIEW_ID } from "./table";
import { installTreeView, TREE_VIEW_ID } from "./tree";
import { installAttentionView } from "./attention";

export interface BuiltinBoardView extends BuiltinPlugin {
	/** Shown in Settings → Extensions; the same key the view registers its label with. */
	labelKey: TranslationKey;
}

/**
 * Every built-in board view, in switcher order. Kanban is the fallback and is
 * never disabled (D16); the rest follow Settings → Extensions. A new built-in
 * adds its entry here and its id to `TOGGLEABLE_BUILTIN_VIEWS`.
 */
export const BUILTIN_BOARD_VIEWS: readonly BuiltinBoardView[] = [
	{ id: KANBAN_VIEW_ID, labelKey: "boardView.kanban", required: true, install: installKanbanView },
	{ id: TABLE_VIEW_ID, labelKey: "boardView.table", install: installTableView },
	{ id: TREE_VIEW_ID, labelKey: "boardView.tree", install: installTreeView },
	{ id: ATTENTION_VIEW_ID, labelKey: "boardView.attention", install: installAttentionView },
];
