import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Context } from "cordis";
import type { Task, TaskStatus } from "../../../shared/types";
import { ALL_STATUSES, laneAcceptsProject, laneColumnIdForProject, laneKey } from "../../../shared/types";
import { statusDescKey, statusKey, useT } from "../../i18n";
import { toast } from "../../toast";
import { sortTasksForColumn } from "../../components/sortTasks";
import { partitionTasksByStatus } from "../../components/partitionTasks";
import MobileBoardCarousel, { CAROUSEL_MAX_WIDTH, type CarouselColumn } from "../../components/MobileBoardCarousel";
import { useTipRotation } from "../../hooks/useTipRotation";
import { useColumnCollapse } from "../../hooks/useColumnCollapse";
import { useNarrowViewport } from "../../hooks/useNarrowViewport";
import { useIsControlHidden } from "../../hooks/useIsControlHidden";
import { useStatusColors } from "../../hooks/useStatusColors";
import type { BoardColumn } from "../board-service";
import { useBoard } from "../react";
import KanbanColumn from "./KanbanColumn";

/** Which column a dragged card left, so columns can refuse or dim before the drop. */
interface DragOrigin {
	status: TaskStatus;
	customColumnId: string | null;
	draft: boolean;
	projectId: string;
}

/**
 * `builtin:kanban`: lanes of cards, drawn from `ctx.board` alone. Everything it
 * changes goes through the board's actions; the cards are `ctx.board.TaskCard`.
 */
