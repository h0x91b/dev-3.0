import { useState, useRef, useEffect, useLayoutEffect, type Dispatch } from "react";
import { createPortal } from "react-dom";
import type { CodingAgent, PortInfo, Project, Task, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, getTaskTitle } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT, statusKey } from "../i18n";
import { trackEvent } from "../analytics";
import { useStatusColors } from "../hooks/useStatusColors";
import { useTerminalPreview } from "../hooks/useTerminalPreview";
import LabelChip from "./LabelChip";
import LabelPicker from "./LabelPicker";
import SiblingPopover from "./SiblingPopover";
import OpenInMenu from "./OpenInMenu";
import TerminalPreviewPopover from "./TerminalPreviewPopover";
import { confirmTaskCompletion } from "../utils/confirmTaskCompletion";
import TaskDetailModal from "./TaskDetailModal";
import MiniPipeline from "./MiniPipeline";
import PipelineDropdown from "./PipelineDropdown";

interface TaskCardProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	agents: CodingAgent[];
	onLaunchVariants: (task: Task, targetStatus: TaskStatus) => void;
	onAddAttempts: (task: Task) => void;
	onDragStart: (taskId: string) => void;
	onTaskMoved: (taskId: string) => void;
	bellCount?: number;
	ports?: PortInfo[];
	isActiveInSplit?: boolean;
	isMoving?: boolean;
	onSetMoving?: (taskId: string, isMoving: boolean) => void;
	siblingMap?: Map<string, Task[]>;
	prInfo?: { number: number; url: string };
}

