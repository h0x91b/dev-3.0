import { useState, useRef, useEffect, useLayoutEffect, type Dispatch } from "react";
import { toast } from "../toast";
import { createPortal } from "react-dom";
import type { CodingAgent, DevServerSummary, PortInfo, Project, ResourceUsage, Task, TaskPRBadgeInfo, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, getAllowedTransitions, getPreparingStageProgress, getTaskTitle, isCoordinatorTask, isTaskDisconnected } from "../../shared/types";
import { getTaskOpenMode, type AppAction, type Route } from "../state";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n";
import { formatBytes } from "../utils/formatBytes";
import { formatCountdown } from "../../shared/duration";
import { trackEvent, agentNameFromId } from "../analytics";
import { useStatusColors } from "../hooks/useStatusColors";
import { useTerminalPreview } from "../hooks/useTerminalPreview";
import { useIsTruncated } from "../hooks/useIsTruncated";
import LabelChip from "./LabelChip";
import LabelPicker from "./LabelPicker";
import PriorityBadge from "./PriorityBadge";
import VariantDots from "./VariantDots";
import NativeBackendMark from "./NativeBackendMark";
import ForeignCodeMark from "./ForeignCodeMark";
import OpenInMenu from "./OpenInMenu";
import TerminalPreviewPopover from "./TerminalPreviewPopover";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import TaskDetailModal from "./TaskDetailModal";
import PipelineDropdown, { PipelineMenuAction } from "./PipelineDropdown";
import TaskCardRail from "./TaskCardRail";
import StatusMenuPortal from "./StatusMenuPortal";
import { useStatusMenu } from "../hooks/useStatusMenu";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useMobile } from "../hooks/useMobile";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import ScheduleMessageModal from "./ScheduleMessageModal";
import ScheduledMessagesChip from "./ScheduledMessagesChip";
import AgentLauncherBadge, { resolveAgentLauncherIcon } from "./AgentLauncherBadge";
import { PREPARING_STAGE_LABELS } from "./TaskPreparingView";
import Tooltip from "./Tooltip";
import TaskShutdownOverlay from "./TaskShutdownOverlay";
import TaskPrStatusPopover from "./TaskPrStatusPopover";
import { summarizeMergeability, type PRMergeabilityReason } from "../../shared/pr-status";

/** Deferred-time glyph: the scheduled-launch badge and the "send later" menu row. */
function ClockIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</svg>
	);
}

interface TaskCardProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	agents: CodingAgent[];
	onLaunchVariants: (task: Task, targetStatus: TaskStatus) => void;
	onAddAttempts: (task: Task) => void;
	onDragStart: (taskId: string) => void;
	resourceUsage?: ResourceUsage;
	bellCount?: number;
	/** Accumulated attention reasons (from `dev3 attention`), shown in the hover preview. */
	bellReasons?: string[];
	ports?: PortInfo[];
	devServer?: DevServerSummary;
	isActiveInSplit?: boolean;
	isMoving?: boolean;
	onSetMoving?: (taskId: string, isMoving: boolean) => void;
	siblingMap?: Map<string, Task[]>;
	prInfo?: TaskPRBadgeInfo;
	/** Opens the selected task's diff at its first unresolved review thread. */
	onOpenUnresolvedComments?: (task: Task) => void;
	/** Reopens the New Task popup on a draft card instead of the detail modal. */
	onEditDraft?: (task: Task) => void;
}