export function KanbanView(_props: { ctx: Context }) {
	const board = useBoard();
	const t = useT();
	const isSpaceBoard = board.scope.kind === "space";
	const scopeTasks = board.scopeTasks();
	const displayTasks = board.tasks();
	const lanes = board.columns({ includeOccupied: true });
	const { taskSortOrder, tipsDisabled } = board.preferences();
	const TaskCard = board.TaskCard;

	const isCarousel = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	// The "custom-column-creation" control (§5.10) hides only creation; existing columns still render.
	const columnCreationHidden = useIsControlHidden("custom-column-creation");
	const statusColors = useStatusColors();
	const { tip: currentTip, tipState, applyTipState } = useTipRotation("board", tipsDisabled);
	// Keyed by the board subject: a space board keeps its own collapse memory.
	const collapseState = useColumnCollapse(isSpaceBoard ? `space-${board.scope.id}` : board.scope.id);

	const [dragOrigin, setDragOrigin] = useState<DragOrigin | null>(null);
	const [movingTaskIds, setMovingTaskIds] = useState<Set<string>>(new Set());
	const [draggedColumnId, setDraggedColumnId] = useState<string | null>(null);
	// Ref so drag handlers can check synchronously without waiting for a state update.
	const draggedColumnIdRef = useRef<string | null>(null);
	// A column just created from the board's "+" opens straight in rename mode.
	const [autoEditColumnId, setAutoEditColumnId] = useState<string | null>(null);

	const handleSetMoving = useCallback((taskId: string, isMoving: boolean) => {
		setMovingTaskIds((prev) => {
			const next = new Set(prev);
			if (isMoving) next.add(taskId);
			else next.delete(taskId);
			return next;
		});
	}, []);

	useEffect(() => {
		const clear = () => setDragOrigin(null);
		window.addEventListener("dragend", clear);
		return () => window.removeEventListener("dragend", clear);
	}, []);

	const findTask = (taskId: string) => scopeTasks.find((task) => task.id === taskId);

	function handleDragStart(taskId: string) {
		const task = findTask(taskId);
		if (task) setDragOrigin({ status: task.status, customColumnId: task.customColumnId ?? null, draft: task.draft === true, projectId: task.projectId });
	}

	async function handleTaskDrop(taskId: string, targetStatus: TaskStatus) {
		setDragOrigin(null);
		const task = findTask(taskId);
		if (!task) return;
		// Columns already refuse a draft; this guards a drop that still reaches the board.
		if (task.draft === true && targetStatus !== "todo") {
			toast.error(t("kanban.draftNotDroppable"), { taskId: task.id });
			return;
		}
		if (task.status === targetStatus && !task.customColumnId) return;
		// A To Do → active drop is a launch: the board action raises the launch modal.
		await board.moveTask(task.id, { status: targetStatus }, { onMovingChange: (moving) => handleSetMoving(task.id, moving) });
	}

	// `laneId` is the lane's id; what is written is the card's OWN project's column
	// inside that lane, which keeps one gesture inside one repository.
	async function handleTaskDropToCustomColumn(taskId: string, laneId: string) {
		setDragOrigin(null);
		const task = findTask(taskId);
		if (!task) return;
		const lane = lanes.find((slot) => laneKey(slot) === laneId);
		const customColumnId = lane ? laneColumnIdForProject(lane, task.projectId) : null;
		if (!customColumnId || task.customColumnId === customColumnId) return;
		if (task.draft === true) {
			toast.error(t("kanban.draftNotDroppable"), { taskId: task.id });
			return;
		}
		await board.moveTask(task.id, { customColumnId }, { onMovingChange: (moving) => handleSetMoving(task.id, moving) });
	}

	// Which lane each project's custom column feeds. A task whose column is gone
	// (dangling id) falls back to its status column, so it can never vanish.
	const laneIdByProjectColumn = useMemo(() => {
		const map = new Map<string, string>();
		for (const slot of lanes) {
			if (slot.type !== "custom") continue;
			for (const member of slot.members) map.set(`${member.projectId}::${member.columnId}`, laneKey(slot));
		}
		return map;
	}, [lanes]);
	const isInCustomColumn = (task: Task) =>
		!!task.customColumnId && laneIdByProjectColumn.has(`${task.projectId}::${task.customColumnId}`);

	// Renamed built-ins are per project and cannot be reconciled across a space,
	// so a space board shows dev3's canonical names.
	const customStatusLabels = isSpaceBoard ? {} : (board.projects()[0]?.customStatusLabels ?? {});

	const tasksByStatus = partitionTasksByStatus([...displayTasks], isInCustomColumn);
	for (const status of ALL_STATUSES) {
		const columnTasks = tasksByStatus.get(status);
		if (columnTasks && columnTasks.length > 1) tasksByStatus.set(status, sortTasksForColumn(columnTasks, taskSortOrder, status));
	}
	// Keyed by LANE: a merged lane collects every member project's column.
	const tasksByCustomColumn = new Map<string, Task[]>();
	for (const slot of lanes) {
		if (slot.type === "custom") tasksByCustomColumn.set(laneKey(slot), []);
	}
	for (const task of displayTasks) {
		if (!isInCustomColumn(task)) continue;
		const laneId = laneIdByProjectColumn.get(`${task.projectId}::${task.customColumnId}`);
		if (laneId) tasksByCustomColumn.get(laneId)?.push(task);
	}
	for (const [colId, colTasks] of tasksByCustomColumn) {
		tasksByCustomColumn.set(colId, sortTasksForColumn(colTasks, taskSortOrder));
	}

	function handleColumnDragStart(colId: string) {
		draggedColumnIdRef.current = colId;
		setDraggedColumnId(colId);
	}

	function handleColumnDrop(targetColId: string, side: "before" | "after") {
		const srcColId = draggedColumnIdRef.current;
		if (!srcColId || srcColId === targetColId) return;
		const order = lanes.map(laneKey);
		const fromIndex = order.indexOf(srcColId);
		const toIndex = order.indexOf(targetColId);
		if (fromIndex === -1 || toIndex === -1) return;
		let insertAt = side === "after" ? toIndex + 1 : toIndex;
		if (fromIndex < insertAt) insertAt -= 1;
		order.splice(fromIndex, 1);
		order.splice(insertAt, 0, srcColId);
		draggedColumnIdRef.current = null;
		setDraggedColumnId(null);
		void board.reorderColumns(order);
	}

	function handleColumnDragEnd() {
		draggedColumnIdRef.current = null;
		setDraggedColumnId(null);
	}

	async function handleCreateCustomColumn() {
		const id = await board.createColumn();
		if (id) setAutoEditColumnId(id);
	}

	const laneCount = (slot: BoardColumn) =>
		slot.type === "builtin" ? tasksByStatus.get(slot.status)?.length ?? 0 : tasksByCustomColumn.get(laneKey(slot))?.length ?? 0;

	// One tip across the board, in the first open lane with fewer than 3 cards. A
	// board with no tasks at all gets none: its To Do empty state explains the first task.
	let tipColumnId: string | null = null;
	if (currentTip && scopeTasks.length > 0) {
		for (const slot of lanes) {
			const colId = laneKey(slot);
			if (collapseState.isCollapsed(colId)) continue;
			if (laneCount(slot) < 3) {
				tipColumnId = colId;
				break;
			}
		}
	}

	const addColumnButton = columnCreationHidden ? null : (
		<button
			key="add-column"
			type="button"
			onClick={() => void handleCreateCustomColumn()}
			className="group/addcol flex-shrink-0 self-stretch w-11 flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-edge text-fg-3 hover:text-accent hover:border-accent/40 hover:bg-accent/5 transition-[color,background-color,border-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
			aria-label={t("customColumns.addColumnAria")}
			title={t("customColumns.addColumnAria")}
		>
			<span className="text-2xl leading-none">+</span>
			<span className="kanban-col-vertical-label text-xs font-semibold whitespace-nowrap opacity-0 group-hover/addcol:opacity-100 transition-opacity">
				{t("customColumns.addColumnAria")}
			</span>
		</button>
	);

	const commonProps = {
		boardEmpty: scopeTasks.length === 0,
		TaskCard,
		onAddTask: () => board.createTask(),
		onTaskDrop: handleTaskDrop,
		dragFromStatus: dragOrigin?.status ?? null,
		dragFromCustomColumnId: dragOrigin?.customColumnId ?? null,
		dragFromDraft: dragOrigin?.draft ?? false,
		onDragStart: handleDragStart,
		movingTaskIds,
		onSetMoving: handleSetMoving,
		onTipChanged: applyTipState,
		tipState: tipState ?? undefined,
	};

	function renderColumnElement(slot: BoardColumn, full: boolean) {
		if (slot.type === "builtin") {
			const colId = slot.status;
			return (
				<KanbanColumn
					key={slot.status}
					status={slot.status}
					label={customStatusLabels[slot.status] || t(statusKey(slot.status))}
					description={t(statusDescKey(slot.status))}
					tasks={tasksByStatus.get(slot.status) || []}
					onColumnDrop={isSpaceBoard ? undefined : (side) => handleColumnDrop(slot.status, side)}
					tip={tipColumnId === slot.status ? currentTip : undefined}
					collapsed={full ? false : collapseState.isCollapsed(colId)}
					onCollapseToggle={full ? undefined : () => collapseState.toggle(colId)}
					collapseDragHandlers={full ? undefined : collapseState.dragExpandHandlers(colId)}
					onRenameColumn={isSpaceBoard ? undefined : (name) => void board.renameColumn(slot.status, name)}
					fullWidth={full}
					{...commonProps}
				/>
			);
		}
		const col = slot.col;
		const laneId = laneKey(slot);
		// Reordering, renaming and deleting a lane belong to ONE project's board; a
		// merged space lane has no single order or name to write. Cards still drag.
		const laneIsMerged = isSpaceBoard;
		return (
			<KanbanColumn
				key={laneId}
				status="todo"
				label={col.name}
				mergedProjectCount={slot.members.length > 1 ? slot.members.length : undefined}
				laneRefusesDrag={dragOrigin !== null && !laneAcceptsProject(slot, dragOrigin.projectId)}
				tasks={tasksByCustomColumn.get(laneId) || []}
				onTaskDropToCustomColumn={handleTaskDropToCustomColumn}
				isCustomColumn
				customColumnId={laneId}
				colorOverride={col.color}
				isDraggedColumn={draggedColumnId === laneId}
				onColumnDragStart={laneIsMerged ? undefined : () => handleColumnDragStart(laneId)}
				onColumnDragEnd={laneIsMerged ? undefined : handleColumnDragEnd}
				onColumnDrop={laneIsMerged ? undefined : (side) => handleColumnDrop(laneId, side)}
				onRenameColumn={laneIsMerged ? undefined : (name) => void board.renameCustomColumn(laneId, name ?? "")}
				onDeleteColumn={laneIsMerged ? undefined : () => void board.deleteCustomColumn(laneId)}
				autoStartEditing={autoEditColumnId === laneId}
				onAutoEditConsumed={() => setAutoEditColumnId(null)}
				tip={tipColumnId === col.id ? currentTip : undefined}
				fullWidth={full}
				{...commonProps}
			/>
		);
	}

	if (isCarousel) {
		// One column per screen. Built-in collapsed defaults stay reachable; only
		// columns the user collapsed leave the rotation. Empty columns stay, so
		// positions are stable.
		const carouselColumns: CarouselColumn[] = lanes
			.filter((slot) => !collapseState.isUserCollapsed(laneKey(slot)))
			.map((slot) => ({
				id: laneKey(slot),
				label: slot.type === "builtin" ? customStatusLabels[slot.status] || t(statusKey(slot.status)) : slot.col.name,
				color: slot.type === "builtin" ? statusColors[slot.status] : slot.col.color ?? statusColors.todo,
				count: laneCount(slot),
				element: renderColumnElement(slot, true),
			}));
		const initialColumnId = carouselColumns.find((column) => column.id === "user-questions" && column.count > 0)?.id
			?? carouselColumns.find((column) => column.id === "review-by-user" && column.count > 0)?.id;
		return <MobileBoardCarousel columns={carouselColumns} initialColumnId={initialColumnId} />;
	}

	// The add-column strip sits right before Completed, the end-of-lifecycle
	// boundary; at the very end only if Completed is somehow absent.
	const hasCompleted = lanes.some((slot) => slot.type === "builtin" && slot.status === "completed");
	const desktopColumns = lanes.flatMap((slot) => {
		const element = renderColumnElement(slot, false);
		const beforeCompleted = !isSpaceBoard && slot.type === "builtin" && slot.status === "completed";
		return beforeCompleted ? [addColumnButton, element] : [element];
	});
	if (!hasCompleted && !isSpaceBoard) desktopColumns.push(addColumnButton);

	return (
		<div className="flex-1 min-h-0 flex gap-5 px-6 pb-6 pt-2 overflow-x-auto overflow-y-hidden kanban-scroll select-none">
			{desktopColumns}
		</div>
	);
}
