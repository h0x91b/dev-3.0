import { useState, useRef, useEffect, type Dispatch } from "react";
import type { CodingAgent, PortInfo, Project, Task, TaskStatus, TipState } from "../../shared/types";
import { hexToRgb, getAllowedTransitions } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { useT } from "../i18n";
import { useStatusColors } from "../hooks/useStatusColors";
import TaskCard from "./TaskCard";
import TipCard from "./TipCard";
import type { Tip } from "../tips";

const COLUMN_TASK_LIMIT = 15;

// Module-level variable: set synchronously on dragstart, cleared on dragend.
// Avoids relying on dataTransfer.types which may not include custom MIME types in WKWebView.
let _activeDragColumnId: string | null = null;

interface KanbanColumnProps {
	status: TaskStatus;
	label: string;
	description?: string;
	tasks: Task[];
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	onAddTask: () => void;
	agents: CodingAgent[];
	onLaunchVariants: (task: Task, targetStatus: TaskStatus) => void;
	onAddAttempts: (task: Task) => void;
	onTaskDrop: (taskId: string, targetStatus: TaskStatus) => void;
	onTaskDropToCustomColumn?: (taskId: string, customColumnId: string) => void;
	onReorderTask: (taskId: string, targetIndex: number) => void;
	dragFromStatus: TaskStatus | null;
	dragFromCustomColumnId?: string | null;
	onDragStart: (taskId: string) => void;
	onTaskMoved: (taskId: string) => void;
	bellCounts: Map<string, number>;
	taskPorts: Map<string, PortInfo[]>;
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
	// PR numbers for task cards
	taskPrMap?: Map<string, { number: number; url: string }>;
	// Feature discovery tip
	tip?: Tip | null;
	tipState?: TipState;
	onTipChanged?: () => void;
	// Collapse support
	collapsed?: boolean;
	onCollapseToggle?: () => void;
	collapseDragHandlers?: { onDragEnter: () => void; onDragLeave: () => void; onDragEnd: () => void };
	// Rename support for built-in columns
	onRenameColumn?: (newName: string | null) => void;
}

