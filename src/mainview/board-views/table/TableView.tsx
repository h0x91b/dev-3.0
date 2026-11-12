import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Context } from "cordis";
import type { Label, Task } from "../../../shared/types";
import { isPinnedCoordinator, projectDisplayName } from "../../../shared/types";
import { useT, type TranslationKey } from "../../i18n";
import { useBoard } from "../react";
import type { BoardService } from "../board-service";
import { TableCell, TitleCell, LabelsCell, OverviewCell, PriorityCell, StatusCell, rowSeqLabel, type TableRowContext } from "./TableCells";
import {
	END_ALIGNED_COLUMNS,
	normalizeTableLayout,
	sortTableTasks,
	tableGrid,
	toggleTableSort,
	type TableColumnId,
	type TableLayout,
} from "./table-model";
import { COORDINATOR_ROW, ZEBRA_ROW } from "../zebra";

export const TABLE_VIEW_ID = "builtin:table";
const ROW_HEIGHT = 36;
const CARD_HEIGHT = 84;
/** Rows rendered beyond the viewport, so a quick scroll does not show blank space. */
const OVERSCAN = 12;

/** The row's spare room. Its text appears only once the cell is wide enough to say something. */
const SPARE_CELL = "min-w-0 ps-3 [container-type:inline-size]";
const SPARE_TEXT = "hidden truncate [@container(min-width:12rem)]:block";

const COLUMN_LABEL_KEYS = {
	seq: "boardTable.col.seq",
	title: "boardTable.col.title",
	project: "boardTable.col.project",
	status: "boardTable.col.status",
	priority: "boardTable.col.priority",
	labels: "boardTable.col.labels",
	agent: "boardTable.col.agent",
	pr: "boardTable.col.pr",
	activity: "boardTable.col.activity",
	parent: "boardTable.col.parent",
	created: "boardTable.col.created",
	branch: "boardTable.col.branch",
	type: "boardTable.col.type",
} as const satisfies Record<TableColumnId, TranslationKey>;

export function columnLabelKey(column: TableColumnId): TranslationKey {
	return COLUMN_LABEL_KEYS[column];
}

/** The Table's layout for the board on screen, normalised, with a setter that persists it. */
export function useTableLayout(board: BoardService): [TableLayout, (next: TableLayout) => void] {
	const kind = board.scope.kind;
	const layout = normalizeTableLayout(board.layout(TABLE_VIEW_ID), kind);
	const setLayout = useCallback((next: TableLayout) => board.setLayout(TABLE_VIEW_ID, next), [board]);
	return [layout, setLayout];
}

function useRowContext(board: BoardService): TableRowContext {
	const t = useT();
	const opsBoardName = t("ops.boardName");
	const columns = board.columns();
	const projects = board.projects();
	const agents = board.agents();
	const scopeTasks = board.scopeTasks();
	const narrow = board.formFactor === "narrow";
	return useMemo(() => {
		const seen = new Set<number>();
		const sharedSeqs = new Set<number>();
		for (const task of scopeTasks) (seen.has(task.seq) ? sharedSeqs : seen).add(task.seq);
		const projectById = new Map(projects.map((p) => [p.id, p]));
		const labelsById = new Map(projects.map((p) => [p.id, new Map((p.labels ?? []).map((label) => [label.id, label]))]));
		return {
			board,
			columns,
			projectById,
			agentNameById: new Map(agents.map((a) => [a.id, a.name])),
			taskById: new Map(scopeTasks.map((task) => [task.id, task])),
			sharedSeqs,
			narrow,
			projectName: (id) => {
				const project = projectById.get(id);
				return project ? projectDisplayName(project, opsBoardName) : "";
			},
			labelsOf: (task) => {
				const own = labelsById.get(task.projectId);
				return (task.labelIds ?? []).map((id) => own?.get(id)).filter((label): label is Label => !!label);
			},
		};
	}, [board, columns, projects, agents, scopeTasks, narrow, opsBoardName]);
}

