import { useState, useRef, useEffect, useLayoutEffect, type Dispatch } from "react";
import { toast } from "../toast";
import { createPortal } from "react-dom";
import type { CodingAgent, PortInfo, Project, ResourceUsage, Task, TaskPRBadgeInfo, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, getPreparingStageProgress, getTaskTitle } from "../../shared/types";
import { getTaskOpenMode, type AppAction, type Route } from "../state";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n";
import { formatBytes } from "../utils/formatBytes";
import { formatCountdown } from "../../shared/duration";
import { getStatusLabel } from "../utils/statusLabel";
import { trackEvent, agentNameFromId } from "../analytics";
import { useStatusColors } from "../hooks/useStatusColors";
import { useTerminalPreview } from "../hooks/useTerminalPreview";
import LabelChip from "./LabelChip";
import LabelPicker from "./LabelPicker";
import PriorityBadge from "./PriorityBadge";
import VariantDots from "./VariantDots";
import OpenInMenu from "./OpenInMenu";
import TerminalPreviewPopover from "./TerminalPreviewPopover";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import TaskDetailModal from "./TaskDetailModal";
import MiniPipeline from "./MiniPipeline";
import PipelineDropdown from "./PipelineDropdown";
import ScheduleMessageModal from "./ScheduleMessageModal";
import ScheduledMessagesChip from "./ScheduledMessagesChip";
import AgentLauncherBadge, { resolveAgentLauncherIcon } from "./AgentLauncherBadge";
import { PREPARING_STAGE_LABELS } from "./TaskPreparingView";
import Tooltip from "./Tooltip";
import TaskShutdownOverlay from "./TaskShutdownOverlay";

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
	resourceUsage?: ResourceUsage;
	bellCount?: number;
	/** Accumulated attention reasons (from `dev3 attention`), shown in the hover preview. */
	bellReasons?: string[];
	ports?: PortInfo[];
	isActiveInSplit?: boolean;
	isMoving?: boolean;
	onSetMoving?: (taskId: string, isMoving: boolean) => void;
	siblingMap?: Map<string, Task[]>;
	prInfo?: TaskPRBadgeInfo;
}

