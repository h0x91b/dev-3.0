import type { Context } from "cordis";
import { useT } from "../../i18n";
import { useBoard } from "../react";
import { TABLE_COLUMNS, toggleTableColumn } from "./table-model";
import { columnLabelKey, useTableLayout } from "./TableView";

/** The Table's "View options": which columns are shown. The title always is. */
export function TableOptions(_props: { ctx: Context }) {
	const t = useT();
	const board = useBoard();
	const [layout, setLayout] = useTableLayout(board);
	const kind = board.scope.kind;
	const available = TABLE_COLUMNS.filter((column) => column !== "project" || kind === "space");
	return (
		<fieldset data-testid="board-table-options">
			<legend className="mb-2 text-xs font-medium text-fg-3">{t("boardTable.columns")}</legend>
			<div className="flex flex-col">
				{available.map((column) => (
					<label key={column} className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm text-fg-2 hover:bg-overlay-hover has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
						<input
							type="checkbox"
							className="accent-accent"
							checked={layout.columns.includes(column)}
							disabled={column === "title"}
							onChange={() => setLayout(toggleTableColumn(layout, column, kind))}
						/>
						{t(columnLabelKey(column))}
					</label>
				))}
			</div>
		</fieldset>
	);
}