/** `builtin:table` (spec D18): every task of the board as sortable, virtualised rows. */
export function TableView(_props: { ctx: Context }) {
	const t = useT();
	const board = useBoard();
	const [layout, setLayout] = useTableLayout(board);
	const rowCtx = useRowContext(board);
	const tasks = board.tasks();
	const sorted = useMemo(() => sortTableTasks(tasks, layout.sort, {
		columns: rowCtx.columns,
		agentName: (id) => (id ? rowCtx.agentNameById.get(id) ?? "" : ""),
		projectName: (id) => rowCtx.projectName(id),
		taskSeqById: (id) => rowCtx.taskById.get(id)?.seq ?? null,
		labelNames: (task) => rowCtx.labelsOf(task).map((label) => label.name),
	}), [tasks, layout.sort, rowCtx]);

	const narrow = board.formFactor === "narrow";
	const scrollRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: sorted.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => (narrow ? CARD_HEIGHT : ROW_HEIGHT),
		overscan: OVERSCAN,
		getItemKey: (index) => sorted[index].id,
	});
	// Rows and cards have different heights; drop the cached sizes when the form factor flips.
	useEffect(() => {
		virtualizer.measure();
	}, [virtualizer, narrow]);

	const openMenu = (task: Task, e: MouseEvent) => {
		e.preventDefault();
		board.openContextMenu(task.id, { x: e.clientX, y: e.clientY });
	};

	const focusRow = (index: number) => {
		const target = Math.max(0, Math.min(sorted.length - 1, index));
		virtualizer.scrollToIndex(target);
		requestAnimationFrame(() => {
			scrollRef.current?.querySelector<HTMLElement>(`[data-row-index="${target}"]`)?.focus();
		});
	};

	const onRowKeyDown = (task: Task, index: number, e: KeyboardEvent<HTMLElement>) => {
		if (e.target !== e.currentTarget) return;
		if (e.key === "Enter") {
			e.preventDefault();
			board.openTask(task.id);
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			focusRow(index + (e.key === "ArrowDown" ? 1 : -1));
		} else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
			e.preventDefault();
			const rect = e.currentTarget.getBoundingClientRect();
			board.openContextMenu(task.id, { x: rect.left + 24, y: rect.bottom });
		}
	};

	const total = board.scopeTasks().length;
	if (sorted.length === 0) {
		return (
			<div className="flex flex-1 items-center justify-center px-6 py-16 text-sm text-fg-3" data-testid="board-table-empty">
				{total === 0 ? t("boardTable.emptyBoard") : t("boardTable.noMatches")}
			</div>
		);
	}

	const items = virtualizer.getVirtualItems();
	const grid = tableGrid(layout.columns);

	if (narrow) {
		return (
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-6" data-testid="board-table" role="list" aria-label={t("boardView.table")}>
				<div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
					{items.map((item) => {
						const task = sorted[item.index];
						return (
							<div
								key={item.key}
								role="listitem"
								tabIndex={0}
								data-row-index={item.index}
								data-testid={`board-table-row-${task.id}`}
								onClick={() => board.openTask(task.id)}
								onContextMenu={(e) => openMenu(task, e)}
								onKeyDown={(e) => onRowKeyDown(task, item.index, e)}
								className="absolute left-0 top-0 w-full pb-2 outline-none"
								style={{ height: CARD_HEIGHT, transform: `translateY(${item.start}px)` }}
							>
								<div className="flex h-full flex-col justify-between rounded-xl bg-raised px-3 py-2 shadow-[0_0_0_1px_rgb(var(--border-default))] active:bg-raised-hover">
									<div className="flex min-w-0 items-baseline gap-2">
										<span className="flex-shrink-0 text-xs tabular-nums text-fg-3">{rowSeqLabel(task, rowCtx)}</span>
										<TitleCell task={task} className="flex-1" />
										<span className="flex-shrink-0"><TableCell column="activity" task={task} ctx={rowCtx} /></span>
									</div>
									<div className="flex min-w-0 items-center gap-2">
										<StatusCell task={task} ctx={rowCtx} />
										<PriorityCell task={task} ctx={rowCtx} />
										<LabelsCell task={task} ctx={rowCtx} />
									</div>
								</div>
							</div>
						);
					})}
				</div>
			</div>
		);
	}

	return (
		<div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-6 pb-6" data-testid="board-table">
			<div role="table" aria-label={t("boardView.table")} aria-rowcount={sorted.length + 1} style={{ minWidth: grid.minWidth }}>
				<div role="rowgroup" className="sticky top-0 z-10 bg-base">
					<div role="row" aria-rowindex={1} className="grid items-center border-b border-edge" style={{ ...grid.rowStyle, height: ROW_HEIGHT }}>
						{layout.columns.map((column) => {
							const sorted = layout.sort[0] === column;
							const direction = sorted ? layout.sort[1] : null;
							const end = END_ALIGNED_COLUMNS.has(column);
							const label = t(columnLabelKey(column));
							return (
								<div
									key={column}
									role="columnheader"
									aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}
									className={`flex min-w-0 ${end ? "justify-end pe-3" : ""}`}
								>
									{/* -mx-1 cancels the hit-area padding so the label lines up with the cells below. */}
									<button
										type="button"
										onClick={() => setLayout(toggleTableSort(layout, column))}
										data-testid={`board-table-sort-${column}`}
										title={label}
										className={`group -mx-1 flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs font-medium transition-[color,transform] duration-150 hover:text-fg focus-visible:ring-1 focus-visible:ring-accent/60 motion-safe:active:scale-[0.96] ${end ? "flex-row-reverse" : ""} ${sorted ? "text-fg" : "text-fg-3"}`}
									>
										<span className="truncate">{label}</span>
										<svg
											aria-hidden
											className={`h-3 w-3 flex-shrink-0 transition-opacity duration-150 ${direction ? "" : "opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60"}`}
											viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
										>
											<path d={direction === "asc" ? "M6 15l6-6 6 6" : direction === "desc" ? "M6 9l6 6 6-6" : "M8 9l4-4 4 4M8 15l4 4 4-4"} />
										</svg>
									</button>
								</div>
							);
						})}
						<div role="columnheader" className={SPARE_CELL}>
							<span className={`${SPARE_TEXT} text-xs font-medium text-fg-3`}>{t("overview.label")}</span>
						</div>
					</div>
				</div>
				<div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
					{items.map((item) => {
						const task = sorted[item.index];
						return (
							<div
								key={item.key}
								role="row"
								aria-rowindex={item.index + 2}
								tabIndex={0}
								data-row-index={item.index}
								data-testid={`board-table-row-${task.id}`}
								onClick={() => board.openTask(task.id)}
								onContextMenu={(e) => openMenu(task, e)}
								onKeyDown={(e) => onRowKeyDown(task, item.index, e)}
								className={`absolute left-0 top-0 grid w-full cursor-pointer items-center border-b border-edge/40 outline-none ${isPinnedCoordinator(task) ? COORDINATOR_ROW : item.index % 2 === 1 ? ZEBRA_ROW : ""} hover:bg-raised-hover focus-visible:bg-raised-hover focus-visible:shadow-[inset_2px_0_0_rgb(var(--accent))]`}
								style={{ ...grid.rowStyle, height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
							>
								{layout.columns.map((column) => (
									<div key={column} role="cell" className={`min-w-0 ${END_ALIGNED_COLUMNS.has(column) ? "pe-3 text-end" : ""}`}>
										<TableCell column={column} task={task} ctx={rowCtx} />
									</div>
								))}
								<div role="cell" className={SPARE_CELL}>
									<OverviewCell task={task} className={SPARE_TEXT} />
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
