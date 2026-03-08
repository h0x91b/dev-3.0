import { useState, useRef, useEffect, type Dispatch } from "react";
import type { CodingAgent, Project, Task, TaskStatus } from "../../shared/types";
import { hexToRgb, getAllowedTransitions } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { useT } from "../i18n";
import { useStatusColors } from "../hooks/useStatusColors";
import TaskCard from "./TaskCard";

// Module-level variable: set synchronously on dragstart, cleared on dragend.
// Avoids relying on dataTransfer.types which may not include custom MIME types in WKWebView.
let _activeDragColumnId: string | null = null;

interface KanbanColumnProps {
	status: TaskStatus;
	label: string;
	tasks: Task[];
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	onAddTask: () => void;
	agents: CodingAgent[];
	onLaunchVariants: (task: Task, targetStatus: TaskStatus) => void;
	onTaskDrop: (taskId: string, targetStatus: TaskStatus) => void;
	onTaskDropToCustomColumn?: (taskId: string, customColumnId: string) => void;
	onReorderTask: (taskId: string, targetIndex: number) => void;
	dragFromStatus: TaskStatus | null;
	dragFromCustomColumnId?: string | null;
	onDragStart: (taskId: string) => void;
	onTaskMoved: (taskId: string) => void;
	bellCounts: Map<string, number>;
	activeTaskId?: string;
	draggedTaskId: string | null;
	movingTaskIds: Set<string>;
	onSetMoving: (taskId: string, isMoving: boolean) => void;
	siblingMap: Map<string, Task[]>;
	// Custom column support
	isCustomColumn?: boolean;
	customColumnId?: string;
	colorOverride?: string;
	isDraggedColumn?: boolean;
	onColumnDragStart?: () => void;
	onColumnDragEnd?: () => void;
	// Column reorder drop target (left half = "before", right half = "after")
	onColumnDrop?: (side: "before" | "after") => void;
}