function TaskCard({ task, project, dispatch, navigate, agents, onLaunchVariants, onAddAttempts, onDragStart: onDragStartProp, onTaskMoved, resourceUsage, bellCount = 0, bellReasons, ports, isActiveInSplit = false, isMoving: isMovingProp = false, onSetMoving, siblingMap, prInfo }: TaskCardProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const [moving, setMoving] = useState(false);
	const [cancellingPreparation, setCancellingPreparation] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
	const [menuVisible, setMenuVisible] = useState(false);
	const [detailOpen, setDetailOpen] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const pickerAnchorRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);

	const groupMembers = task.groupId && siblingMap
		? (siblingMap.get(task.groupId) ?? [])
		: [];

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
	// Transient teardown window pushed by the server while completing/cancelling
	// (destroy session → cleanup script → remove worktree). Unlike `preparing`,
	// the card is NOT openable — the worktree/session are being destroyed.
	const isShuttingDown = task.shuttingDown === true;
	const isDisabled = moving || isMovingProp || isPreparing || cancellingPreparation || isShuttingDown;
	const isTodo = task.status === "todo";
	const isCancelled = task.status === "cancelled";
	const isActive = ACTIVE_STATUSES.includes(task.status);
	const isCompleting = (moving || isMovingProp) && (task.status === "completed" || task.status === "cancelled");
	const color = statusColors[task.status];

	// Deferred launch ("Start in…") — countdown badge with Start now / Cancel.
	// Only meaningful on todo cards; the field vanishes when the launch fires.
	const sched = isTodo ? task.scheduledLaunch : null;
	const [schedPopoverOpen, setSchedPopoverOpen] = useState(false);
	const [, setSchedTick] = useState(0);
	useEffect(() => {
		if (!sched) return;
		// Re-render every 30s so the countdown stays fresh without a per-second tick.
		const id = setInterval(() => setSchedTick((n) => n + 1), 30_000);
		return () => clearInterval(id);
	}, [sched?.at]);

	async function handleCancelSchedule(e: React.MouseEvent) {
		e.stopPropagation();
		setSchedPopoverOpen(false);
		try {
			const updated = await api.request.cancelScheduledLaunch({ taskId: task.id, projectId: project.id });
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			toast.error(t("task.scheduleCancelFailed", { error: String(err) }), { taskId: task.id });
		}
	}

	// Scheduled messages ("Send later") — a queue on a live-agent task; the chip
	// shares the deferred-timer slot with `scheduledLaunch` (never coexist: todo
	// vs live). Rendering + queue controls live in ScheduledMessagesChip.
	const hasLiveAgent = isActive && !!task.worktreePath;
	const [scheduleMsgOpen, setScheduleMsgOpen] = useState(false);

	async function handleSetPriority(priority: Task["priority"]) {
		if (!priority) return;
		try {
			// Group-wide: the RPC returns every changed task in the variant group.
			const changed = await api.request.setTaskPriority({ taskId: task.id, projectId: project.id, priority });
			for (const t of changed) dispatch({ type: "updateTask", task: t });
		} catch (err) {
			toast.error(t("priority.failedSet", { error: String(err) }), { taskId: task.id });
		}
	}

	async function handleStartScheduledNow(e: React.MouseEvent) {
		e.stopPropagation();
		setSchedPopoverOpen(false);
		try {
			// Spawned/updated tasks arrive via the taskUpdated push broadcast;
			// no local dispatch needed beyond kicking off the RPC.
			await api.request.startScheduledLaunchNow({ taskId: task.id, projectId: project.id });
		} catch (err) {
			toast.error(t("launch.failedLaunch", { error: String(err) }), { taskId: task.id });
		}
	}

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

		setMenuOpen(false);
		const isTerminal = newStatus === "completed" || newStatus === "cancelled";

		await moveTaskToStatus({
			task,
			project,
			newStatus,
			dispatch,
			t,
			onMoved: () => onTaskMoved(task.id),
			onMovingChange: (moving) =>
				isTerminal ? onSetMoving?.(task.id, moving) : setMoving(moving),
		});
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
			trackEvent("task_moved", { from_status: task.status, to_status: `custom:${customColumnId}`, agent_name: agentNameFromId(task.agentId) });
		} catch (err) {
			toast.error(t("task.failedMove", { error: String(err) }), { taskId: task.id });
		}
		setMoving(false);
	}

	async function handleDelete() {
		setMenuOpen(false);
		const confirmed = await confirm({
			title: t("task.delete"),
			message: t("task.confirmDelete", { title: displayTitle }),
			danger: true,
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
			toast.error(t("task.failedDelete", { error: String(err) }), { taskId: task.id });
		}
	}

	async function handleCancelPreparation(e: React.MouseEvent) {
		e.stopPropagation();
		if (cancellingPreparation) return;
		setCancellingPreparation(true);
		try {
			const updated = await api.request.cancelTaskPreparation({
				taskId: task.id,
				projectId: project.id,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			toast.error(t("task.failedMove", { error: String(err) }), { taskId: task.id });
			setCancellingPreparation(false);
			return;
		}
		setCancellingPreparation(false);
	}

	/** X button handler: cancel (from todo) or delete (from cancelled), with confirmation */
	async function handleDismiss(e: React.MouseEvent) {
		e.stopPropagation();
		if (isTodo) {
			const confirmed = await confirm({
				title: t("task.cancel"),
				message: t("task.confirmCancel", { title: displayTitle }),
				danger: true,
			});
			if (!confirmed) return;
			handleMove("cancelled");
		} else if (isCancelled) {
			handleDelete();
		}
	}

	const isCompleted = task.status === "completed";
	const preparingStage = task.preparingStage ?? "resolving-config";
	const preparingProgress = Math.max(
		4,
		Math.min(
			100,
			typeof task.preparingProgress === "number"
				? task.preparingProgress
				: getPreparingStageProgress(preparingStage),
		),
	);
	const preparingStageLabel = t(PREPARING_STAGE_LABELS[preparingStage]);

	function handleClick() {
		// A still-preparing task is `isDisabled` (no drag, dimmed) but must remain
		// openable so the main view can show its loading state instead of leaving
		// the previously-active task's terminal on screen.
		if (isDisabled && !isPreparing) return;
		if (cancellingPreparation) return;
		if (isActive && !menuOpen) {
			preview.close();
			const openMode = getTaskOpenMode();
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
		} else if ((isCompleted || isCancelled || isTodo) && !menuOpen) {
			// Non-active cards (todo/completed/cancelled) have no terminal to open,
			// so a body click surfaces the task's detail. Todo previously only did
			// this from the title; matching it here keeps clicks consistent and lets
			// the keyboard hint ("jump to task") land somewhere for todo cards too.
			setDetailOpen(true);
		}
	}

	function handleContextMenu(e: React.MouseEvent) {
		if (isShuttingDown) return;
		if (!task.worktreePath) return;
		e.preventDefault();
		e.stopPropagation();
		preview.close();
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
	const prBadge = prInfo ? (
		<Tooltip content={t("task.openPR", { number: String(prInfo.number) })} detail={t("ttip.task.openPR")}>
			<button
				onClick={(e) => {
					e.stopPropagation();
					window.open(prInfo.url, "_blank");
				}}
				className="inline-flex h-5 max-w-full flex-shrink-0 items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold leading-none text-green-400 transition-colors hover:bg-green-500/20"
				aria-label={t("task.openPR", { number: String(prInfo.number) })}
			>
				<span className="text-[0.6875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0401}"}</span>
				<span className="leading-none">#{prInfo.number}</span>
			</button>
		</Tooltip>
	) : null;

	// CI + PR-review status badges. Clicking a badge bounces the task to your
	// review (`review-by-user`) so a signalled PR resurfaces for action.
	// NOTE (open question for PR review): the exact per-signal target column is
	// still TBD — for now every badge click maps to `review-by-user`.
	const CI_BADGE: Record<NonNullable<TaskPRBadgeInfo["ciStatus"]>, { glyph: string; cls: string; key: TranslationKey }> = {
		success: { glyph: "", cls: "text-green-400 bg-green-500/10 hover:bg-green-500/20", key: "task.ci.success" },
		failure: { glyph: "", cls: "text-danger bg-danger/10 hover:bg-danger/20", key: "task.ci.failure" },
		pending: { glyph: "", cls: "text-yellow-400 bg-yellow-500/10 hover:bg-yellow-500/20", key: "task.ci.pending" },
	};
	const REVIEW_BADGE: Record<NonNullable<TaskPRBadgeInfo["reviewState"]>, { glyph: string; cls: string; key: TranslationKey }> = {
		approved: { glyph: "", cls: "text-green-400 bg-green-500/10 hover:bg-green-500/20", key: "task.review.approved" },
		changes_requested: { glyph: "", cls: "text-danger bg-danger/10 hover:bg-danger/20", key: "task.review.changesRequested" },
		commented: { glyph: "", cls: "text-yellow-400 bg-yellow-500/10 hover:bg-yellow-500/20", key: "task.review.commented" },
	};
	const ciMeta = prInfo?.ciStatus ? CI_BADGE[prInfo.ciStatus] : null;
	const ciBadge = ciMeta ? (
		<Tooltip content={t(ciMeta.key)} detail={t("ttip.task.ci")}>
			<button
				onClick={(e) => {
					e.stopPropagation();
					handleMove("review-by-user");
				}}
				className={`inline-flex h-5 flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold leading-none transition-colors ${ciMeta.cls}`}
				aria-label={t(ciMeta.key)}
			>
				<span className="text-[0.6875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{ciMeta.glyph}</span>
				<span className="leading-none">CI</span>
			</button>
		</Tooltip>
	) : null;
	const reviewMeta = prInfo?.reviewState ? REVIEW_BADGE[prInfo.reviewState] : null;
	const reviewBadge = reviewMeta ? (
		<Tooltip content={t(reviewMeta.key)} detail={t("ttip.task.review")}>
			<button
				onClick={(e) => {
					e.stopPropagation();
					handleMove("review-by-user");
				}}
				className={`inline-flex h-5 flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold leading-none transition-colors ${reviewMeta.cls}`}
				aria-label={t(reviewMeta.key)}
			>
				<span className="text-[0.6875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{reviewMeta.glyph}</span>
			</button>
		</Tooltip>
	) : null;

	function handleShowDescription(e: React.MouseEvent) {
		e.stopPropagation();
		setDetailOpen(true);
	}

	function handleCardMouseEnter() {
		if (!isActive || menuOpen || isShuttingDown) return;
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
			data-task-id={task.id}
			data-hint-id={task.id}
			data-help-id="board.task-card"
			draggable={!isDisabled && !detailOpen}
			onDragStart={handleDragStart}
			onContextMenu={handleContextMenu}
			onMouseEnter={handleCardMouseEnter}
			onMouseLeave={handleCardMouseLeave}
			className={`group relative p-3.5 glass-card rounded-xl transition-all border border-l-[3px] ${isActiveInSplit ? "border-accent ring-2 ring-accent/70 shadow-lg shadow-accent/20" : "border-transparent"} ${
				isActive || isCompleted || isCancelled
					? "cursor-pointer hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/25"
					: "cursor-grab active:cursor-grabbing hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/25"
			} ${isCompleting || isShuttingDown ? "grayscale opacity-40 pointer-events-none" : isPreparing ? "opacity-60" : isDisabled ? "opacity-50 pointer-events-none" : ""}`}
			style={{ borderLeftColor: isCompleting || isShuttingDown ? "#888" : color }}
			onClick={handleClick}
		>
			{/* Moving spinner overlay */}
			{isMovingProp && (
				<div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-base/40">
					<div className="w-4 h-4 border-2 border-fg-muted/30 border-t-accent rounded-full animate-spin" />
				</div>
			)}

			{/* Preparing overlay — show compact stage progress while setup work runs */}
			{isPreparing && (
				<div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-base/45 px-3 backdrop-blur-[2px]">
					<div className="w-full max-w-[15.5rem] rounded-xl border border-edge bg-overlay/95 px-3 py-2.5 shadow-xl shadow-black/30">
						<div className="flex items-center gap-2">
							<div className="w-3.5 h-3.5 border-2 border-fg-muted/30 border-t-accent rounded-full animate-spin" />
							<span className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-fg-3">
								{t("task.preparing")}
							</span>
						</div>
						<div className="mt-1.5 truncate text-sm font-medium text-fg">
							{preparingStageLabel}
						</div>
						<div
							className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-fg/10"
							role="progressbar"
							aria-label={t("task.preparing")}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={preparingProgress}
							aria-valuetext={preparingStageLabel}
						>
							<div
								className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
								style={{ width: `${preparingProgress}%` }}
							/>
						</div>
						<div className="mt-2 flex items-center justify-end gap-2">
							{hasLongDescription && (
								<Tooltip content={t("task.showDescription")} detail={t("ttip.task.showDescription")}>
									<button
										onClick={handleShowDescription}
										className="rounded-lg border border-edge bg-elevated/90 px-2.5 py-1 text-[0.6875rem] text-fg-2 transition-colors hover:border-edge-active hover:text-fg"
									>
										{t("task.showDescription")}
									</button>
								</Tooltip>
							)}
							<Tooltip content={t("task.cancel")} detail={t("ttip.task.cancel")}>
								<button
									onClick={handleCancelPreparation}
									disabled={cancellingPreparation}
									className="rounded-lg border border-danger/50 bg-danger/10 px-2.5 py-1 text-[0.6875rem] text-danger transition-colors hover:border-danger hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-60"
								>
									{t("task.cancel")}
								</button>
							</Tooltip>
						</div>
					</div>
				</div>
			)}

			{/* Shared teardown feedback used by the active-task surfaces too. */}
			{isShuttingDown && <TaskShutdownOverlay />}

			{/* Dismiss button — top-right, visible on hover */}
			{showDismissButton && (
				<Tooltip content={isCancelled ? t("task.delete") : t("task.cancel")} detail={isCancelled ? t("ttip.task.delete") : t("ttip.task.cancel")}>
					<button
						onClick={handleDismiss}
						className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded-md bg-fg/5 text-fg-3 hover:bg-danger/15 hover:text-danger transition-all"
						aria-label={isCancelled ? t("task.delete") : t("task.cancel")}
						disabled={isDisabled}
					>
						<svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</Tooltip>
			)}

			{/* Bell badge — macOS Dock style, peeking outside the card */}
			{bellCount > 0 && (
				<div
					className="absolute -top-1.5 -right-1.5 z-10 min-w-[1.25rem] h-5 flex items-center justify-center px-1.5 rounded-full bg-red-500 shadow-lg shadow-red-500/40"
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
				const configLabel = config
					? (config.model ? `${config.name} · ${config.model}` : config.name)
					: "";
				const prefixLabel = `#${task.seq} · ${t("task.attempt", { n: String(task.variantIndex) })}`;
				const hasLauncherIcon = agent ? resolveAgentLauncherIcon(agent) !== null : false;
				const topLabel = agent && !hasLauncherIcon ? `${prefixLabel} · ${agent.name}` : prefixLabel;
				return (
					<div className="text-xs text-accent font-semibold mb-1.5 flex flex-col items-start gap-0.5">
						<span className="inline-flex items-center gap-1.5">
							<PriorityBadge priority={task.priority} onChange={handleSetPriority} />
							<span className="bg-accent/15 px-2 py-0.5 rounded-md inline-flex min-h-6 items-center gap-1.5">
								{agent && hasLauncherIcon && <AgentLauncherBadge agent={agent} />}
								<span>{topLabel}</span>
							</span>
						</span>
						{configLabel && (
							<span className="pl-1 text-[0.6875rem] font-medium leading-tight text-accent/80">
								{configLabel}
							</span>
						)}
					</div>
				);
			})() : (
				<div className="mb-1 flex items-center gap-1.5">
					<PriorityBadge priority={task.priority} onChange={handleSetPriority} />
					<span className="text-[0.625rem] text-fg-muted font-mono">#{task.seq}</span>
				</div>
			)}

			{/* Title + description expand */}
			<div
				className={`text-fg text-sm leading-relaxed break-words font-medium pr-5 ${isTodo ? "cursor-pointer hover:text-fg-2" : ""}`}
				onClick={handleTitleClick}
				title={isTodo && hasLongDescription ? task.description : undefined}
			>
				{task.scratch && (
					<span
						className="text-fg-3 mr-1.5"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						title={t("task.scratchSession")}
					>
						{"\u{F018D}"}
					</span>
				)}
				{task.automationId && (
					<span
						className="text-fg-3 mr-1.5"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						title={t("task.automationRun")}
					>
						{"\u{F0150}"}
					</span>
				)}
				{displayTitle}
			</div>
			{hasLongDescription && !isTodo && (
				<Tooltip content={t("task.showDescription")} detail={t("ttip.task.showDescription")}>
					<button
						onClick={handleShowDescription}
						className="mt-1 text-[0.6875rem] text-fg-muted hover:text-accent transition-colors flex items-center gap-1"
					>
						<svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h10" />
						</svg>
						{t("task.showDescription")}
					</button>
				</Tooltip>
			)}

			{/* Task detail modal — portal to body so it's not clipped by card */}
			{detailOpen && createPortal(
				<TaskDetailModal
					task={task}
					project={project}
					dispatch={dispatch}
					onClose={() => setDetailOpen(false)}
					onLaunchVariants={onLaunchVariants}
				/>,
				document.body
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

				async function toggleLabel(labelId: string) {
					const newIds = taskLabelIds.includes(labelId)
						? taskLabelIds.filter((id) => id !== labelId)
						: [...taskLabelIds, labelId];
					try {
						const updated = await api.request.setTaskLabels({
							taskId: task.id,
							projectId: project.id,
							labelIds: newIds,
						});
						dispatch({ type: "updateTask", task: updated });
					} catch {
						// ignore
					}
				}

				return (
					<div className="flex items-start mt-2 min-h-[1.125rem] gap-2">
					<div className="flex items-center flex-wrap gap-1 min-w-0 flex-1">
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
								dispatch={dispatch}
								taskId={task.id}
								onClose={() => setPickerOpen(false)}
								anchorEl={pickerAnchorRef.current}
								selectedIds={taskLabelIds}
								onToggle={toggleLabel}
							/>
						)}
					</div>
					{!isActive && (
						<Tooltip content={task.watched ? t("task.unwatchTooltip") : t("task.watchTooltip")} detail={t("ttip.task.watch")}>
							<button
								onClick={async (e) => {
									e.stopPropagation();
									try {
										const updated = await api.request.toggleTaskWatch({
											taskId: task.id,
											projectId: project.id,
											watched: !task.watched,
										});
										dispatch({ type: "updateTask", task: updated });
									} catch {
										// Toggle failed silently — secondary action
									}
								}}
								className={`flex-shrink-0 flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-xs transition-all hover:bg-fg/5 ${
									task.watched
										? "text-accent"
										: "opacity-0 group-hover:opacity-70 text-fg-3 hover:!opacity-100"
								}`}
								aria-label={task.watched ? t("task.unwatchTooltip") : t("task.watchTooltip")}
								disabled={isDisabled}
							>
								<span className="text-[0.75rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
									{task.watched ? "\u{F009A}" : "\u{F0F1C}"}
								</span>
								<span className="text-[0.6875rem]">{task.watched ? t("task.watching") : t("task.watch")}</span>
							</button>
						</Tooltip>
					)}
				</div>
				);
			})()}

			{/* Bottom row — pipeline + badges */}
			<div data-testid="task-card-footer" className="mt-2 flex min-w-0 items-center gap-1.5">
				{/* Status dropdown trigger with mini-pipeline */}
				{(() => {
					const activeCol = task.customColumnId
						? (project.customColumns ?? []).find((c) => c.id === task.customColumnId)
						: null;
					return (
						<button
							ref={triggerRef}
							onClick={toggleMenu}
							className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-fg/5"
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
								{activeCol ? activeCol.name : getStatusLabel(task.status, t, project)}
							</span>
						</button>
					);
				})()}

				{/* Deferred-launch countdown badge (todo cards with a pending "Start in…") */}
				{sched && (
					<div className="relative flex-shrink-0">
						<Tooltip content={t("task.scheduledTooltip")}>
							<button
								data-testid="task-card-scheduled-badge"
								onClick={(e) => { e.stopPropagation(); setSchedPopoverOpen(!schedPopoverOpen); }}
								className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-xs text-accent transition-colors hover:bg-fg/5"
							>
								<svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
									<circle cx="12" cy="12" r="9" />
									<path d="M12 7v5l3 2" />
								</svg>
								{formatCountdown(new Date(sched.at).getTime() - Date.now())}
							</button>
						</Tooltip>
						{schedPopoverOpen && (
							<div
								className="absolute bottom-full left-0 mb-1 z-30 min-w-[10rem] rounded-lg border border-edge bg-elevated shadow-lg py-1"
								onClick={(e) => e.stopPropagation()}
							>
								<button
									onClick={handleStartScheduledNow}
									className="w-full text-left px-3 py-1.5 text-xs text-fg hover:bg-fg/5 transition-colors"
								>
									{t("task.startNow")}
								</button>
								<button
									onClick={handleCancelSchedule}
									className="w-full text-left px-3 py-1.5 text-xs text-danger hover:bg-fg/5 transition-colors"
								>
									{t("task.cancelSchedule")}
								</button>
							</div>
						)}
					</div>
				)}

				{/* Scheduled-message countdown chip (live-agent cards with a pending "Send later") */}
				{!isTodo && <ScheduledMessagesChip task={task} project={project} dispatch={dispatch} placement="up" />}

				{/* PR + CI/review badges for non-active cards */}
				{!isActive && prBadge}
				{!isActive && ciBadge}
				{!isActive && reviewBadge}

				{/* Sibling variant dots */}
				<VariantDots
					groupMembers={groupMembers}
					currentTaskId={task.id}
					statusColors={statusColors}
					agents={agents}
					navigate={navigate}
					projectId={project.id}
					onOpen={preview.close}
					testId={`variant-indicator-${task.id}`}
				/>

				{/* Port indicator for active tasks */}
				{isActive && ports && ports.length > 0 && (
					<Tooltip content={t.plural("ports.count", ports.length)} detail={t("ttip.task.ports")}>
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
							aria-label={t.plural("ports.count", ports.length)}
						>
							<span className="text-[0.6875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF0AC"}</span>
							{ports.length}
						</button>
					</Tooltip>
				)}

				{/* Resource usage badge */}
				{isActive && resourceUsage && (
					<span
						className={`inline-flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.625rem] ${
							resourceUsage.rss > 4 * 1024 * 1024 * 1024
								? "text-red-400 bg-red-500/10"
								: resourceUsage.rss > 2 * 1024 * 1024 * 1024
									? "text-yellow-400 bg-yellow-500/10"
									: "text-fg-3 bg-fg/5"
						}`}
						title={t("resources.details", { cpu: resourceUsage.cpu.toFixed(1), memory: formatBytes(resourceUsage.rss) })}
					>
						<span className="text-[0.6875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{"\u{F035B}"}
						</span>
						{formatBytes(resourceUsage.rss)}
						{resourceUsage.cpu >= 1 && (
							<>
								<span className="text-fg-muted">·</span>
								{resourceUsage.cpu.toFixed(0)}%
							</>
						)}
					</span>
				)}

				{/* Run button for TODO cards — right-aligned */}
				{isTodo && (
					<>
						<div className="flex-1" />
						<Tooltip content={t("task.run")} detail={t("ttip.task.run")}>
							<button
								onClick={(e) => {
									e.stopPropagation();
									onLaunchVariants(task, "in-progress");
								}}
								className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-green-900/30 transition-colors hover:bg-green-500"
								disabled={isDisabled}
							>
								<svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24">
									<path d="M8 5v14l11-7z" />
								</svg>
								{t("task.run")}
							</button>
						</Tooltip>
					</>
				)}
			</div>

			{/* PR / CI / review status badges — their own row so they don't crowd the
			    action row's Watch / + Variant controls (which previously squeezed them
			    onto one overflowing line). */}
			{isActive && (prBadge || ciBadge || reviewBadge) && (
				<div data-testid="task-card-status-badges" className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
					{prBadge}
					{ciBadge}
					{reviewBadge}
				</div>
			)}

			{/* Action row for active tasks — Open in... | Watch | + Variant */}
			{isActive && (
				<div data-testid="task-card-action-row" className="mt-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
					<div className="flex min-w-0 items-center gap-1">
						{task.worktreePath && (
							<Tooltip content={t("openIn.menuTitle")} detail={t("ttip.openIn.menu")}>
								<button
									onClick={(e) => {
										e.stopPropagation();
										const rect = (e.target as HTMLElement).getBoundingClientRect();
										setCtxMenuPos({ top: rect.bottom + 4, left: rect.left });
										setCtxMenuOpen(true);
									}}
									className="flex flex-shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-accent transition-all hover:bg-accent/15"
									aria-label={t("openIn.menuTitle")}
								>
									<span className="text-[0.75rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0379}"}</span>
								</button>
							</Tooltip>
						)}
						<Tooltip content={task.watched ? t("task.unwatchTooltip") : t("task.watchTooltip")} detail={t("ttip.task.watch")}>
							<button
								onClick={async (e) => {
									e.stopPropagation();
									try {
										const updated = await api.request.toggleTaskWatch({
											taskId: task.id,
											projectId: project.id,
											watched: !task.watched,
										});
										dispatch({ type: "updateTask", task: updated });
									} catch {
										// Toggle failed silently — secondary action
									}
								}}
								className={`flex flex-shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs transition-all hover:bg-fg/5 ${
									task.watched
										? "text-accent font-medium"
										: "opacity-0 group-hover:opacity-70 text-fg-3 hover:!opacity-100"
								}`}
								aria-label={task.watched ? t("task.unwatchTooltip") : t("task.watchTooltip")}
								disabled={isDisabled}
							>
								<span className="text-[0.75rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
									{task.watched ? "\u{F009A}" : "\u{F0F1C}"}
								</span>
								<span className="text-[0.6875rem]">{task.watched ? t("task.watching") : t("task.watch")}</span>
							</button>
						</Tooltip>
					</div>
					<div className="min-w-0" />
					<Tooltip content={t("task.addVariant")} detail={t("ttip.task.addVariant")}>
						<button
							onClick={(e) => {
								e.stopPropagation();
								preview.close();
								onAddAttempts(task);
							}}
							className="flex flex-shrink-0 justify-self-end items-center rounded-lg px-2 py-1 text-xs font-medium text-accent transition-all hover:bg-accent/15"
							disabled={isDisabled}
						>
							{t("task.addVariant")}
						</button>
					</Tooltip>
				</div>
			)}


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
						project={project}
					/>
					{hasLiveAgent && (
						<>
							<div className="my-1 border-t border-edge" />
							<button
								onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setScheduleMsgOpen(true); }}
								className="w-full text-left px-3 py-1.5 text-sm text-fg-2 hover:bg-elevated-hover hover:text-fg transition-colors"
							>
								{t("task.sendMessageLater")}
							</button>
						</>
					)}
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
					taskId={task.id}
					onClose={() => setCtxMenuOpen(false)}
				/>
			)}

			{scheduleMsgOpen && createPortal(
				<ScheduleMessageModal
					task={task}
					project={project}
					dispatch={dispatch}
					onClose={() => setScheduleMsgOpen(false)}
				/>,
				document.body,
			)}

			<TerminalPreviewPopover
				{...preview.state}
				taskId={task.id}
				projectId={project.id}
				overview={task.overview ?? null}
				userOverview={task.userOverview ?? null}
				description={task.description}
				attentionReasons={bellReasons}
			/>
		</div>
	);
}

export default TaskCard;