function TaskCard({ task, project, dispatch, navigate, agents, onLaunchVariants, onAddAttempts, onDragStart: onDragStartProp, resourceUsage, bellCount = 0, bellReasons, ports, devServer, isActiveInSplit = false, isMoving: isMovingProp = false, onSetMoving, siblingMap, prInfo, onOpenUnresolvedComments, onEditDraft }: TaskCardProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const isMobile = useMobile();
	const [moving, setMoving] = useState(false);
	const [quickCompleting, setQuickCompleting] = useState(false);
	const [cancellingPreparation, setCancellingPreparation] = useState(false);
	const statusMenu = useStatusMenu(narrow);
	const { open: menuOpen, setOpen: setMenuOpen } = statusMenu;
	const [detailOpen, setDetailOpen] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const pickerAnchorRef = useRef<HTMLButtonElement>(null);
	/** Mobile has no "+ Add label" button, so the picker anchors to the chip row. */
	const labelRowRef = useRef<HTMLDivElement>(null);

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
	// An unfinished draft: not runnable, and a click reopens the New Task popup.
	const isDraft = task.draft === true;
	// Parked: agent, terminal and dev server killed, worktree intact. The card is
	// inert (no drag, no column change) but still opens, and still completes.
	const isHibernated = task.hibernated === true;
	// Its session died with the app (force quit, reboot). Nothing was lost, but
	// nothing is running either — the card must not pass for live work.
	const isDisconnected = isTaskDisconnected(task);
	const isCoordinator = isCoordinatorTask(task);
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

	// The ✓ acknowledges the click on the same tick — the dialog it opens still
	// has a git check streaming into it, so silence here reads as a dead button.
	async function handleQuickComplete(e: React.MouseEvent) {
		e.stopPropagation();
		setQuickCompleting(true);
		try {
			await handleMove("completed", { alwaysConfirm: true });
		} finally {
			setQuickCompleting(false);
		}
	}

	async function handleMove(newStatus: TaskStatus, opts?: { alwaysConfirm?: boolean }) {
		// Intercept: todo → active status opens the LaunchVariantsModal
		if (task.status === "todo" && ACTIVE_STATUSES.includes(newStatus)) {
			setMenuOpen(false);
			// A draft would be refused by the lifecycle machine at the end of the
			// launch flow — say so now instead of walking the user through it.
			if (isDraft) {
				toast.error(t("kanban.draftNotDroppable"), { taskId: task.id });
				return;
			}
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
			onOpenTask: openTaskFromDialog,
			alwaysConfirm: opts?.alwaysConfirm,
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
			confirmLabel: t("task.deleteConfirmLabel"),
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
				confirmLabel: t("task.confirmCancelLabel"),
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
		if (isDraft && onEditDraft && !menuOpen) {
			onEditDraft(task);
			return;
		}
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

	function openTaskFromDialog() {
		setDetailOpen(false);
		const openMode = getTaskOpenMode();
		if (openMode === "fullscreen") {
			navigate({ screen: "task", projectId: project.id, taskId: task.id });
		} else {
			navigate({ screen: "project", projectId: project.id, activeTaskId: task.id });
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
		if (isDraft && onEditDraft) {
			e.stopPropagation();
			onEditDraft(task);
			return;
		}
		if (isTodo) {
			e.stopPropagation();
			setDetailOpen(true);
		}
	}

	const displayTitle = getTaskTitle(task);
	const hasLongDescription = task.description !== displayTitle;
	const openUnresolvedInDiff = onOpenUnresolvedComments
		? () => onOpenUnresolvedComments(task)
		: undefined;
	const prBadge = prInfo ? (
		<TaskPrStatusPopover prInfo={prInfo} projectId={project.id} taskId={task.id} onShowUnresolved={openUnresolvedInDiff}>
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					window.open(prInfo.url, "_blank");
				}}
				className="inline-flex h-5 max-w-full flex-shrink-0 items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 font-mono text-dense font-semibold leading-none text-success transition-colors hover:bg-success/20"
				aria-label={t("task.openPR", { number: String(prInfo.number) })}
			>
				<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0401}"}</span>
				<span className="leading-none">{t("task.prNumber", { number: String(prInfo.number) })}</span>
			</button>
		</TaskPrStatusPopover>
	) : null;

	// PR status badges. Every badge opens the pull request; hovering any one of
	// them opens the shared checks/conflict popover.
	//
	// Mergeability replaces the old standalone CI badge — GitHub's merge-state
	// already folds failing/blocking checks into one verdict, and the popover
	// keeps the per-check breakdown for detail.
	const MERGE_BADGE_REASON: Record<PRMergeabilityReason, TranslationKey> = {
		conflict: "task.mergeBadge.conflict",
		blocked: "task.mergeBadge.blocked",
		behind: "task.mergeBadge.behind",
		draft: "task.mergeBadge.draft",
		unstable: "task.mergeBadge.unstable",
		hooks: "task.mergeBadge.blocked",
	};
	const mergeability = prInfo ? summarizeMergeability(prInfo.mergeState) : null;
	const mergeBadge = mergeability && mergeability.state !== "unknown" ? (() => {
		const ok = mergeability.state === "mergeable";
		const label = ok
			? t("task.mergeBadge.mergeable")
			: mergeability.reason
				? t(MERGE_BADGE_REASON[mergeability.reason])
				: t("task.mergeBadge.notMergeable");
		return (
			<TaskPrStatusPopover prInfo={prInfo!} projectId={project.id} taskId={task.id} onShowUnresolved={openUnresolvedInDiff}>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						window.open(prInfo!.url, "_blank");
					}}
					className={`inline-flex h-5 max-w-full flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-dense font-semibold leading-none transition-colors ${ok ? "text-success bg-success/10 hover:bg-success/20" : "text-danger bg-danger/10 hover:bg-danger/20"}`}
					aria-label={t(ok ? "task.mergeBadge.mergeableAria" : "task.mergeBadge.notMergeableAria")}
				>
					<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{ok ? "\u{F0623}" : "\uf05e"}</span>
					<span className="truncate leading-none">{label}</span>
				</button>
			</TaskPrStatusPopover>
		);
	})() : null;
	const REVIEW_BADGE: Record<NonNullable<TaskPRBadgeInfo["reviewState"]>, { glyph: string | null; square?: boolean; cls: string; key: TranslationKey }> = {
		approved: { glyph: null, square: true, cls: "text-success bg-success/10 hover:bg-success/20", key: "task.review.approved" },
		changes_requested: { glyph: "", cls: "text-danger bg-danger/10 hover:bg-danger/20", key: "task.review.changesRequested" },
		commented: { glyph: "", cls: "text-warning-strong bg-warning/10 hover:bg-warning/20", key: "task.review.commented" },
	};
	const reviewMeta = prInfo?.reviewState ? REVIEW_BADGE[prInfo.reviewState] : null;
	const reviewBadge = reviewMeta ? (
		<TaskPrStatusPopover prInfo={prInfo!} projectId={project.id} taskId={task.id} onShowUnresolved={openUnresolvedInDiff}>
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					window.open(prInfo!.url, "_blank");
				}}
				className={`inline-flex flex-shrink-0 items-center rounded font-mono text-dense font-semibold leading-none transition-colors ${reviewMeta.square ? "h-5 w-5 justify-center p-0" : "h-5 gap-1 px-1.5 py-0.5"} ${reviewMeta.cls}`}
				aria-label={t(reviewMeta.key)}
			>
				{reviewMeta.glyph === null ? (
					<svg
						className="h-3.5 w-3.5"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<circle cx="8.5" cy="7.5" r="3" />
						<path d="M3.5 19c.4-3.2 2.1-5 5-5s4.6 1.8 5 5" />
						<path d="m15 17 2 2 4-5" />
					</svg>
				) : (
					<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{reviewMeta.glyph}</span>
				)}
			</button>
		</TaskPrStatusPopover>
	) : null;
	const unresolvedCount = prInfo?.unresolvedCount ?? 0;
	const commentBadge = prInfo && unresolvedCount > 0 ? (
		<TaskPrStatusPopover prInfo={prInfo} projectId={project.id} taskId={task.id} onShowUnresolved={openUnresolvedInDiff}>
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					window.open(prInfo.url, "_blank");
				}}
				className="inline-flex h-5 flex-shrink-0 items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 font-mono text-dense font-semibold leading-none text-warning-strong transition-colors hover:bg-warning/20"
				aria-label={t.plural("task.prUnresolvedComments", unresolvedCount)}
			>
				<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF086"}</span>
				<span className="leading-none">{unresolvedCount}</span>
			</button>
		</TaskPrStatusPopover>
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

	// ---- LIFECYCLE zone inputs ----------------------------------------------
	const activeCol = task.customColumnId
		? (project.customColumns ?? []).find((c) => c.id === task.customColumnId)
		: null;
	// The rail's ✓ is now a 44px touch target on narrow, so it no longer has to be
	// desktop-only. Deliberately NOT gated on `isHibernated`: finishing a parked
	// task must not require waking it first.
	const canQuickComplete = !isDisabled && getAllowedTransitions(task.status).includes("completed");
	const railColor = isCompleting || isShuttingDown ? "#888" : activeCol ? activeCol.color : color;

	// ---- IDENTITY zone inputs -----------------------------------------------
	const agent = task.agentId ? agents.find((a) => a.id === task.agentId) : null;
	const agentConfig = agent && task.configId
		? agent.configurations.find((c) => c.id === task.configId)
		: agent?.configurations.find((c) => c.id === agent.defaultConfigId) ?? agent?.configurations[0];
	const configLabel = agentConfig
		? (agentConfig.model ? `${agentConfig.name} · ${agentConfig.model}` : agentConfig.name)
		: agent?.name ?? "";
	// A lone variant is not a variant — `1/1` says nothing, and the spelled-out
	// "Variant 1" ate the header room the config string exists for.
	const variantFraction = task.variantIndex !== null && groupMembers.length > 1
		? `${task.variantIndex}/${groupMembers.length}`
		: null;
	const hasLauncherIcon = agent ? resolveAgentLauncherIcon(agent) !== null : false;
	const [configRef, configTruncated] = useIsTruncated<HTMLSpanElement>(configLabel);

	// ---- SIGNALS zone: read-only facts, grouped git / run / time -------------
	const gitSignals = [prBadge, mergeBadge, reviewBadge, commentBadge].filter(Boolean);
	const runSignals: React.ReactNode[] = [];
	if (isActive && ports && ports.length > 0) {
		runSignals.push(
			<Tooltip key="ports" content={t.plural("ports.count", ports.length)} detail={t("ttip.task.ports")}>
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
					className="inline-flex h-5 flex-shrink-0 items-center gap-1 rounded bg-accent/10 px-1.5 font-mono text-dense text-accent transition-colors hover:bg-accent/20"
					aria-label={t.plural("ports.count", ports.length)}
				>
					<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{""}</span>
					{ports.length}
				</button>
			</Tooltip>,
		);
	}
	if (isActive && resourceUsage) {
		runSignals.push(
			<span
				key="res"
				className={`inline-flex h-5 flex-shrink-0 items-center gap-1 rounded px-1.5 font-mono text-dense ${
					resourceUsage.rss > 4 * 1024 * 1024 * 1024
						? "text-red-400 bg-red-500/10"
						: resourceUsage.rss > 2 * 1024 * 1024 * 1024
							? "text-yellow-400 bg-yellow-500/10"
							: "text-fg-3 bg-fg/5"
				}`}
				title={t("resources.details", { cpu: resourceUsage.cpu.toFixed(1), memory: formatBytes(resourceUsage.rss) })}
			>
				<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
					{"\u{F035B}"}
				</span>
				{formatBytes(resourceUsage.rss)}
				{resourceUsage.cpu >= 1 && (
					<>
						<span className="text-fg-muted">·</span>
						{resourceUsage.cpu.toFixed(0)}%
					</>
				)}
			</span>,
		);
	}
	const timeSignals: React.ReactNode[] = [];
	if (sched) {
		timeSignals.push(
			<div key="sched" className="relative flex-shrink-0">
				<Tooltip content={t("task.scheduledTooltip")}>
					<button
						data-testid="task-card-scheduled-badge"
						onClick={(e) => { e.stopPropagation(); setSchedPopoverOpen(!schedPopoverOpen); }}
						className="flex h-5 items-center gap-1 rounded px-1.5 text-micro text-accent transition-colors hover:bg-fg/5"
					>
						<ClockIcon className="w-3 h-3" />
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
			</div>,
		);
	}
	if (!isTodo) {
		timeSignals.push(
			<ScheduledMessagesChip key="msgs" task={task} project={project} dispatch={dispatch} placement="up" />,
		);
	}
	const variantDots = (
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
	);

	// A group separator, so compartments read apart without extra colour.
	const groupDivider = <span aria-hidden="true" className="h-4 w-px flex-shrink-0 bg-edge" />;
	const signalGroups: React.ReactNode[] = [];
	if (gitSignals.length) {
		signalGroups.push(
			<div key="git" data-testid="task-card-status-badges" className="flex min-w-0 flex-wrap items-center gap-1">
				{gitSignals}
			</div>,
		);
	}
	if (runSignals.length) {
		signalGroups.push(
			<div key="run" data-testid="task-card-run-signals" className="flex min-w-0 flex-wrap items-center gap-1">
				{runSignals}
			</div>,
		);
	}
	if (timeSignals.length) {
		signalGroups.push(
			<div key="time" data-testid="task-card-time-signals" className="flex min-w-0 flex-wrap items-center gap-1">
				{timeSignals}
			</div>,
		);
	}

	// ---- The dev-server split control ---------------------------------------
	// Left half opens the lowest port, right half stops. A stopped server has
	// nothing to open and nothing to stop, so the control disappears instead of
	// sitting there inert and pulling the eye across the whole board.
	const devPort = devServer?.ports[0] ?? null;
	const devConflict = (devServer?.conflictPorts.length ?? 0) > 0;
	// Running with nothing listening yet is a server still booting — the only
	// honest reading, and it needs no extra state from the backend.
	const devStarting = devServer?.running === true && devPort === null;
	const devTone = devServer?.running
		? devStarting
			? "border-warning/40 bg-warning/10 text-warning"
			: "border-success/30 bg-success/10 text-success"
		: "border-danger/40 bg-danger/10 text-danger";
	const devLabel = devServer?.running
		? devStarting ? t("task.devStarting") : `:${devPort}`
		: t("task.devPortBusy");
	const devDetail = devServer?.running
		? devStarting
			? t("ttip.task.devStarting")
			: t("ttip.task.devOpen", { ports: devServer.ports.map((p) => `:${p}`).join(" ") })
		: t("ttip.task.devConflict", { ports: devServer?.conflictPorts.map((p) => `:${p}`).join(" ") ?? "" });

	const devServerControl = isActive && devServer && (devServer.running || devConflict) ? (
		<span
			data-testid="task-card-dev-control"
			data-dev-state={devServer.running ? (devStarting ? "starting" : "running") : "conflict"}
			className={`flex h-6 flex-shrink-0 items-center overflow-hidden rounded-lg border ${devTone}`}
		>
			<Tooltip content={devLabel} detail={devDetail}>
				<button
					onClick={(e) => {
						e.stopPropagation();
						if (devPort !== null) window.open(`http://localhost:${devPort}`, "_blank");
					}}
					className="flex h-full items-center gap-1 px-1 font-mono text-dense transition-colors hover:bg-fg/5 disabled:cursor-default"
					aria-label={devPort !== null ? t("task.devOpenAria", { port: String(devPort) }) : devLabel}
					disabled={devPort === null}
				>
					{devStarting
						? <span className="h-1.5 w-1.5 flex-shrink-0 animate-spin rounded-[1px] border border-current border-t-transparent" />
						: <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full bg-current ${devServer.running ? "motion-safe:animate-pulse" : ""}`} />}
					{devLabel}
				</button>
			</Tooltip>
			{/* Danger INK on a hover tint, never a fill: stopping a dev server loses
			    nothing, so it must not read as an error from across the room. */}
			<Tooltip content={t("task.devStop")} detail={t("ttip.task.devStop")}>
				<button
					onClick={async (e) => {
						e.stopPropagation();
						try {
							await api.request.stopDevServer({ taskId: task.id, projectId: project.id });
						} catch (err) {
							toast.error(t("task.devStopFailed", { error: String(err) }));
						}
					}}
					className="flex h-full items-center border-l border-current/20 px-1 text-danger transition-colors hover:bg-danger/15 disabled:opacity-40"
					aria-label={t("task.devStop")}
					disabled={isDisabled || !devServer.running}
				>
					<span className="h-1.5 w-1.5 bg-current" />
				</button>
			</Tooltip>
		</span>
	) : null;

	const watchButton = (
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
				className={`flex flex-shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs transition-[opacity,color,background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96] hover:bg-fg/5 ${
					task.watched ? "text-accent font-medium" : "text-fg-3 hover:text-fg"
				}`}
				aria-label={task.watched ? t("task.unwatchTooltip") : t("task.watchTooltip")}
				disabled={isDisabled}
			>
				<span className="text-xs leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
					{task.watched ? "\u{F009A}" : "\u{F0F1C}"}
				</span>
				{!devServerControl && <span className="text-micro">{task.watched ? t("task.watching") : t("task.watch")}</span>}
			</button>
		</Tooltip>
	);

	return (
		<div
			ref={cardRef}
			data-task-id={task.id}
			data-hint-id={task.id}
			data-help-id="board.task-card"
			draggable={!isDisabled && !detailOpen && !isHibernated}
			onDragStart={handleDragStart}
			onContextMenu={handleContextMenu}
			onMouseEnter={handleCardMouseEnter}
			onMouseLeave={handleCardMouseLeave}
			className={`group relative flex flex-col overflow-hidden glass-card rounded-xl transition-[transform,box-shadow,background-color,border-color,opacity,filter] duration-150 ease-out border ${isDraft ? "border-dashed border-edge-active" : isActiveInSplit ? "border-accent ring-2 ring-accent/70 shadow-lg shadow-accent/20" : isCoordinator ? "border-dashed task-card-coordinator" : "border-transparent"} ${
				isActive || isCompleted || isCancelled
					? "cursor-pointer hover:-translate-y-0.5 hover:shadow-card-hover"
					: "cursor-grab active:cursor-grabbing hover:-translate-y-0.5 hover:shadow-card-hover"
			} ${isCompleting || isShuttingDown ? "grayscale opacity-40 pointer-events-none" : isPreparing ? "opacity-60" : isDisabled ? "opacity-50 pointer-events-none" : isHibernated || isDisconnected ? "grayscale opacity-60" : ""}`}
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
							<span className="text-micro font-semibold uppercase tracking-[0.08em] text-fg-3">
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
										className="rounded-lg border border-edge bg-elevated/90 px-2.5 py-1 text-micro text-fg-2 transition-colors hover:border-edge-active hover:text-fg"
									>
										{t("task.showDescription")}
									</button>
								</Tooltip>
							)}
							<Tooltip content={t("task.cancel")} detail={t("ttip.task.cancel")}>
								<button
									onClick={handleCancelPreparation}
									disabled={cancellingPreparation}
									className="rounded-lg border border-danger/50 bg-danger/10 px-2.5 py-1 text-micro text-danger transition-colors hover:border-danger hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-60"
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

			{/* LIFECYCLE — a 3px status strip on the top edge. The rail below no longer
			    reaches the top corner, and without this the card's column stops being
			    readable while scanning a column from the top. */}
			<div
				data-testid="task-card-status-strip"
				aria-hidden="true"
				className="h-[3px] w-full flex-shrink-0"
				style={{ background: railColor }}
			/>

			{/* IDENTITY — one line, full card width: which task is this and who runs it.
			    Full width is the point: the rail starts a row lower so the agent and
			    config string get the whole card instead of 182px next to a rail. */}
			<div
				data-testid="task-card-identity"
				className="flex min-w-0 items-center gap-1.5 border-b border-edge py-1.5 pl-1.5 pr-2.5"
			>
				<PriorityBadge priority={task.priority} onChange={handleSetPriority} />
				<span className="flex-shrink-0 font-mono text-micro font-semibold text-accent">
					#{task.seq}
					{variantFraction && (
						<Tooltip content={t("task.attempt", { n: String(task.variantIndex) })} detail={t("ttip.task.siblings")}>
							<span className="ml-0.5 font-normal text-accent/60">{variantFraction}</span>
						</Tooltip>
					)}
				</span>
				{agent && hasLauncherIcon && <AgentLauncherBadge agent={agent} />}
				{/* No launcher icon means the agent is unidentifiable from the glyph
				    alone, so its name has to be spelled out. */}
				{agent && !hasLauncherIcon && (
					<span className="flex-shrink-0 font-mono text-dense font-medium text-accent/80">{agent.name}</span>
				)}
				{configLabel && (
					// The config string is the one header item allowed to clip, so it is
					// also the one that needs the full value back on hover — but only
					// when it is actually clipped.
					<Tooltip content={configLabel} disabled={!configTruncated}>
						<span
							ref={configRef}
							data-testid="task-card-config"
							className="min-w-[3rem] flex-1 truncate font-mono text-dense font-medium text-accent/80"
						>
							{configLabel}
						</span>
					</Tooltip>
				)}
				{variantDots}
				{/* Only when there is no config to absorb the slack — otherwise a spacer
				    would starve the string this full-width header exists for. */}
				{!configLabel && <div className="flex-1" />}
				{task.scratch && (
					<Tooltip content={t("task.scratchSession")}>
						<span className="flex-shrink-0 text-fg-3" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{"\u{F018D}"}
						</span>
					</Tooltip>
				)}
				{task.automationId && (
					<Tooltip content={t("task.automationRun")}>
						<span className="flex-shrink-0 text-fg-3" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{"\u{F0150}"}
						</span>
					</Tooltip>
				)}
				<NativeBackendMark task={task} className="w-3.5 h-3.5 flex-shrink-0" testId="task-card-native-backend" />
				<ForeignCodeMark task={task} className="w-3.5 h-3.5 flex-shrink-0" testId="task-card-foreign-code" />
				{isCoordinator && (
					<Tooltip content={t("task.coordinatorBadge")} detail={t("task.coordinatorHint")}>
						<span
							data-testid="task-card-coordinator-badge"
							className="flex-shrink-0 rounded border border-dashed border-success/60 px-1.5 py-0.5 text-dense font-semibold uppercase tracking-[0.06em] text-success-strong"
						>
							{t("task.coordinatorBadge")}
						</span>
					</Tooltip>
				)}
				{isDraft && (
					<Tooltip content={t("task.draftBadge")} detail={t("task.draftHint")}>
						<span
							data-testid="task-card-draft-badge"
							className="flex-shrink-0 rounded border border-dashed border-edge-active px-1.5 py-0.5 text-dense font-semibold uppercase tracking-[0.06em] text-fg-3"
						>
							{t("task.draftBadge")}
						</span>
					</Tooltip>
				)}
				{isHibernated && (
					<Tooltip content={t("task.hibernatedBadge")} detail={t("task.hibernatedHint")}>
						<span
							data-testid="task-card-hibernated-badge"
							className="flex-shrink-0 rounded border border-dashed border-edge-active px-1.5 py-0.5 text-dense font-semibold uppercase tracking-[0.06em] text-fg-muted"
						>
							{t("task.hibernatedBadge")}
						</span>
					</Tooltip>
				)}
				{isDisconnected && (
					<Tooltip content={t("task.disconnectedBadge")} detail={t("task.disconnectedHint")}>
						<span
							data-testid="task-card-disconnected-badge"
							className="flex-shrink-0 rounded border border-dashed border-edge-active px-1.5 py-0.5 text-dense font-semibold uppercase tracking-[0.06em] text-fg-muted"
						>
							{t("task.disconnectedBadge")}
						</span>
					</Tooltip>
				)}
				{showDismissButton && (
					<Tooltip content={isCancelled ? t("task.delete") : t("task.cancel")} detail={isCancelled ? t("ttip.task.delete") : t("ttip.task.cancel")}>
						<button
							onClick={handleDismiss}
							className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-fg/5 text-fg-3 opacity-0 transition-[opacity,color,background-color,transform] duration-150 ease-out group-hover:opacity-100 hover:bg-danger/15 hover:text-danger motion-safe:active:scale-[0.96]"
							aria-label={isCancelled ? t("task.delete") : t("task.cancel")}
							disabled={isDisabled}
						>
							<svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					</Tooltip>
				)}
			</div>

			{/* Rail + body */}
			<div className="flex min-w-0 items-stretch">
				<TaskCardRail
					status={task.status}
					project={project}
					customColumn={activeCol ? { name: activeCol.name, color: activeCol.color } : null}
					color={railColor}
					bellCount={bellCount}
					disabled={isDisabled || isHibernated}
					canComplete={canQuickComplete}
					completing={quickCompleting}
					onOpenMenu={statusMenu.toggle}
					onComplete={handleQuickComplete}
					menuTriggerRef={statusMenu.triggerRef}
					touch={narrow}
				/>

				<div className="flex min-w-0 flex-1 flex-col px-3 pt-2.5">
					{/* CONTENT */}
					<div>
						<div
							className={`break-words text-sm font-medium leading-relaxed text-fg line-clamp-3 ${isTodo ? "cursor-pointer hover:text-fg-2" : ""}`}
							onClick={handleTitleClick}
							title={isTodo && hasLongDescription ? task.description : undefined}
						>
							{displayTitle}
						</div>
						{isTodo && task.preparationError && (
							<div
								role="alert"
								className="mt-2 flex items-start gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs text-danger"
							>
								<span
									className="mt-0.5 flex-shrink-0 leading-none"
									style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
								>
									{""}
								</span>
								<span className="line-clamp-2 break-words">
									{t("task.launchFailed", { error: task.preparationError })}
								</span>
							</div>
						)}

						{/* Label chips — on desktop the row is always rendered so the hover-only
						    "+" stays discoverable; on mobile there is no hover, so the invisible
						    button is dropped and an empty row claims no height. */}
						{(() => {
							const projectLabels = project.labels ?? [];
							const taskLabelIds = task.labelIds ?? [];
							const assignedLabels = taskLabelIds
								.map((id) => projectLabels.find((l) => l.id === id))
								.filter(Boolean) as typeof projectLabels;
							const showDescriptionAffordance = hasLongDescription && !isTodo;

							if (isMobile && assignedLabels.length === 0 && !showDescriptionAffordance) return null;

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
								<div className="mt-2 flex min-h-[1.125rem] items-start gap-2">
								<div ref={labelRowRef} className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
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
									{!isMobile && (
										<button
											ref={pickerAnchorRef}
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												setPickerOpen(true);
											}}
											className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-fg-3 opacity-0 transition-[opacity,color,background-color,transform] duration-150 ease-out group-hover:opacity-70 hover:!opacity-100 hover:bg-fg/8 hover:text-fg motion-safe:active:scale-[0.96]"
										>
											<svg className="w-2.5 h-2.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
												<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
											</svg>
											<span className="text-dense font-medium leading-none">Add label</span>
										</button>
									)}
									{pickerOpen && (pickerAnchorRef.current ?? labelRowRef.current) && (
										<LabelPicker
											project={project}
											dispatch={dispatch}
											taskId={task.id}
											onClose={() => setPickerOpen(false)}
											anchorEl={(pickerAnchorRef.current ?? labelRowRef.current)!}
											selectedIds={taskLabelIds}
											onToggle={toggleLabel}
										/>
									)}
								</div>
								{/* The description affordance rides the label row instead of
								    claiming a row of its own — it was ~20px on most cards. */}
								{showDescriptionAffordance && (
									<Tooltip content={t("task.showDescription")} detail={t("ttip.task.showDescription")}>
										<button
											onClick={handleShowDescription}
											aria-label={t("task.showDescription")}
											className="flex h-[1.125rem] w-[1.125rem] flex-shrink-0 items-center justify-center rounded text-fg-muted transition-colors hover:bg-fg/8 hover:text-accent"
										>
											<svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
												<path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h10" />
											</svg>
										</button>
									</Tooltip>
								)}
								</div>
							);
						})()}
					</div>

					{/* SIGNALS + ACTIONS — one segmented bar welded to the bottom edge.
					    mt-auto is what keeps it there when the rail is the taller column. */}
					<div className="-mx-3 mt-auto border-t border-edge bg-black/20">
						{signalGroups.length > 0 && (
							<div
								data-testid="task-card-signals"
								className="flex min-w-0 flex-wrap items-center gap-1.5 px-2.5 py-1.5"
							>
								{signalGroups.flatMap((group, i) => (i === 0 ? [group] : [<span key={`d${i}`}>{groupDivider}</span>, group]))}
							</div>
						)}
						{/* Actions get a reserved strip, so signals can never squeeze them
						    out. min-h-9 is what the 22px buttons plus their hover fill need. */}
						<div
							data-testid="task-card-action-row"
							className={`flex min-h-9 min-w-0 items-center gap-1 px-2 py-1.5 ${signalGroups.length > 0 ? "border-t border-edge" : ""}`}
						>
							{isActive && task.worktreePath && (
								<Tooltip content={t("openIn.menuTitle")} detail={t("ttip.openIn.menu")}>
									<button
										onClick={(e) => {
											e.stopPropagation();
											const rect = (e.target as HTMLElement).getBoundingClientRect();
											setCtxMenuPos({ top: rect.bottom + 4, left: rect.left });
											setCtxMenuOpen(true);
										}}
										className="flex flex-shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-accent transition-[color,background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96] hover:bg-accent/15"
										aria-label={t("openIn.menuTitle")}
									>
										<span className="text-xs leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0379}"}</span>
									</button>
								</Tooltip>
							)}
							{devServerControl}
							{watchButton}
							<div className="flex-1" />
							{isActive && (
								<Tooltip content={t("task.addVariant")} detail={t("ttip.task.addVariant")}>
									<button
										onClick={(e) => {
											e.stopPropagation();
											preview.close();
											onAddAttempts(task);
										}}
										className="flex flex-shrink-0 items-center rounded-lg px-2 py-1 text-xs font-medium text-accent transition-[color,background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96] hover:bg-accent/15"
										disabled={isDisabled}
									>
										{t("task.addVariant")}
									</button>
								</Tooltip>
							)}
							{/* A draft has nothing to run yet; the lifecycle machine would
							    refuse the launch anyway. */}
							{isTodo && !isDraft && (
								<Tooltip content={t("task.run")} detail={t("ttip.task.run")}>
									<button
										onClick={(e) => {
											e.stopPropagation();
											onLaunchVariants(task, "in-progress");
										}}
										className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-green-900/30 transition-[background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96] hover:bg-green-500"
										disabled={isDisabled}
									>
										{/* Play triangle centred on the viewBox — the usual 8→19 path
										    sits 1.5px right of centre and opens a gap before the label. */}
										<svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24">
											<path d="M6 4.5v15l12-7.5z" />
										</svg>
										{t("task.run")}
									</button>
								</Tooltip>
							)}
						</div>
					</div>
				</div>
			</div>

			{/* Task detail modal — portal to body so it's not clipped by the card */}
			{detailOpen && createPortal(
				<TaskDetailModal
					task={task}
					project={project}
					dispatch={dispatch}
					onClose={() => setDetailOpen(false)}
					onOpenTask={openTaskFromDialog}
					onLaunchVariants={onLaunchVariants}
				/>,
				document.body
			)}


			{/* Status dropdown menu — bottom sheet on narrow (≥44px touch rows),
			    anchored portal + smart viewport clamping on desktop. */}
			<StatusMenuPortal menu={statusMenu} narrow={narrow} title={t("task.moveTo")} sheetTestId="task-status-sheet">
				<PipelineDropdown
					currentStatus={task.status}
					onMove={handleMove}
					onMoveToCustomColumn={handleMoveToCustomColumn}
					onDelete={isCancelled ? handleDelete : undefined}
					customColumns={project.customColumns}
					currentCustomColumnId={task.customColumnId}
					project={project}
					size={narrow ? "touch" : undefined}
					hideHeader={narrow}
				/>
				{hasLiveAgent && (
					<>
						<div className="mx-3 my-1 border-t border-edge-active" />
						<PipelineMenuAction
							size={narrow ? "touch" : undefined}
							icon={<ClockIcon className={narrow ? "w-5 h-5" : "w-4 h-4"} />}
							label={t("task.sendMessageLater")}
							onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setScheduleMsgOpen(true); }}
						/>
					</>
				)}
			</StatusMenuPortal>

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
					<div className="px-3 py-1.5 text-dense text-fg-3 uppercase tracking-wider font-semibold">
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
