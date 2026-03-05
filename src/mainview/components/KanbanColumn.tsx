import { useState, useRef, useEffect, type Dispatch } from "react";
import type { CodingAgent, Project, Task, TaskStatus } from "../../shared/types";
import { STATUS_COLORS, hexToRgb, getAllowedTransitions } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { useT } from "../i18n";
import TaskCard from "./TaskCard";

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
	onReorderTask: (taskId: string, targetIndex: number) => void;
	dragFromStatus: TaskStatus | null;
	onDragStart: (taskId: string) => void;
	onTaskMoved: (taskId: string) => void;
	bellCounts: Map<string, number>;
	activeTaskId?: string;
	draggedTaskId: string | null;
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
	onReorderTask,
	dragFromStatus,
	onDragStart,
	onTaskMoved,
	bellCounts,
	activeTaskId,
	draggedTaskId,
}: KanbanColumnProps) {
	const t = useT();
	const color = STATUS_COLORS[status];
	const [dragOver, setDragOver] = useState(false);
	const [dropIndex, setDropIndex] = useState<number | null>(null);
	const taskListRef = useRef<HTMLDivElement>(null);

	// Is this a same-column reorder drag?
	const isSameColumnDrag = dragFromStatus === status;

	// Can this column accept a cross-column drop?
	const isCrossColumnTarget =
		dragFromStatus !== null &&
		dragFromStatus !== status &&
		getAllowedTransitions(dragFromStatus).includes(status);

	// Clear dropIndex when drag ends globally
	useEffect(() => {
		function handleDragEnd() {
			setDropIndex(null);
		}
		window.addEventListener("dragend", handleDragEnd);
		return () => window.removeEventListener("dragend", handleDragEnd);
	}, []);

	function handleDragOver(e: React.DragEvent) {
		if (!isCrossColumnTarget && !isSameColumnDrag) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";

		// Calculate drop index for same-column reorder
		if (isSameColumnDrag && taskListRef.current) {
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
		if (!isCrossColumnTarget && !isSameColumnDrag) return;
		e.preventDefault();
		if (isCrossColumnTarget) setDragOver(true);
	}

	function handleDragLeave(e: React.DragEvent) {
		if (e.currentTarget.contains(e.relatedTarget as Node)) return;
		setDragOver(false);
		setDropIndex(null);
	}

	function handleDrop(e: React.DragEvent) {
		e.preventDefault();
		setDragOver(false);
		const taskId = e.dataTransfer.getData("text/plain");
		if (!taskId) {
			setDropIndex(null);
			return;
		}

		if (isSameColumnDrag && dropIndex !== null) {
			// Same-column reorder — adjust index if dragging down
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
			className={`flex flex-col flex-shrink-0 w-[17.5rem] glass-column column-glow rounded-2xl border transition-colors ${
				showDropHighlight
					? "border-accent bg-accent/5 shadow-lg shadow-accent/10"
					: isCrossColumnTarget && dragFromStatus
						? "border-edge-active"
						: "border-transparent"
			}`}
			style={{ "--col-rgb": hexToRgb(color) } as React.CSSProperties}
			onDragOver={handleDragOver}
			onDragEnter={handleDragEnter}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{/* Column header */}
			<div
				className="px-4 py-3.5 flex-shrink-0"
				style={{ borderBottom: `2px solid ${color}30` }}
			>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2.5">
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

			{/* Add task button (only in To Do column) */}
			{status === "todo" && (
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