function KanbanColumn({
	status,
	label,
	tasks,
	project,
	dispatch,
	navigate,
	onAddTask,
	agents,
	onLaunchVariants,
	onTaskDrop,
	onTaskDropToCustomColumn,
	onReorderTask,
	dragFromStatus,
	dragFromCustomColumnId,
	onDragStart,
	onTaskMoved,
	bellCounts,
	activeTaskId,
	draggedTaskId,
	movingTaskIds,
	onSetMoving,
	siblingMap,
	isCustomColumn,
	customColumnId,
	colorOverride,
	isDraggedColumn,
	onColumnDragStart,
	onColumnDragEnd,
	onColumnDrop,
}: KanbanColumnProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const color = colorOverride ?? statusColors[status];
	const [dragOver, setDragOver] = useState(false);
	const [dropIndex, setDropIndex] = useState<number | null>(null);
	const [columnDragSide, setColumnDragSide] = useState<"before" | "after" | null>(null);
	const taskListRef = useRef<HTMLDivElement>(null);

	// Is this a same-column reorder drag?
	const isSameColumnDrag = isCustomColumn
		? customColumnId !== undefined && dragFromCustomColumnId === customColumnId
		: dragFromStatus === status && (dragFromCustomColumnId === null || dragFromCustomColumnId === undefined);

	// Can this column accept a cross-column drop?
	const isCrossColumnTarget = isCustomColumn
		// Custom columns accept drops from any column except themselves
		? (dragFromStatus !== null || dragFromCustomColumnId !== null) && dragFromCustomColumnId !== customColumnId
		// Built-in columns use transition logic; also accept from custom columns (underlying status governs)
		: dragFromStatus !== null && getAllowedTransitions(dragFromStatus).includes(status);

	// Clear dropIndex when drag ends globally
	useEffect(() => {
		function handleDragEnd() {
			setDropIndex(null);
			setColumnDragSide(null);
		}
		window.addEventListener("dragend", handleDragEnd);
		return () => window.removeEventListener("dragend", handleDragEnd);
	}, []);

	function handleDragOver(e: React.DragEvent) {
		// Column reorder: use module-level variable set synchronously on dragstart.
		// dataTransfer.types is NOT used because WKWebView may reject custom MIME types.
		if (isCustomColumn && onColumnDrop && _activeDragColumnId !== null && _activeDragColumnId !== customColumnId) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			setColumnDragSide(e.clientX < rect.left + rect.width / 2 ? "before" : "after");
			return;
		}
		// Task drag
		if (!isCrossColumnTarget && !isSameColumnDrag) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";

		// Calculate drop index for same-column reorder (built-in columns only)
		if (isSameColumnDrag && !isCustomColumn && taskListRef.current) {
			const taskElements = taskListRef.current.querySelectorAll("[data-task-id]");
			let newDropIndex = tasks.length;
			for (let i = 0; i < taskElements.length; i++) {
				const rect = taskElements[i].getBoundingClientRect();
				const midY = rect.top + rect.height / 2;
				if (e.clientY < midY) {
					newDropIndex = i;
					break;
				}
			}
			setDropIndex(newDropIndex);
		}
	}

	function handleDragEnter(e: React.DragEvent) {
		// Column reorder: must also preventDefault on dragenter for drop to fire
		if (isCustomColumn && onColumnDrop && _activeDragColumnId !== null && _activeDragColumnId !== customColumnId) {
			e.preventDefault();
			return;
		}
		if (!isCrossColumnTarget && !isSameColumnDrag) return;
		e.preventDefault();
		if (isCrossColumnTarget) setDragOver(true);
	}

	function handleDragLeave(e: React.DragEvent) {
		if (e.currentTarget.contains(e.relatedTarget as Node)) return;
		setDragOver(false);
		setDropIndex(null);
		setColumnDragSide(null);
	}

	function handleDrop(e: React.DragEvent) {
		e.preventDefault();
		setDragOver(false);

		// Column reorder drop (use module var; dataTransfer.getData won't have "dev3/column" in WKWebView)
		if (_activeDragColumnId && _activeDragColumnId !== customColumnId && isCustomColumn && onColumnDrop && columnDragSide) {
			setColumnDragSide(null);
			onColumnDrop(columnDragSide);
			return;
		}
		setColumnDragSide(null);

		const taskId = e.dataTransfer.getData("text/plain");
		// Ignore col: prefixed data (column drags that fell through without a side set)
		if (!taskId || taskId.startsWith("col:")) {
			setDropIndex(null);
			return;
		}

		if (isCustomColumn && customColumnId) {
			// Drop into a custom column
			onTaskDropToCustomColumn?.(taskId, customColumnId);
		} else if (isSameColumnDrag && dropIndex !== null) {
			// Same-column reorder
			const currentIndex = tasks.findIndex((t) => t.id === taskId);
			const adjustedIndex = currentIndex !== -1 && currentIndex < dropIndex
				? dropIndex - 1
				: dropIndex;
			if (currentIndex !== adjustedIndex) {
				onReorderTask(taskId, adjustedIndex);
			}
		} else if (isCrossColumnTarget) {
			onTaskDrop(taskId, status);
		}
		setDropIndex(null);
	}

	const showDropHighlight = dragOver && isCrossColumnTarget;

	return (
		<div
			className={`relative flex flex-col flex-shrink-0 w-[17.5rem] glass-column column-glow rounded-2xl border transition-colors ${
				showDropHighlight
					? "border-accent bg-accent/5 shadow-lg shadow-accent/10"
					: isCrossColumnTarget && (dragFromStatus || dragFromCustomColumnId)
						? "border-edge-active"
						: "border-transparent"
			} ${isDraggedColumn ? "opacity-40" : ""}`}
			style={{ "--col-rgb": hexToRgb(color) } as React.CSSProperties}
			onDragOver={handleDragOver}
			onDragEnter={handleDragEnter}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{/* Column reorder drop indicators */}
			{columnDragSide === "before" && (
				<div className="pointer-events-none absolute inset-y-0 -left-3 w-1 rounded-full bg-accent" />
			)}
			{columnDragSide === "after" && (
				<div className="pointer-events-none absolute inset-y-0 -right-3 w-1 rounded-full bg-accent" />
			)}
			{/* Column header */}
			<div
				className="px-4 py-3.5 flex-shrink-0"
				style={{ borderBottom: `2px solid ${color}30` }}
			>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2.5">
						{isCustomColumn && (
							<div
								className="cursor-grab active:cursor-grabbing text-fg-muted hover:text-fg-3 flex-shrink-0 select-none"
								draggable
								onDragStart={(e) => {
									e.stopPropagation();
									_activeDragColumnId = customColumnId ?? null;
									e.dataTransfer.setData("text/plain", `col:${customColumnId ?? ""}`);
									e.dataTransfer.effectAllowed = "move";
									onColumnDragStart?.();
								}}
								onDragEnd={(e) => {
									e.stopPropagation();
									_activeDragColumnId = null;
									onColumnDragEnd?.();
								}}
								title="Drag to reorder"
							>
								<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
									<circle cx="4" cy="3" r="1.2" />
									<circle cx="8" cy="3" r="1.2" />
									<circle cx="4" cy="6" r="1.2" />
									<circle cx="8" cy="6" r="1.2" />
									<circle cx="4" cy="9" r="1.2" />
									<circle cx="8" cy="9" r="1.2" />
								</svg>
							</div>
						)}
						<div
							className="w-3 h-3 rounded-full flex-shrink-0"
							style={{ background: color }}
						/>
						<span className="text-fg text-sm font-semibold">
							{label}
						</span>
					</div>
					{tasks.length > 0 && (
						<span
							className="text-xs font-bold px-2 py-0.5 rounded-full"
							style={{
								color,
								background: `${color}18`,
							}}
						>
							{tasks.length}
						</span>
					)}
				</div>
			</div>

			{/* Tasks */}
			<div ref={taskListRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
				{tasks.map((task, index) => (
					<div key={task.id} data-task-id={task.id}>
						{isSameColumnDrag && dropIndex === index && task.id !== draggedTaskId && (
							<div className="h-0.5 bg-accent rounded-full mx-1 mb-2 transition-all" />
						)}
						<TaskCard
							task={task}
							project={project}
							dispatch={dispatch}
							navigate={navigate}
							agents={agents}
							onLaunchVariants={onLaunchVariants}
							onDragStart={onDragStart}
							onTaskMoved={onTaskMoved}
							bellCount={bellCounts.get(task.id) ?? 0}
							isActiveInSplit={task.id === activeTaskId}
							isMoving={movingTaskIds.has(task.id)}
							onSetMoving={onSetMoving}
							siblingMap={siblingMap}
						/>
					</div>
				))}
				{isSameColumnDrag && dropIndex === tasks.length && (
					<div className="h-0.5 bg-accent rounded-full mx-1 mt-0 transition-all" />
				)}

				{tasks.length === 0 && (
					<div className="text-fg-muted text-sm text-center py-8">
						{t("kanban.noTasks")}
					</div>
				)}
			</div>

			{/* Add task button (only in To Do column, not custom columns) */}
			{!isCustomColumn && status === "todo" && (
				<div className="px-3 pb-3 flex-shrink-0">
					<button
						onClick={onAddTask}
						className="w-full text-fg-3 hover:text-accent text-sm font-medium text-center py-2.5 rounded-xl hover:bg-accent/10 border border-dashed border-edge hover:border-accent/30 transition-all"
					>
						{t("kanban.newTask")}
					</button>
				</div>
			)}
		</div>
	);
}

export default KanbanColumn;