function TaskCard({ task, project, dispatch, navigate, agents, onLaunchVariants, onAddAttempts, onDragStart: onDragStartProp, onTaskMoved, bellCount = 0, ports, isActiveInSplit = false, isMoving: isMovingProp = false, onSetMoving, siblingMap, prInfo }: TaskCardProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const [moving, setMoving] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
	const [menuVisible, setMenuVisible] = useState(false);
	const [detailOpen, setDetailOpen] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const pickerAnchorRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);

	// Sibling popover state
	const [siblingPopoverOpen, setSiblingPopoverOpen] = useState(false);
	const siblingAnchorRef = useRef<HTMLButtonElement>(null);
	const groupMembers = task.groupId && siblingMap
		? (siblingMap.get(task.groupId) ?? [])
		: [];
	const hasSiblings = groupMembers.length > 1;
	const siblings = groupMembers.filter((s) => s.id !== task.id);

	const preview = useTerminalPreview();
	const cardRef = useRef<HTMLDivElement>(null);

	// Ports popover state
	const [portsPopoverOpen, setPortsPopoverOpen] = useState(false);
	const [portsPopoverPos, setPortsPopoverPos] = useState({ top: 0, left: 0 });
	const [portsPopoverVisible, setPortsPopoverVisible] = useState(false);
	const portsPopoverRef = useRef<HTMLDivElement>(null);
	const portsAnchorRef = useRef<HTMLButtonElement>(null);

	// Context menu ("Open in...") state
	const [ctxMenuOpen, setCtxMenuOpen] = useState(false);
	const [ctxMenuPos, setCtxMenuPos] = useState({ top: 0, left: 0 });

	const isPreparing = task.preparing === true;
	const isDisabled = moving || isMovingProp || isPreparing;
	const isTodo = task.status === "todo";
	const isCancelled = task.status === "cancelled";
	const isActive = ACTIVE_STATUSES.includes(task.status);
	const isCompleting = (moving || isMovingProp) && (task.status === "completed" || task.status === "cancelled");
	const color = statusColors[task.status];

	// Close menu on click outside
	useEffect(() => {
		if (!menuOpen) return;
		function handleClick(e: MouseEvent) {
			if (
				menuRef.current &&
				!menuRef.current.contains(e.target as Node) &&
				triggerRef.current &&
				!triggerRef.current.contains(e.target as Node)
			) {
				setMenuOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [menuOpen]);

	// After menu renders (invisible), measure and clamp position within viewport
	useLayoutEffect(() => {
		if (!menuOpen || !menuRef.current || !triggerRef.current) return;

		const menu = menuRef.current.getBoundingClientRect();
		const trigger = triggerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = trigger.bottom + 6;
		let left = trigger.left;

		// Flip above trigger if overflows bottom
		if (top + menu.height > vh - pad) {
			top = trigger.top - menu.height - 6;
		}
		// Clamp right edge
		if (left + menu.width > vw - pad) {
			left = vw - menu.width - pad;
		}
		// Clamp left edge
		if (left < pad) left = pad;
		// Clamp top edge
		if (top < pad) top = pad;

		setMenuPos({ top, left });
		setMenuVisible(true);
	}, [menuOpen]);

	// Ports popover: click outside to close
	useEffect(() => {
		if (!portsPopoverOpen) return;
		function handleClick(e: MouseEvent) {
			if (
				portsPopoverRef.current &&
				!portsPopoverRef.current.contains(e.target as Node) &&
				portsAnchorRef.current &&
				!portsAnchorRef.current.contains(e.target as Node)
			) {
				setPortsPopoverOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [portsPopoverOpen]);

	// Ports popover: viewport clamping (only reposition on open, not on port data updates)
	useLayoutEffect(() => {
		if (!portsPopoverOpen || !portsPopoverRef.current || !portsAnchorRef.current) return;
		const menu = portsPopoverRef.current.getBoundingClientRect();
		const trigger = portsAnchorRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;
		let top = trigger.bottom + 6;
		let left = trigger.left;
		if (top + menu.height > vh - pad) top = trigger.top - menu.height - 6;
		if (left + menu.width > vw - pad) left = vw - menu.width - pad;
		if (left < pad) left = pad;
		if (top < pad) top = pad;
		setPortsPopoverPos({ top, left });
		setPortsPopoverVisible(true);
	}, [portsPopoverOpen]);

	function toggleMenu(e: React.MouseEvent) {
		e.stopPropagation();
		if (!menuOpen && triggerRef.current) {
			const rect = triggerRef.current.getBoundingClientRect();
			setMenuPos({ top: rect.bottom + 6, left: rect.left });
			setMenuVisible(false);
		}
		setMenuOpen(!menuOpen);
	}

	async function handleMove(newStatus: TaskStatus) {
		// Intercept: todo → active status opens the LaunchVariantsModal
		if (task.status === "todo" && ACTIVE_STATUSES.includes(newStatus)) {
			setMenuOpen(false);
			onLaunchVariants(task, newStatus);
			return;
		}

		// Warn before completing/cancelling with unpushed changes
		if (
			task.worktreePath &&
			(newStatus === "completed" || newStatus === "cancelled")
		) {
			setMenuOpen(false);
			const proceed = await confirmTaskCompletion(task, project, newStatus, t);
			if (!proceed) return;
		}

		const fromStatus = task.status;
		const isTerminal = newStatus === "completed" || newStatus === "cancelled";
		setMenuOpen(false);

		// Optimistic update for terminal statuses — grey out and move immediately
		if (isTerminal) {
			dispatch({ type: "updateTask", task: { ...task, status: newStatus } });
			dispatch({ type: "clearBell", taskId: task.id });
			onTaskMoved(task.id);
			onSetMoving?.(task.id, true);
		} else {
			setMoving(true);
		}

		try {
			const updated = await api.request.moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus,
			});
			dispatch({ type: "updateTask", task: updated });
			if (!isTerminal) onTaskMoved(task.id);
			trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
		} catch (err) {
			// Auto-retry with force — environment is likely broken
			try {
				const updated = await api.request.moveTask({
					taskId: task.id,
					projectId: project.id,
					newStatus,
					force: true,
				});
				dispatch({ type: "updateTask", task: updated });
				if (!isTerminal) onTaskMoved(task.id);
				trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
			} catch (retryErr) {
				// Revert optimistic update on total failure
				if (isTerminal) {
					dispatch({ type: "updateTask", task });
				}
				alert(t("task.failedMove", { error: String(retryErr) }));
			}
		}
		if (isTerminal) {
			onSetMoving?.(task.id, false);
		} else {
			setMoving(false);
		}
	}

	async function handleMoveToCustomColumn(customColumnId: string) {
		setMenuOpen(false);
		setMoving(true);
		try {
			const updated = await api.request.moveTaskToCustomColumn({
				taskId: task.id,
				projectId: project.id,
				customColumnId,
			});
			dispatch({ type: "updateTask", task: updated });
			onTaskMoved(task.id);
			trackEvent("task_moved", { from_status: task.status, to_status: `custom:${customColumnId}` });
		} catch (err) {
			alert(t("task.failedMove", { error: String(err) }));
		}
		setMoving(false);
	}

	async function handleDelete() {
		setMenuOpen(false);
		const confirmed = await api.request.showConfirm({
			title: t("task.delete"),
			message: t("task.confirmDelete", { title: displayTitle }),
		});
		if (!confirmed) return;
		try {
			await api.request.deleteTask({
				taskId: task.id,
				projectId: project.id,
			});
			dispatch({ type: "removeTask", taskId: task.id });
			trackEvent("task_deleted", { project_id: project.id });
		} catch (err) {
			alert(t("task.failedDelete", { error: String(err) }));
		}
	}

	/** X button handler: cancel (from todo) or delete (from cancelled), with confirmation */
	async function handleDismiss(e: React.MouseEvent) {
		e.stopPropagation();
		if (isTodo) {
			const confirmed = await api.request.showConfirm({
				title: t("task.cancel"),
				message: t("task.confirmCancel", { title: displayTitle }),
			});
			if (!confirmed) return;
			handleMove("cancelled");
		} else if (isCancelled) {
			handleDelete();
		}
	}

	const isCompleted = task.status === "completed";

	function handleClick() {
		if (isDisabled) return;
		if (isActive && !menuOpen) {
			preview.close();
			const openMode = localStorage.getItem("dev3-task-open-mode") === "fullscreen" ? "fullscreen" : "split";
			if (openMode === "fullscreen") {
				navigate({ screen: "task", projectId: project.id, taskId: task.id });
			} else if (isActiveInSplit) {
				// Toggle: clicking the already-active card closes the split
				navigate({ screen: "project", projectId: project.id });
			} else {
				navigate({
					screen: "project",
					projectId: project.id,
					activeTaskId: task.id,
				});
			}
		} else if ((isCompleted || isCancelled) && !menuOpen) {
			setDetailOpen(true);
		}
	}

	function handleContextMenu(e: React.MouseEvent) {
		if (!task.worktreePath) return;
		e.preventDefault();
		e.stopPropagation();
		setCtxMenuPos({ top: e.clientY, left: e.clientX });
		setCtxMenuOpen(true);
	}

	function handleDragStart(e: React.DragEvent) {
		preview.close();
		e.dataTransfer.setData("text/plain", task.id);
		e.dataTransfer.effectAllowed = "move";
		onDragStartProp(task.id);
	}

	function handleTitleClick(e: React.MouseEvent) {
		if (isTodo) {
			e.stopPropagation();
			setDetailOpen(true);
		}
	}

	const displayTitle = getTaskTitle(task);
	const hasLongDescription = task.description !== displayTitle;

	function handleShowDescription(e: React.MouseEvent) {
		e.stopPropagation();
		setDetailOpen(true);
	}

	function handleCardMouseEnter() {
		if (!isActive || menuOpen) return;
		if (!cardRef.current) return;
		preview.handlers.onMouseEnter(task.id, cardRef.current);
	}

	function handleCardMouseLeave() {
		preview.handlers.onMouseLeave();
	}

	const showDismissButton = isTodo || isCancelled;

	return (
		<div
			ref={cardRef}
			draggable={!isDisabled && !detailOpen}
			onDragStart={handleDragStart}
			onContextMenu={handleContextMenu}
			onMouseEnter={handleCardMouseEnter}
			onMouseLeave={handleCardMouseLeave}
			className={`group relative p-3.5 glass-card rounded-xl transition-all border border-l-[3px] ${isActiveInSplit ? "border-accent/50 ring-2 ring-accent/30" : "border-transparent"} ${
				isActive || isCompleted || isCancelled
					? "cursor-pointer hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/25"
					: "cursor-grab active:cursor-grabbing hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/25"
			} ${isCompleting ? "grayscale opacity-40 pointer-events-none" : isPreparing ? "opacity-60 pointer-events-none" : isDisabled ? "opacity-50 pointer-events-none" : ""}`}
			style={{ borderLeftColor: isCompleting ? "#888" : color }}
			onClick={handleClick}
		>
			{/* Moving spinner overlay */}
			{isMovingProp && (
				<div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-base/40">
					<div className="w-4 h-4 border-2 border-fg-muted/30 border-t-accent rounded-full animate-spin" />
				</div>
			)}

			{/* Preparing spinner overlay — worktree is being created */}
			{isPreparing && (
				<div className="absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-xl bg-base/40">
					<div className="w-3.5 h-3.5 border-2 border-fg-muted/30 border-t-accent rounded-full animate-spin" />
					<span className="text-xs text-fg-2 font-medium">{t("task.preparing")}</span>
				</div>
			)}

			{/* Dismiss button — top-right, visible on hover */}
			{showDismissButton && (
				<button
					onClick={handleDismiss}
					className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded-md bg-fg/5 text-fg-3 hover:bg-danger/15 hover:text-danger transition-all"
					title={isCancelled ? t("task.delete") : t("task.cancel")}
					disabled={isDisabled}
				>
					<svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			)}

			{/* Bell badge — macOS Dock style, peeking outside the card */}
			{bellCount > 0 && (
				<div
					className="absolute -top-1.5 -right-1.5 z-10 min-w-[1.25rem] h-5 flex items-center justify-center px-1.5 rounded-full bg-red-500 shadow-lg shadow-red-500/40"
					title={t("task.bellTooltip")}
				>
					<span className="text-[0.6875rem] font-bold text-white leading-none">
						{bellCount > 9 ? "9+" : bellCount}
					</span>
				</div>
			)}

			{/* Seq + variant badge */}
			{task.variantIndex !== null ? (() => {
				const agent = task.agentId ? agents.find((a) => a.id === task.agentId) : null;
				const config = agent && task.configId
					? agent.configurations.find((c) => c.id === task.configId)
					: agent?.configurations.find((c) => c.id === agent.defaultConfigId) ?? agent?.configurations[0];

				let label = `#${task.seq} · ${t("task.attempt", { n: String(task.variantIndex) })}`;
				if (agent) {
					label += ` · ${agent.name}`;
					if (config) {
						label += config.model
							? ` (${config.name} · ${config.model})`
							: ` (${config.name})`;
					}
				}
				return (
					<div className="text-xs text-accent font-semibold mb-1.5 flex items-center gap-1.5">
						<span className="bg-accent/15 px-2 py-0.5 rounded-md">{label}</span>
					</div>
				);
			})() : (
				<div className="text-[0.625rem] text-fg-muted font-mono mb-1">#{task.seq}</div>
			)}

			{/* Title + description expand */}
			<div
				className={`text-fg text-sm leading-relaxed break-words font-medium pr-5 ${isTodo ? "cursor-pointer hover:text-fg-2" : ""}`}
				onClick={handleTitleClick}
				title={isTodo && hasLongDescription ? task.description : undefined}
			>
				{displayTitle}
			</div>
			{hasLongDescription && !isTodo && (
				<button
					onClick={handleShowDescription}
					className="mt-1 text-[0.6875rem] text-fg-muted hover:text-accent transition-colors flex items-center gap-1"
					title={t("task.showDescription")}
				>
					<svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h10" />
					</svg>
					{t("task.showDescription")}
				</button>
			)}

			{/* Task detail modal — portal to body so it's not clipped by card */}
			{detailOpen && createPortal(
				<TaskDetailModal
					task={task}
					project={project}
					dispatch={dispatch}
					onClose={() => setDetailOpen(false)}
				/>,
				document.body
			)}

			{/* Sibling popover */}
			{siblingPopoverOpen && siblingAnchorRef.current && siblings.length > 0 && (
				<SiblingPopover
					siblings={siblings}
					agents={agents}
					navigate={navigate}
					onClose={() => setSiblingPopoverOpen(false)}
					anchorEl={siblingAnchorRef.current}
					projectId={project.id}
				/>
			)}

			{/* Label chips row — always rendered so "+" is discoverable on hover */}
			{(() => {
				const projectLabels = project.labels ?? [];
				const taskLabelIds = task.labelIds ?? [];
				const assignedLabels = taskLabelIds
					.map((id) => projectLabels.find((l) => l.id === id))
					.filter(Boolean) as typeof projectLabels;

				async function removeLabel(labelId: string) {
					try {
						const updated = await api.request.setTaskLabels({
							taskId: task.id,
							projectId: project.id,
							labelIds: taskLabelIds.filter((id) => id !== labelId),
						});
						dispatch({ type: "updateTask", task: updated });
					} catch {
						// ignore
					}
				}

				return (
					<div className="flex items-center flex-wrap gap-1 mt-2 min-h-[1.125rem]">
						{assignedLabels.map((label) => (
							<LabelChip
								key={label.id}
								label={label}
								size="xs"
								onClick={(e) => {
									e.stopPropagation();
									setPickerOpen(true);
								}}
								onRemove={(e) => {
									e.stopPropagation();
									removeLabel(label.id);
								}}
							/>
						))}
						<button
							ref={pickerAnchorRef}
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								setPickerOpen(true);
							}}
							className="opacity-0 group-hover:opacity-70 hover:!opacity-100 flex items-center gap-1 px-1.5 py-0.5 rounded-md text-fg-3 hover:text-fg hover:bg-fg/8 transition-all flex-shrink-0"
						>
							<svg className="w-2.5 h-2.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
								<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
							</svg>
							<span className="text-[0.625rem] font-medium leading-none">Add label</span>
						</button>
						{pickerOpen && pickerAnchorRef.current && (
							<LabelPicker
								project={project}
								task={task}
								dispatch={dispatch}
								onClose={() => setPickerOpen(false)}
								anchorEl={pickerAnchorRef.current}
							/>
						)}
					</div>
				);
			})()}

			{/* Bottom row */}
			<div data-testid="task-card-footer" className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
				{/* Status dropdown trigger with mini-pipeline */}
				{(() => {
					const activeCol = task.customColumnId
						? (project.customColumns ?? []).find((c) => c.id === task.customColumnId)
						: null;
					return (
						<button
							ref={triggerRef}
							onClick={toggleMenu}
							className="mr-auto flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-fg/5"
							disabled={isDisabled}
						>
							{activeCol ? (
								<div
									className="w-2.5 h-2.5 rounded-full flex-shrink-0"
									style={{ background: activeCol.color, boxShadow: `0 0 6px ${activeCol.color}60` }}
								/>
							) : (
								<MiniPipeline status={task.status} />
							)}
							<span className="min-w-0 truncate text-xs text-fg-2">
								{activeCol ? activeCol.name : t(statusKey(task.status))}
							</span>
						</button>
					);
				})()}

				<div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
					{/* PR badge */}
					{prInfo && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								window.open(prInfo.url, "_blank");
							}}
							className="inline-flex max-w-full flex-shrink-0 items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold text-green-400 transition-colors hover:bg-green-500/20"
							title={t("task.openPR", { number: String(prInfo.number) })}
						>
							<span className="text-[0.6875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0401}"}</span>
							#{prInfo.number}
						</button>
					)}

					{/* Sibling variant dots */}
					{hasSiblings && (
						<button
							ref={siblingAnchorRef}
							onClick={(e) => { e.stopPropagation(); preview.close(); setSiblingPopoverOpen(!siblingPopoverOpen); }}
							className="flex items-center gap-1 rounded-lg px-1.5 py-1 transition-colors hover:bg-fg/5"
							title={t.plural("task.siblingsCount", siblings.length)}
						>
							{groupMembers.map((s) => (
								<span
									key={s.id}
									className={`h-2 w-2 flex-shrink-0 rounded-full ${s.id === task.id ? "ring-1 ring-fg ring-offset-1 ring-offset-base" : ""}`}
									style={{ background: statusColors[s.status] }}
								/>
							))}
						</button>
					)}

					{/* Port indicator for active tasks — compact icon + count, popover on click */}
					{isActive && ports && ports.length > 0 && (
						<button
							ref={portsAnchorRef}
							onClick={(e) => {
								e.stopPropagation();
								if (!portsPopoverOpen && portsAnchorRef.current) {
									const rect = portsAnchorRef.current.getBoundingClientRect();
									setPortsPopoverPos({ top: rect.bottom + 6, left: rect.left });
									setPortsPopoverVisible(false);
								}
								setPortsPopoverOpen(!portsPopoverOpen);
							}}
							className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-accent transition-colors hover:bg-accent/20"
							title={t.plural("ports.count", ports.length)}
						>
							<span className="text-[0.6875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF0AC"}</span>
							{ports.length}
						</button>
					)}

					{/* "Open in..." button for active tasks */}
					{isActive && task.worktreePath && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								const rect = (e.target as HTMLElement).getBoundingClientRect();
								setCtxMenuPos({ top: rect.bottom + 4, left: rect.left });
								setCtxMenuOpen(true);
							}}
							className="flex flex-shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-accent opacity-0 transition-all hover:bg-accent/15 group-hover:opacity-100"
							title={t("openIn.menuTitle")}
						>
							<span className="text-[0.75rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0379}"}</span>
						</button>
					)}

					{/* Right side actions */}
					{isTodo ? (
						/* Run button for TODO cards */
						<button
							onClick={(e) => {
								e.stopPropagation();
								onLaunchVariants(task, "in-progress");
							}}
							className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-green-900/30 transition-colors hover:bg-green-500"
							title={t("task.run")}
							disabled={isDisabled}
						>
							<svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24">
								<path d="M8 5v14l11-7z" />
							</svg>
							{t("task.run")}
						</button>
					) : isActive ? (
						/* Retry button for active cards */
						<button
							onClick={(e) => {
								e.stopPropagation();
								onAddAttempts(task);
							}}
							className="flex flex-shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-accent opacity-0 transition-all hover:bg-accent/15 group-hover:opacity-100"
							title={t("task.retry")}
							disabled={isDisabled}
						>
							<span className="text-[0.75rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0453}"}</span>
							{t("task.retry")}
						</button>
					) : null}
				</div>
			</div>

			{/* Status dropdown menu — portal + smart viewport clamping */}
			{menuOpen && createPortal(
				<div
					ref={menuRef}
					className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[11.25rem]"
					style={{
						top: menuPos.top,
						left: menuPos.left,
						visibility: menuVisible ? "visible" : "hidden",
					}}
					onClick={(e) => e.stopPropagation()}
				>
					<PipelineDropdown
						currentStatus={task.status}
						onMove={handleMove}
						onMoveToCustomColumn={handleMoveToCustomColumn}
						onDelete={isCancelled ? handleDelete : undefined}
						customColumns={project.customColumns}
						currentCustomColumnId={task.customColumnId}
					/>
				</div>,
				document.body
			)}

			{/* Ports popover */}
			{portsPopoverOpen && ports && ports.length > 0 && createPortal(
				<div
					ref={portsPopoverRef}
					className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-2 min-w-[10rem]"
					style={{
						top: portsPopoverPos.top,
						left: portsPopoverPos.left,
						visibility: portsPopoverVisible ? "visible" : "hidden",
					}}
					onClick={(e) => e.stopPropagation()}
				>
					<div className="px-3 py-1.5 text-[0.625rem] text-fg-3 uppercase tracking-wider font-semibold">
						{t("ports.title")}
					</div>
					{ports.map((p) => (
						<button
							key={p.port}
							onClick={() => window.open(`http://localhost:${p.port}`, "_blank")}
							className="w-full text-left px-3 py-1.5 text-sm text-fg-2 hover:bg-elevated-hover hover:text-fg flex items-center gap-2.5 transition-colors"
						>
							<span className="font-mono font-bold text-accent">:{p.port}</span>
							<span className="text-fg-muted text-xs">{p.processName}</span>
						</button>
					))}
				</div>,
				document.body
			)}

			{/* Context menu — "Open in..." */}
			{ctxMenuOpen && task.worktreePath && (
				<OpenInMenu
					position={ctxMenuPos}
					path={task.worktreePath}
					onClose={() => setCtxMenuOpen(false)}
				/>
			)}

			<TerminalPreviewPopover {...preview.state} />
		</div>
	);
}

export default TaskCard;
