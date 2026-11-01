import type { Context } from "cordis";
import { useT } from "../../i18n";
import { useBoard } from "../react";
import { TABLE_COLUMNS, columnAllowedOn, toggleTableColumn, toggleTableSort } from "./table-model";
import { columnLabelKey, useTableLayout } from "./TableView";

/**
 * The Table's "View options": one row per column, a checkbox to show it and a
 * sort button — the only way to sort on narrow, where there are no headers.
 * Nothing here portals, so the host popover never mistakes a pick for an outside click.
 */
export function TableOptions(_props: { ctx: Context }) {
	const t = useT();
	const board = useBoard();
	const [layout, setLayout] = useTableLayout(board);
	const kind = board.scope.kind;
	const available = TABLE_COLUMNS.filter((column) => columnAllowedOn(kind, column));
	const [sortColumn, direction] = layout.sort;
	// Narrow cards show fixed fields, so there the list only sorts.
	const narrow = board.formFactor === "narrow";

	return (
		<fieldset data-testid="board-table-options">
			<legend className="mb-2 text-xs font-medium text-fg-3">{t(narrow ? "boardTable.sortHeading" : "boardTable.columns")}</legend>
			<div className="flex flex-col">
				{available.map((column) => {
					const label = t(columnLabelKey(column));
					const active = sortColumn === column;
					const sortLabel = active
						? t(direction === "asc" ? "boardTable.sortedAscending" : "boardTable.sortedDescending", { column: label })
						: t("boardTable.sortBy", { column: label });
					return (
						<div key={column} className="flex items-center gap-1 rounded-md hover:bg-overlay-hover">
							{narrow ? (
								<span className="min-h-8 min-w-0 flex-1 truncate px-1.5 text-sm leading-8 text-fg-2">{label}</span>
							) : (
								<label className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 px-1.5 text-sm text-fg-2 has-[:disabled]:cursor-default">
									<input
										type="checkbox"
										className="accent-accent disabled:opacity-60"
										checked={layout.columns.includes(column)}
										disabled={column === "title"}
										onChange={() => setLayout(toggleTableColumn(layout, column, kind))}
									/>
									<span className="truncate">{label}</span>
								</label>
							)}
							<button
								type="button"
								onClick={() => setLayout(toggleTableSort(layout, column))}
								aria-label={sortLabel}
								aria-pressed={active}
								title={sortLabel}
								data-testid={`board-table-option-sort-${column}`}
								className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md hover:text-fg focus-visible:ring-1 focus-visible:ring-accent/60 motion-safe:active:scale-[0.96] ${active ? "text-accent" : "text-fg-muted"}`}
							>
								<svg aria-hidden className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
									{active ? <path d={direction === "asc" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} /> : <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />}
								</svg>
							</button>
						</div>
					);
				})}
			</div>
		</fieldset>
	);
}
