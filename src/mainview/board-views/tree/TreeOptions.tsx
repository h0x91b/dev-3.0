import type { Context } from "cordis";
import { useT } from "../../i18n";
import { useBoard } from "../react";
import { expandableKeys, isGroupOpen, type TreeLayout } from "./tree-model";
import { useTaskForest, useTreeLayout } from "./TreeView";

/** The Tree's "View options": group by epic, lineage-only, and expand/collapse all. */
export function TreeOptions(_props: { ctx: Context }) {
	const t = useT();
	const board = useBoard();
	const [layout, setLayout] = useTreeLayout(board);
	const roots = useTaskForest(board, layout);
	const groups = roots.flatMap((node) => (node.kind === "group" ? [node] : []));
	const groupOpenAll = (open: boolean): TreeLayout["groupOpen"] => Object.fromEntries(groups.map((node) => [node.key, open]));
	const anythingOpen = layout.expanded.length > 0 || groups.some((node) => isGroupOpen(node, layout.groupOpen));
	const checkboxRowCls = "flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm text-fg-2 hover:bg-overlay-hover";
	const buttonCls = "min-h-8 flex-1 rounded-md px-2 text-sm text-fg-2 hover:bg-overlay-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-accent/60 motion-safe:active:scale-[0.96] disabled:opacity-50 disabled:hover:bg-transparent";

	return (
		<fieldset data-testid="board-tree-options" className="flex flex-col gap-2">
			<legend className="mb-2 text-xs font-medium text-fg-3">{t("boardView.tree")}</legend>
			<label className={checkboxRowCls}>
				<input
					type="checkbox"
					className="accent-accent"
					checked={layout.groupBy === "epic"}
					onChange={(e) => setLayout({ ...layout, groupBy: e.target.checked ? "epic" : "none" })}
					data-testid="board-tree-option-group-by-epic"
				/>
				<span>{t("boardTree.groupByEpic")}</span>
			</label>
			<label className={checkboxRowCls}>
				<input
					type="checkbox"
					className="accent-accent"
					checked={layout.lineageOnly}
					onChange={(e) => setLayout({ ...layout, lineageOnly: e.target.checked })}
					data-testid="board-tree-option-lineage-only"
				/>
				<span>{t("boardTree.lineageOnly")}</span>
			</label>
			<div className="flex gap-1">
				<button
					type="button"
					className={buttonCls}
					onClick={() => setLayout({ ...layout, expanded: expandableKeys(roots), groupOpen: { ...layout.groupOpen, ...groupOpenAll(true) } })}
					data-testid="board-tree-expand-all"
				>
					{t("boardTree.expandAll")}
				</button>
				<button
					type="button"
					className={buttonCls}
					disabled={!anythingOpen}
					onClick={() => setLayout({ ...layout, expanded: [], groupOpen: { ...layout.groupOpen, ...groupOpenAll(false) } })}
					data-testid="board-tree-collapse-all"
				>
					{t("boardTree.collapseAll")}
				</button>
			</div>
		</fieldset>
	);
}