function KanbanColumn({
	status,
	label,
	description,
	tasks,
	project,
	dispatch,
	navigate,
	onAddTask,
	agents,
	onLaunchVariants,
	onAddAttempts,
	onTaskDrop,
	onTaskDropToCustomColumn,
	onReorderTask,
	dragFromStatus,
	dragFromCustomColumnId,
	onDragStart,
	onTaskMoved,
	bellCounts,
	taskPorts,
	activeTaskId,
	draggedTaskId,
	movingTaskIds,
	onSetMoving,
	siblingMap,
	taskPrMap,
	isCustomColumn,
	customColumnId,
	colorOverride,
	isDraggedColumn,
	onColumnDragStart,
	onColumnDragEnd,
	onColumnDrop,
	tip,
	tipState,
	onTipChanged,
	collapsed,
	onCollapseToggle,
	collapseDragHandlers,
	onRenameColumn,
}: KanbanColumnProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const color = colorOverride ?? statusColors[status];
	const [dragOver, setDragOver] = useState(false);
	const [dropIndex, setDropIndex] = useState<number | null>(null);
	const [columnDragSide, setColumnDragSide] = useState<"before" | "after" | null>(null);
	const [showInfo, setShowInfo] = useState(false);
	const [infoPos, setInfoPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
	const [expanded, setExpanded] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const renameInputRef = useRef<HTMLInputElement>(null);
	const infoBtnRef = useRef<HTMLButtonElement>(null);
	const infoPopupRef = useRef<HTMLDivElement>(null);
	const taskListRef = useRef<HTMLDivElement>(null);
	const infoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Auto-collapse when column identity changes (e.g. project switch)
	const columnKey = `${status}:${customColumnId ?? ""}`;
	useEffect(() => {
		setExpanded(false);
	}, [columnKey]);

	// Cleanup info hover timer
	useEffect(() => {
		return () => { if (infoHideTimer.current) clearTimeout(infoHideTimer.current); };
	}, []);

	function showInfoHover() {
		if (infoHideTimer.current) { clearTimeout(infoHideTimer.current); infoHideTimer.current = null; }
		if (infoBtnRef.current) {
			const r = infoBtnRef.current.getBoundingClientRect();
			setInfoPos({ top: r.bottom + 6, left: r.left });
		}
		setShowInfo(true);
	}

	function scheduleHideInfo() {
		infoHideTimer.current = setTimeout(() => setShowInfo(false), 150);
	}

	function cancelHideInfo() {
		if (infoHideTimer.current) { clearTimeout(infoHideTimer.current); infoHideTimer.current = null; }
	}

	function startEditing() {
		if (!onRenameColumn) return;
		setEditValue(label);
		setEditing(true);
		// Focus input on next tick
		setTimeout(() => renameInputRef.current?.select(), 0);
	}

	function commitRename() {
		setEditing(false);
		if (!onRenameColumn) return;
		const trimmed = editValue.trim();
		// If empty or unchanged from the current label, reset (pass null to clear custom name)
		if (!trimmed || trimmed === label) {
			return;
		}
		onRenameColumn(trimmed);
	}

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
		// Self-ID for drag: custom columns use customColumnId, built-in columns use status
		const myDragId = customColumnId ?? status;
		// Column reorder: use module-level variable set synchronously on dragstart.
		// dataTransfer.types is NOT used because WKWebView may reject custom MIME types.
		// Any column (built-in or custom) with onColumnDrop accepts a column reorder drop.
		if (onColumnDrop && _activeDragColumnId !== null && _activeDragColumnId !== myDragId) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const side = e.clientX < rect.left + rect.width / 2 ? "before" : "after";
			setColumnDragSide(side);
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
		const myDragId = customColumnId ?? status;
		// Column reorder: must also preventDefault on dragenter for drop to fire
		if (onColumnDrop && _activeDragColumnId !== null && _activeDragColumnId !== myDragId) {
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
		const myDragId = customColumnId ?? status;
		if (_activeDragColumnId && _activeDragColumnId !== myDragId && onColumnDrop && columnDragSide) {
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

	const visibleTasks = expanded ? tasks : tasks.slice(0, COLUMN_TASK_LIMIT);
	const hiddenCount = tasks.length - visibleTasks.length;

	// Collapsed column rendering
	if (collapsed) {
		return (
			<>
			<div
				className={`group/col relative flex flex-col flex-shrink-0 w-12 glass-column column-glow rounded-2xl border cursor-pointer select-none ${
					showDropHighlight
						? "border-accent bg-accent/5 shadow-lg shadow-accent/10"
						: isCrossColumnTarget && (dragFromStatus || dragFromCustomColumnId)
							? "border-edge-active"
							: "border-transparent"
				} ${isDraggedColumn ? "opacity-40" : ""}`}
				style={{
					"--col-rgb": hexToRgb(color),
					...(columnDragSide === "before" && { boxShadow: "-4px 0 0 0 rgb(var(--accent))" }),
					...(columnDragSide === "after" && { boxShadow: "4px 0 0 0 rgb(var(--accent))" }),
				} as React.CSSProperties}
				onClick={onCollapseToggle}
				onDragOver={handleDragOver}
				onDragEnter={(e) => {
					handleDragEnter(e);
					collapseDragHandlers?.onDragEnter();
				}}
				onDragLeave={(e) => {
					handleDragLeave(e);
					collapseDragHandlers?.onDragLeave();
				}}
				onDrop={(e) => {
					handleDrop(e);
					collapseDragHandlers?.onDragEnd();
				}}
				data-collapsed-column
			>
				{/* Color dot */}
				<div className="flex justify-center pt-4 pb-2">
					<div
						className="w-3 h-3 rounded-full flex-shrink-0"
						style={{ background: color }}
					/>
				</div>

				{/* Task count badge */}
				{tasks.length > 0 && (
					<div className="flex justify-center pb-2">
						<span
							className="text-xs font-bold px-1.5 py-0.5 rounded-full"
							style={{ color, background: `${color}18` }}
						>
							{tasks.length}
						</span>
					</div>
				)}

				{/* Vertical label */}
				<div className="flex-1 flex justify-center items-start pt-1 overflow-hidden">
					<span
						className="kanban-col-vertical-label text-fg-3 text-xs font-semibold whitespace-nowrap"
					>
						{label}
					</span>
				</div>

				{/* New Task button (Todo column only) */}
				{!isCustomColumn && status === "todo" && (
					<div className="flex justify-center pb-3">
						<button
							onClick={(e) => { e.stopPropagation(); onAddTask(); }}
							className="text-fg-3 hover:text-accent transition-colors w-7 h-7 flex items-center justify-center rounded-lg hover:bg-accent/10 border border-dashed border-edge hover:border-accent/30 text-base leading-none"
							aria-label={t("kanban.newTask")}
							title={t("kanban.newTask")}
						>
							+
						</button>
					</div>
				)}
			</div>
			</>
		);
	}

	return (
		<>
		<div
			className={`group/col relative flex flex-col flex-shrink-0 w-[17.5rem] glass-column column-glow rounded-2xl border transition-colors ${
				showDropHighlight
					? "border-accent bg-accent/5 shadow-lg shadow-accent/10"
					: isCrossColumnTarget && (dragFromStatus || dragFromCustomColumnId)
						? "border-edge-active"
						: "border-transparent"
			} ${isDraggedColumn ? "opacity-40" : ""}`}
			style={{
				"--col-rgb": hexToRgb(color),
				// Column reorder indicator via box-shadow avoids dragleave false-fires
				// from pointer-events:none children extending outside element bounds.
				...(columnDragSide === "before" && { boxShadow: "-4px 0 0 0 rgb(var(--accent))" }),
				...(columnDragSide === "after" && { boxShadow: "4px 0 0 0 rgb(var(--accent))" }),
			} as React.CSSProperties}
			onDragOver={handleDragOver}
			onDragEnter={(e) => {
				handleDragEnter(e);
				collapseDragHandlers?.onDragEnter();
			}}
			onDragLeave={(e) => {
				handleDragLeave(e);
				collapseDragHandlers?.onDragLeave();
			}}
			onDrop={(e) => {
				handleDrop(e);
				collapseDragHandlers?.onDragEnd();
			}}
		>
			{/* Column header */}
			<div
				className="px-3 py-2.5 flex-shrink-0"
				style={{ borderBottom: `2px solid ${color}30` }}
			>
				<div className="flex items-center gap-1.5">
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
							<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
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
						className="w-2.5 h-2.5 rounded-full flex-shrink-0"
						style={{ background: color }}
					/>
					{editing ? (
						<input
							ref={renameInputRef}
							type="text"
							value={editValue}
							onChange={(e) => setEditValue(e.target.value)}
							onBlur={commitRename}
							onKeyDown={(e) => {
								if (e.key === "Enter") e.currentTarget.blur();
								if (e.key === "Escape") { setEditing(false); }
							}}
							className="text-fg text-sm font-semibold bg-transparent outline-none border-b border-accent flex-1 min-w-0"
							autoFocus
						/>
					) : (
						<span className="text-fg text-sm font-semibold truncate flex-1 min-w-0">
							{label}
						</span>
					)}
					{!editing && onRenameColumn && (
						<button
							onClick={startEditing}
							className="text-fg-muted hover:text-fg-3 transition-colors w-4 h-4 flex items-center justify-center text-xs leading-none flex-shrink-0 opacity-0 group-hover/col:opacity-100 focus:opacity-100"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							aria-label={t("kanban.renameColumn")}
							title={t("kanban.renameColumn")}
						>
							{"\u{F11E7}"}
						</button>
					)}
					{description && (
						<button
							ref={infoBtnRef}
							onMouseEnter={showInfoHover}
							onMouseLeave={scheduleHideInfo}
							className="text-fg-muted hover:text-fg-3 transition-colors w-4 h-4 flex items-center justify-center text-xs leading-none flex-shrink-0 opacity-0 group-hover/col:opacity-100 focus:opacity-100"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							aria-label="Column info"
						>
							{"\uF449"}
						</button>
					)}
					{tasks.length > 0 && (
						<span
							className="text-[0.625rem] font-bold px-1.5 py-px rounded-full flex-shrink-0"
							style={{
								color,
								background: `${color}18`,
							}}
						>
							{tasks.length}
						</span>
					)}
					{onCollapseToggle && (
						<button
							onClick={(e) => { e.stopPropagation(); onCollapseToggle(); }}
							className="text-fg-muted hover:text-fg-3 transition-colors w-4 h-4 flex items-center justify-center text-sm leading-none flex-shrink-0 opacity-0 group-hover/col:opacity-100 focus:opacity-100"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							aria-label={t("kanban.collapseColumn")}
							title={t("kanban.collapseColumn")}
						>
							{"\u{F0403}"}
						</button>
					)}
				</div>
			</div>

			{/* Tasks */}
			<div
				ref={taskListRef}
				className="flex-1 overflow-y-auto px-3 py-3 space-y-2"
				onDoubleClick={!isCustomColumn && status === "todo" ? (e) => {
					// Only trigger when clicking empty space, not on a task card
					if ((e.target as HTMLElement).closest("[data-task-id]")) return;
					onAddTask();
				} : undefined}
			>
				{visibleTasks.map((task, index) => (
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
							onAddAttempts={onAddAttempts}
							onDragStart={onDragStart}
							onTaskMoved={onTaskMoved}
							bellCount={bellCounts.get(task.id) ?? 0}
							ports={taskPorts.get(task.id)}
							isActiveInSplit={task.id === activeTaskId}
							isMoving={movingTaskIds.has(task.id)}
							onSetMoving={onSetMoving}
							siblingMap={siblingMap}
							prInfo={taskPrMap?.get(task.id)}
						/>
					</div>
				))}
				{isSameColumnDrag && dropIndex === visibleTasks.length && (
					<div className="h-0.5 bg-accent rounded-full mx-1 mt-0 transition-all" />
				)}

				{hiddenCount > 0 && (
					<button
						onClick={() => setExpanded(true)}
						className="w-full text-fg-muted hover:text-fg-2 text-xs text-center py-2 mt-1 rounded-lg hover:bg-raised-hover transition-colors"
					>
						{t("kanban.showMore", { count: String(hiddenCount) })}
					</button>
				)}
				{expanded && tasks.length > COLUMN_TASK_LIMIT && (
					<button
						onClick={() => {
							setExpanded(false);
							taskListRef.current?.scrollTo({ top: 0, behavior: "smooth" });
						}}
						className="w-full text-fg-muted hover:text-fg-2 text-xs text-center py-2 mt-1 rounded-lg hover:bg-raised-hover transition-colors"
					>
						{t("kanban.showLess")}
					</button>
				)}

				{tasks.length === 0 && !tip && (
					<div className="text-fg-muted text-sm text-center py-8">
						{t("kanban.noTasks")}
					</div>
				)}

				</div>

			{/* Tip card — pinned to bottom, above the add-task button */}
			{tip && tipState && onTipChanged && (
				<div className="px-3 pb-3 flex-shrink-0">
					<TipCard tip={tip} tipState={tipState} onChanged={onTipChanged} />
				</div>
			)}

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
		{/* Info tooltip — rendered outside column div to escape stacking context */}
		{showInfo && description && (
			<div
				ref={infoPopupRef}
				className="fixed z-[9999] w-56 px-3.5 py-2.5 rounded-xl border border-edge shadow-xl text-xs text-fg leading-relaxed"
				style={{ top: infoPos.top, left: infoPos.left, background: "rgb(var(--surface-overlay))" }}
				onMouseEnter={cancelHideInfo}
				onMouseLeave={scheduleHideInfo}
			>
				{description}
			</div>
		)}
		</>
	);
}

export default KanbanColumn;
