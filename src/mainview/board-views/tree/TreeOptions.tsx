import type { Context } from "cordis";
import { useT } from "../../i18n";
import { useBoard } from "../react";
import { expandableKeys } from "./tree-model";
import { useTaskForest, useTreeLayout } from "./TreeView";

/**
 * The Tree's "View options". Grouping by epic (D19) lands here as the top-level
 * choice once epics exist; until then: lineage-only and expand/collapse all.
 */
export function TreeOptions(_props: { ctx: Context }) {
	const t = useT();
	const board = useBoard();
	const [layout, setLayout] = useTreeLayout(board);
	const roots = useTaskForest(board, layout);
	const buttonCls = "min-h-8 flex-1 rounded-md px-2 text-sm text-fg-2 hover:bg-overlay-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-accent/60 motion-safe:active:scale-[0.96] disabled:opacity-50 disabled:hover:bg-transparent";

	return (
		<fieldset data-testid="board-tree-options" className="flex flex-col gap-2">
			<legend className="mb-2 text-xs font-medium text-fg-3">{t("boardView.tree")}</legend>
			<label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm text-fg-2 hover:bg-overlay-hover">
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
					onClick={() => setLayout({ ...layout, expanded: expandableKeys(roots) })}
					data-testid="board-tree-expand-all"
				>
					{t("boardTree.expandAll")}
				</button>
				<button
					type="button"
					className={buttonCls}
					disabled={layout.expanded.length === 0}
					onClick={() => setLayout({ ...layout, expanded: [] })}
					data-testid="board-tree-collapse-all"
				>
					{t("boardTree.collapseAll")}
				</button>
			</div>
		</fieldset>
	);
}
