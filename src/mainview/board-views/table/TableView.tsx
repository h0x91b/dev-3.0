import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Context } from "cordis";
import type { Task } from "../../../shared/types";
import { getTaskTitle } from "../../../shared/types";
import { useT, type TranslationKey } from "../../i18n";
import { useBoard } from "../react";
import type { BoardService } from "../board-service";
import { TableCell, LabelsCell, PriorityCell, StatusCell, rowSeqLabel, type TableRowContext } from "./TableCells";
import {
	normalizeTableLayout,
	sortTableTasks,
	toggleTableSort,
	type TableColumnId,
	type TableLayout,
} from "./table-model";

export const TABLE_VIEW_ID = "builtin:table";
const ROW_HEIGHT = 36;
const CARD_HEIGHT = 84;
/** Rows rendered beyond the viewport, so a quick scroll does not show blank space. */
const OVERSCAN = 12;

const COLUMN_WIDTH: Record<TableColumnId, string> = {
	seq: "4.5rem",
	title: "minmax(14rem, 1fr)",
	project: "9rem",
	status: "9.5rem",
	priority: "3.5rem",
	labels: "minmax(8rem, 14rem)",
	agent: "7rem",
	pr: "6.5rem",
	activity: "4.5rem",
	parent: "5rem",
	created: "6.5rem",
	branch: "minmax(8rem, 13rem)",
	type: "7rem",
};

export function columnLabelKey(column: TableColumnId): TranslationKey {
	return `boardTable.col.${column}` as TranslationKey;
}

/** The Table's layout for the board on screen, normalised, with a setter that persists it. */
export function useTableLayout(board: BoardService): [TableLayout, (next: TableLayout) => void] {
	const kind = board.scope.kind;
	const layout = normalizeTableLayout(board.layout(TABLE_VIEW_ID), kind);
	const setLayout = useCallback((next: TableLayout) => board.setLayout(TABLE_VIEW_ID, next), [board]);
	return [layout, setLayout];
}

function useRowContext(board: BoardService): TableRowContext {
	const columns = board.columns();
	const projects = board.projects();
	const agents = board.agents();
	const scopeTasks = board.scopeTasks();
	const narrow = board.formFactor === "narrow";
	return useMemo(() => {
		const seen = new Set<number>();
		const sharedSeqs = new Set<number>();
		for (const task of scopeTasks) (seen.has(task.seq) ? sharedSeqs : seen).add(task.seq);
		return {
			board,
			columns,
			projectById: new Map(projects.map((p) => [p.id, p])),
			agentNameById: new Map(agents.map((a) => [a.id, a.name])),
			taskById: new Map(scopeTasks.map((task) => [task.id, task])),
			sharedSeqs,
			narrow,
		};
	}, [board, columns, projects, agents, scopeTasks, narrow]);
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
		projectName: (id) => rowCtx.projectById.get(id)?.name ?? "",
		taskSeqById: (id) => rowCtx.taskById.get(id)?.seq ?? null,
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
	const gridTemplateColumns = layout.columns.map((c) => COLUMN_WIDTH[c]).join(" ");

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
										<span className="truncate text-sm text-fg">{getTaskTitle(task)}</span>
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
			<div role="table" aria-label={t("boardView.table")} aria-rowcount={sorted.length + 1} className="min-w-max">
				<div role="rowgroup" className="sticky top-0 z-10 bg-base">
					<div role="row" aria-rowindex={1} className="grid items-center gap-x-3 border-b border-edge px-2" style={{ gridTemplateColumns, height: ROW_HEIGHT }}>
						{layout.columns.map((column) => {
							const sorted = layout.sort[0] === column;
							const direction = sorted ? layout.sort[1] : null;
							return (
								<div
									key={column}
									role="columnheader"
									aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}
								>
									<button
										type="button"
										onClick={() => setLayout(toggleTableSort(layout, column))}
										data-testid={`board-table-sort-${column}`}
										className={`flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium hover:text-fg focus-visible:ring-1 focus-visible:ring-accent/60 ${sorted ? "text-fg" : "text-fg-3"}`}
									>
										{t(columnLabelKey(column))}
										{direction && (
											<svg aria-hidden className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
												<path d={direction === "asc" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
											</svg>
										)}
									</button>
								</div>
							);
						})}
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
								className="absolute left-0 top-0 grid w-full cursor-pointer items-center gap-x-3 border-b border-edge/50 px-2 outline-none hover:bg-raised-hover focus-visible:bg-raised-hover focus-visible:shadow-[inset_2px_0_0_rgb(var(--accent))]"
								style={{ gridTemplateColumns, height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
							>
								{layout.columns.map((column) => (
									<div key={column} role="cell" className="min-w-0">
										<TableCell column={column} task={task} ctx={rowCtx} />
									</div>
								))}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
