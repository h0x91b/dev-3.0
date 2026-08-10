import { useState, useRef, useCallback, useEffect, useLayoutEffect, type Dispatch, type MouseEvent as ReactMouseEvent } from "react";
import { toast } from "../toast";
import { confirm } from "../confirm";
import { createPortal } from "react-dom";
import type { Task, Project, TaskStatus, PortInfo, ResourceUsage, Label, TaskPRBadgeInfo } from "../../shared/types";
import LabelChip from "./LabelChip";
import PriorityBadge from "./PriorityBadge";
import OpenInMenu from "./OpenInMenu";
import { formatDate } from "./NoteItem";
import { ACTIVE_STATUSES, getAllowedTransitions, getTaskTitle, resolveTaskCompareBaseBranch } from "../../shared/types";
import InlineRename from "./InlineRename";
import { getTaskOpenMode, taskClosedHomeRoute, type AppAction, type Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { formatBytes } from "../utils/formatBytes";
import { getStatusLabel } from "../utils/statusLabel";
import { trackEvent, agentNameFromId } from "../analytics";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import { ImageAttachmentsStrip } from "./ImageAttachmentsStrip";
import PipelineRing, { CompleteCheckIcon } from "./PipelineRing";
import PipelineDropdown from "./PipelineDropdown";
import SpawnAgentModal from "./SpawnAgentModal";
import ScheduleMessageModal from "./ScheduleMessageModal";
import ScheduledMessagesChip from "./ScheduledMessagesChip";
import BugHuntersLightbox from "./BugHuntersLightbox";
import TaskDevServer from "./task-info-panel/TaskDevServer";
import TaskExposedPorts from "./task-info-panel/TaskExposedPorts";
import TaskSharedImages from "./task-info-panel/TaskSharedImages";
import TaskArtifacts from "./task-info-panel/TaskArtifacts";
import TaskScripts from "./task-info-panel/TaskScripts";
import TaskGitActions from "./task-info-panel/TaskGitActions";
import type { TaskBranchStatusMeta } from "./task-info-panel/TaskGitActions";
import TaskGitActionsSheet from "./task-info-panel/TaskGitActionsSheet";
import { useTaskBranchStatus } from "./task-info-panel/useTaskBranchStatus";
import TaskPrStatusPopover from "./TaskPrStatusPopover";
import { IncludeTestsIcon, ShowDiffIcon } from "./task-info-panel/GitIcons";
import {
	WatchingIcon,
	WatchIcon,
	CompletionOwnerIcon,
	FindBugsIcon,
	AddAgentIcon,
	WorktreeSettingsIcon,
	FullscreenEnterIcon,
	FullscreenExitIcon,
	PanelChevronIcon,
	PanelLeftIcon,
	ImagesIcon,
	ArtifactsIcon,
} from "./TaskIcons";
import TaskNotes from "./task-info-panel/TaskNotes";
import TaskOpenIn from "./task-info-panel/TaskOpenIn";
import TaskPaneControls from "./task-info-panel/TaskPaneControls";
import { useTaskAllocatedPorts } from "./task-info-panel/useTaskAllocatedPorts";
import type { TaskInlineDiffRequest } from "./task-inline-diff";
import { isTestFile } from "../../shared/test-files";
import { useIncludeTestsInDiff } from "../utils/includeTestsInDiff";
import { useCompact } from "../utils/useCompact";
import { useContainerWidth } from "../hooks/useContainerWidth";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import BottomSheet from "./BottomSheet";
import HelpSpot from "./HelpSpot";
import Tooltip from "./Tooltip";
import ForeignCodeMark from "./ForeignCodeMark";
import VariantSwitcher from "./VariantSwitcher";
import { isMac } from "../utils/platform";
import { terminalFullscreenShortcutLabel } from "../utils/terminalFullscreen";

interface TaskInfoPanelProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	taskPorts?: Map<string, PortInfo[]>;
	taskResourceUsage?: Map<string, ResourceUsage>;
	tasks?: Task[];
	isFullPage?: boolean;
	isTerminalFullscreen?: boolean;
	onToggleTerminalFullscreen?: () => void;
	onOpenInlineDiff?: (request: TaskInlineDiffRequest) => void;
}

const COLLAPSED_HEIGHT_REM = 4.25;
const DEFAULT_HEIGHT = 200;
const MIN_HEIGHT = 80;
const MAX_RATIO = 0.33;

// Context bar budget: keep the label strip from pushing status/diff off the bar.
// Extra labels collapse into a "+k" chip; the full list still shows in the
// expanded metadata grid below.
const MAX_INLINE_LABELS = 4;

// The 2×2 bar grid is sized by the panel's own width, not the viewport: in split
// view the board eats most of a 1100px window, so the bars go tight while
// `useCompact` (1600) still reports "roomy". Below this the label strip folds to
// its "+k" chip and the branch name clamps harder, keeping both rows on one line.
const TIGHT_PANEL_WIDTH = 1280;

// Below this the Context bar can only keep its identity and primary actions: the
// label strip and the include-tests toggle drop out (both still readable in the
// expanded metadata grid / diff viewer) rather than eat the status label.
const VERY_TIGHT_PANEL_WIDTH = 1000;

// Uniform full-width row used by the narrow-viewport (mobile) actions sheet.
// The mobile sheet is a curated read/trigger surface — a clean list of rows, not
// the dense desktop toolbar (UX bible §12.3/§12.6). The touch-target floor comes
// from the `.touch-actions` group wrapper around the list.
const SHEET_ROW_CLASS =
	"flex w-full items-center gap-3 rounded-xl border border-edge bg-raised px-4 py-2.5 text-left text-fg transition-colors hover:bg-raised-hover active:bg-elevated";

/** Trailing "opens something" affordance for a mobile action row. */
function ChevronRightIcon() {
	return (
		<svg className="h-4 w-4 shrink-0 text-fg-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
		</svg>
	);
}

const LS_COLLAPSED = "dev3-panel-collapsed";
const LS_HEIGHT = "dev3-panel-height";

function readBool(key: string, fallback: boolean): boolean {
	try {
		const value = localStorage.getItem(key);
		if (value === "true") return true;
		if (value === "false") return false;
	} catch {}
	return fallback;
}

function readNumber(key: string, fallback: number): number {
	try {
		const value = localStorage.getItem(key);
		if (value !== null) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
	} catch {}
	return fallback;
}

function TaskInfoPanel({
	task,
	project,
	dispatch,
	navigate,
	taskPorts,
	taskResourceUsage,
	tasks = [],
	isFullPage,
	isTerminalFullscreen,
	onToggleTerminalFullscreen,
	onOpenInlineDiff,
}: TaskInfoPanelProps) {
	const t = useT();
	const compact = useCompact();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [actionsSheetOpen, setActionsSheetOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(() => readBool(LS_COLLAPSED, true));
	const [panelHeight, setPanelHeight] = useState(() => readNumber(LS_HEIGHT, DEFAULT_HEIGHT));
	const [copiedPath, setCopiedPath] = useState(false);
	const [statusMenuOpen, setStatusMenuOpen] = useState(false);
	const [statusMenuPos, setStatusMenuPos] = useState({ top: 0, left: 0 });
	const [statusMenuVisible, setStatusMenuVisible] = useState(false);
	const [movingStatus, setMovingStatus] = useState(false);
	const [quickCompleting, setQuickCompleting] = useState(false);
	const [spawnModalOpen, setSpawnModalOpen] = useState(false);
	const [scheduleMsgOpen, setScheduleMsgOpen] = useState(false);
	const [hibernating, setHibernating] = useState(false);
	const [bugHuntersOpen, setBugHuntersOpen] = useState(false);
	const [metadataBranchState, setMetadataBranchState] = useState<TaskBranchStatusMeta | null>(null);
	const [includeTests, setIncludeTests] = useIncludeTestsInDiff();
	const [diffFilesHover, setDiffFilesHover] = useState(false);
	const [diffFilesPos, setDiffFilesPos] = useState({ top: 0, left: 0 });
	const [fileOpenInMenu, setFileOpenInMenu] = useState<{ path: string; pos: { top: number; left: number } } | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const panelWidth = useContainerWidth(panelRef);
	const tight = panelWidth > 0 && panelWidth < TIGHT_PANEL_WIDTH;
	const veryTight = panelWidth > 0 && panelWidth < VERY_TIGHT_PANEL_WIDTH;
	const dragging = useRef(false);
	const statusTriggerRef = useRef<HTMLButtonElement>(null);
	const statusMenuRef = useRef<HTMLDivElement>(null);
	const diffFilesTriggerRef = useRef<HTMLButtonElement>(null);
	const diffFilesHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Terminal moves await a git preflight. If the user switches tasks while it
	// runs, the old task's callback must not overwrite that newer selection.
	const latestTaskIdRef = useRef(task.id);
	const mountedRef = useRef(true);
	latestTaskIdRef.current = task.id;
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const terminalFullscreenActive = onToggleTerminalFullscreen
		? Boolean(isTerminalFullscreen)
		: Boolean(isFullPage);
	const terminalFullscreenLabel = terminalFullscreenActive
		? t("infoPanel.exitFullScreen")
		: t("infoPanel.fullScreen");
	const toggleTerminalFullscreen = () => {
		if (onToggleTerminalFullscreen) {
			onToggleTerminalFullscreen();
			return;
		}
		navigate(
			isFullPage
				? { screen: "project", projectId: project.id, activeTaskId: task.id }
				: { screen: "task", projectId: project.id, taskId: task.id },
		);
	};
	const terminalFullscreenTooltip = t("ttip.infoPanel.fullScreen", {
		shortcuts: terminalFullscreenShortcutLabel(isMac()),
	});
	// Counterpart of the sidebar-header panel toggle: on the fullscreen task
	// screen (sidebar hidden) this brings the Active Tasks panel back.
	const showPanelButton = isFullPage ? (
		<Tooltip content={t("infoPanel.showPanel")} detail={t("ttip.infoPanel.showPanel")}>
			<button
				onClick={() => navigate({ screen: "project", projectId: project.id, activeTaskId: task.id })}
				className="task-anim flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
				aria-label={t("infoPanel.showPanel")}
				data-testid="show-active-tasks"
			>
				<PanelLeftIcon className="w-3.5 h-3.5" />
			</button>
		</Tooltip>
	) : null;
	const allocatedPorts = useTaskAllocatedPorts(task);
	const isTaskActive = ACTIVE_STATUSES.includes(task.status);
	// Narrow viewport renders no TaskGitActions (the desktop git bar), which is
	// what feeds `metadataBranchState` on desktop. Own one branch-status
	// instance here instead: it drives the summary-bar diff badge, the merge
	// completion prompt, and is handed to TaskGitActionsSheet so the sheet
	// opens with status already loaded. Inert (`enabled: false`) on desktop.
	const narrowGit = useTaskBranchStatus({
		task,
		project,
		dispatch,
		navigate,
		isTaskActive,
		enabled: narrow && project.kind !== "virtual",
	});
	const variantMembers = task.groupId
		? tasks.filter((candidate) => candidate.groupId === task.groupId)
		: [];
	const variantSwitcher = (
		<VariantSwitcher
			variants={variantMembers}
			currentTaskId={task.id}
			projectId={project.id}
			isFullPage={isFullPage}
			navigate={navigate}
		/>
	);

	useEffect(() => {
		setMetadataBranchState(null);
	}, [task.id]);

	// Crossing the narrow breakpoint must not strand an open sheet/menu — the
	// status menu renders as a sheet on narrow and an anchored popover on desktop.
	useEffect(() => {
		if (!narrow) setActionsSheetOpen(false);
		setStatusMenuOpen(false);
	}, [narrow]);

	useEffect(() => () => {
		if (diffFilesHoverTimer.current) {
			clearTimeout(diffFilesHoverTimer.current);
		}
	}, []);

	useEffect(() => {
		if (!statusMenuOpen) {
			return;
		}

		function handleClick(event: MouseEvent) {
			if (
				statusMenuRef.current &&
				!statusMenuRef.current.contains(event.target as Node) &&
				statusTriggerRef.current &&
				!statusTriggerRef.current.contains(event.target as Node)
			) {
				setStatusMenuOpen(false);
			}
		}

		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [statusMenuOpen]);

	useLayoutEffect(() => {
		if (!statusMenuOpen || !statusMenuRef.current || !statusTriggerRef.current) {
			return;
		}

		const menu = statusMenuRef.current.getBoundingClientRect();
		const trigger = statusTriggerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = trigger.bottom + 6;
		let left = trigger.left;

		if (top + menu.height > vh - pad) {
			top = trigger.top - menu.height - 6;
		}
		if (left + menu.width > vw - pad) {
			left = vw - menu.width - pad;
		}
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setStatusMenuPos({ top, left });
		setStatusMenuVisible(true);
	}, [statusMenuOpen]);

	useEffect(() => {
		try {
			localStorage.setItem(LS_COLLAPSED, String(collapsed));
		} catch {}
	}, [collapsed]);

	useEffect(() => {
		try {
			localStorage.setItem(LS_HEIGHT, String(panelHeight));
		} catch {}
	}, [panelHeight]);

	function toggleStatusMenu(event: ReactMouseEvent<HTMLButtonElement>) {
		event.stopPropagation();
		if (!statusMenuOpen && statusTriggerRef.current) {
			const rect = statusTriggerRef.current.getBoundingClientRect();
			setStatusMenuPos({ top: rect.bottom + 6, left: rect.left });
			setStatusMenuVisible(false);
		}
		setStatusMenuOpen((open) => !open);
	}

	// Acknowledge the ✓ on the same tick — its dialog still has a git check
	// streaming in, so silence here reads as a dead button.
	async function handleQuickComplete() {
		setQuickCompleting(true);
		try {
			await handleStatusMove("completed", { alwaysConfirm: true });
		} finally {
			setQuickCompleting(false);
		}
	}

	async function handleStatusMove(newStatus: TaskStatus, opts?: { alwaysConfirm?: boolean }) {
		setStatusMenuOpen(false);
		const terminal = newStatus === "completed" || newStatus === "cancelled";
		const openTaskFromDialog = () => {
			const openMode = getTaskOpenMode();
			navigate(openMode === "fullscreen"
				? { screen: "task", projectId: project.id, taskId: task.id }
				: { screen: "project", projectId: project.id, activeTaskId: task.id });
		};
		// Terminal moves leave the task screen immediately (worktree teardown runs
		// in the background); other moves keep the panel and show a spinner.
		const leaveScreen = terminal || !ACTIVE_STATUSES.includes(newStatus);
		const navigateHomeIfTaskStillSelected = () => {
			if (!mountedRef.current || latestTaskIdRef.current !== task.id) return;
			navigate(taskClosedHomeRoute(project.id, getTaskOpenMode()));
		};
		await moveTaskToStatus({
			task,
			project,
			newStatus,
			dispatch,
			t,
			onOpenTask: openTaskFromDialog,
			alwaysConfirm: opts?.alwaysConfirm,
			// Terminal moves leave the screen and keep the optimistic completion on
			// failure (matches the fire-and-forget behaviour); other moves stay and
			// revert + toast if the RPC fails.
			revertOnFailure: !terminal,
			onMovingChange: terminal ? undefined : (moving) => setMovingStatus(moving),
			// Terminal moves leave the screen immediately (fire-and-forget); other
			// screen-leaving moves wait for the server to confirm so a failed +
			// reverted move doesn't kick the user off the task screen.
			// Land on the user's home surface: fullscreen open-mode → the board,
			// split open-mode → the split task view with nothing selected.
			afterOptimistic: terminal && leaveScreen
				? navigateHomeIfTaskStillSelected
				: undefined,
			onSuccess: !terminal && leaveScreen
				? navigateHomeIfTaskStillSelected
				: undefined,
		});
	}

	async function handleMoveToCustomColumn(customColumnId: string) {
		setMovingStatus(true);
		setStatusMenuOpen(false);
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
		setMovingStatus(false);
	}

	async function handleToggleWatch(event: ReactMouseEvent<HTMLButtonElement>) {
		event.stopPropagation();
		try {
			const updated = await api.request.toggleTaskWatch({
				taskId: task.id,
				projectId: project.id,
				watched: !task.watched,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch {
			// Secondary action. Failing quietly is fine.
		}
	}

	async function handleToggleManualCompletion(event: ReactMouseEvent<HTMLButtonElement>) {
		event.stopPropagation();
		try {
			const updated = await api.request.setTaskManualCompletion({
				taskId: task.id,
				projectId: project.id,
				manualCompletion: task.manualCompletion !== true,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			toast.error(t("task.manualCompletionChangeFailed", { error: String(err) }), { taskId: task.id });
		}
	}

	async function handleSetPriority(priority: Task["priority"]) {
		if (!priority) return;
		try {
			const changed = await api.request.setTaskPriority({
				taskId: task.id,
				projectId: project.id,
				priority,
			});
			// Priority is group-wide, so the RPC returns every changed variant.
			for (const changedTask of changed) {
				dispatch({ type: "updateTask", task: changedTask });
			}
		} catch (err) {
			toast.error(t("priority.failedSet", { error: String(err) }), { taskId: task.id });
		}
	}

	const toggleCollapsed = useCallback(() => {
		setCollapsed((current) => !current);
	}, []);

	const onDragStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
		event.preventDefault();
		if (collapsed) {
			return;
		}

		dragging.current = true;
		const startY = event.clientY;
		const startHeight = panelRef.current?.offsetHeight ?? panelHeight;
		const panelElement = panelRef.current;

		if (panelElement) {
			panelElement.style.transition = "none";
		}

		function onMove(moveEvent: MouseEvent) {
			if (!dragging.current) {
				return;
			}
			const maxHeight = window.innerHeight * MAX_RATIO;
			const nextHeight = Math.min(maxHeight, Math.max(MIN_HEIGHT, startHeight + (moveEvent.clientY - startY)));
			if (panelElement) {
				panelElement.style.height = `${nextHeight}px`;
			}
		}

		function onUp(upEvent: MouseEvent) {
			dragging.current = false;
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);

			if (panelElement) {
				panelElement.style.transition = "";
				const maxHeight = window.innerHeight * MAX_RATIO;
				const finalHeight = Math.min(maxHeight, Math.max(MIN_HEIGHT, startHeight + (upEvent.clientY - startY)));
				setPanelHeight(finalHeight);
			}
		}

		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	}, [collapsed, panelHeight]);

	const activeCustomColumn = task.customColumnId
		? (project.customColumns ?? []).find((column) => column.id === task.customColumnId)
		: null;
	const assignedLabels = (task.labelIds ?? [])
		.map((id) => (project.labels ?? []).find((item) => item.id === id))
		.filter(Boolean) as Label[];

	function showDiffFilesPopover() {
		// Hover pattern — dead on touch, and a tap fires mouseenter with no
		// mouseleave, so on narrow the popover would stick over the freshly
		// opened diff (Bible §12.3: hover popovers are disabled on touch).
		if (narrow) {
			return;
		}
		if (diffFilesHoverTimer.current) {
			clearTimeout(diffFilesHoverTimer.current);
		}
		if (diffFilesTriggerRef.current) {
			const rect = diffFilesTriggerRef.current.getBoundingClientRect();
			setDiffFilesPos({ top: rect.bottom + 4, left: rect.left });
		}
		setDiffFilesHover(true);
	}

	function hideDiffFilesPopover() {
		diffFilesHoverTimer.current = setTimeout(() => {
			setDiffFilesHover(false);
		}, 150);
	}

	function cancelHideDiffFiles() {
		if (diffFilesHoverTimer.current) {
			clearTimeout(diffFilesHoverTimer.current);
		}
	}

	function handleFileOpenIn(event: ReactMouseEvent<HTMLButtonElement>, relativePath: string) {
		event.stopPropagation();
		if (!task.worktreePath) {
			return;
		}
		setFileOpenInMenu({
			path: `${task.worktreePath}/${relativePath}`,
			pos: { top: event.clientY, left: event.clientX },
		});
	}

	function openBranchDiff(focusFile?: string) {
		if (!onOpenInlineDiff) {
			return;
		}
		onOpenInlineDiff({
			mode: "branch",
			compareRef: branchMeta?.compareRef,
			compareLabel: branchMeta?.compareLabel ?? `origin/${resolveTaskCompareBaseBranch(task, project)}`,
			focusFile,
		});
	}

	const openUnresolvedInDiff = onOpenInlineDiff
		? () => onOpenInlineDiff({
			mode: "branch",
			compareRef: branchMeta?.compareRef,
			compareLabel: branchMeta?.compareLabel ?? `origin/${resolveTaskCompareBaseBranch(task, project)}`,
			focusFirstUnresolvedThread: true,
		})
		: undefined;

	function handleFileDiff(event: ReactMouseEvent<HTMLButtonElement>, relativePath: string) {
		event.stopPropagation();
		setDiffFilesHover(false);
		setFileOpenInMenu(null);
		openBranchDiff(relativePath);
	}

	// On narrow the panel-level hook is the status source; on desktop it is the
	// TaskGitActions render callback (`metadataBranchState`).
	const branchMeta: TaskBranchStatusMeta | null = narrow
		? {
			branchStatus: narrowGit.branchStatus,
			compareRef: narrowGit.compareRef || undefined,
			compareLabel: narrowGit.displayRef,
		}
		: metadataBranchState;
	const metadataBranchStatus = branchMeta?.branchStatus ?? null;
	const metadataPrInfo: TaskPRBadgeInfo | null = branchMeta?.prStatus
		?? (metadataBranchStatus?.prNumber != null
			? {
				number: metadataBranchStatus.prNumber,
				url: metadataBranchStatus.prUrl ?? "",
			}
			: task.prNumber != null
				? {
					number: task.prNumber,
					url: task.prUrl ?? "",
				}
				: null);
	const allDiffFileStats = metadataBranchStatus?.diffFileStats ?? [];
	const visibleDiffFileStats = includeTests
		? allDiffFileStats
		: allDiffFileStats.filter((entry) => !isTestFile(entry.path));
	const excludedTestCount = allDiffFileStats.length - visibleDiffFileStats.length;
	const visibleDiffFiles = includeTests
		? (metadataBranchStatus?.diffFiles ?? 0)
		: visibleDiffFileStats.length;
	const visibleDiffInsertions = includeTests
		? (metadataBranchStatus?.diffInsertions ?? 0)
		: visibleDiffFileStats.reduce((sum, e) => sum + e.insertions, 0);
	const visibleDiffDeletions = includeTests
		? (metadataBranchStatus?.diffDeletions ?? 0)
		: visibleDiffFileStats.reduce((sum, e) => sum + e.deletions, 0);
	const diffBadgeTitle = !includeTests && excludedTestCount > 0
		? t.plural("infoPanel.diffTestsHidden", excludedTestCount)
		: t("infoPanel.showDiff");
	const diffSummaryBadge = project.kind !== "virtual" && metadataBranchStatus && metadataBranchStatus.diffFiles > 0 ? (
		<button
			type="button"
			ref={diffFilesTriggerRef}
			className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-elevated border border-edge text-micro font-mono text-fg-2 flex-shrink-0 cursor-pointer transition-colors hover:bg-elevated-hover"
			onClick={() => openBranchDiff()}
			onMouseEnter={showDiffFilesPopover}
			onMouseLeave={hideDiffFilesPopover}
			title={diffBadgeTitle}
			data-testid="diff-summary-badge"
		>
			<span className="text-fg-muted text-sm-plus leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF0CB"}</span>
			<span>{visibleDiffFiles} {visibleDiffFiles === 1 ? "file" : "files"}</span>
			<span className="text-success">+{visibleDiffInsertions}</span>
			<span className="text-danger">−{visibleDiffDeletions}</span>
			{!includeTests && excludedTestCount > 0 && (
				<span
					className="text-fg-muted text-sm-plus leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					title={t.plural("infoPanel.diffTestsHidden", excludedTestCount)}
				>
					{"\u{F0912}"}
				</span>
			)}
		</button>
	) : null;
	const diffIncludeTestsToggle = project.kind !== "virtual" && !veryTight && metadataBranchStatus && metadataBranchStatus.diffFiles > 0 ? (
		<Tooltip content={t("infoPanel.diffIncludeTestsTooltip")} detail={t("ttip.infoPanel.includeTests")}>
		<button
			type="button"
			data-testid="diff-include-tests-toggle"
			onClick={() => setIncludeTests(!includeTests)}
			className={`git-anim inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-micro font-mono flex-shrink-0 transition-colors ${
				includeTests
					? "bg-elevated border-edge text-fg-2 hover:bg-elevated-hover"
					: "bg-accent/10 border-accent/30 text-accent hover:bg-accent/20"
			}`}
			aria-label={t("infoPanel.diffIncludeTestsAria")}
			aria-pressed={includeTests}
		>
			{!compact && <span>{includeTests ? t("infoPanel.diffIncludeTests") : t("infoPanel.diffExcludeTests")}</span>}
			<IncludeTestsIcon className="w-[0.95rem] h-[0.95rem]" />
		</button>
		</Tooltip>
	) : null;
	const diffFilesPopover = diffFilesHover && metadataBranchStatus && visibleDiffFileStats.length > 0 && createPortal(
		<div
			className="fixed bg-overlay border border-edge-active rounded-lg shadow-2xl shadow-black/40 py-2 pl-3 pr-1.5 max-w-[25rem] max-h-[20rem] overflow-auto"
			style={{ top: diffFilesPos.top, left: diffFilesPos.left, zIndex: 9999 }}
			onMouseEnter={cancelHideDiffFiles}
			onMouseLeave={hideDiffFilesPopover}
		>
			<div className="text-dense text-fg-muted font-semibold uppercase tracking-wider mb-1.5">
				{t("infoPanel.changedFiles")}
			</div>
			{visibleDiffFileStats.map(({ path: fileName, insertions, deletions }) => (
				<div key={fileName} className="group/file flex items-center gap-1.5 py-0.5 leading-snug">
					<span className="text-micro text-fg-2 font-mono truncate flex-1">{fileName}</span>
					{(insertions > 0 || deletions > 0) && (
						<span className="text-dense font-mono flex-shrink-0">
							{insertions > 0 && <span className="text-success">+{insertions}</span>}
							{insertions > 0 && deletions > 0 && " "}
							{deletions > 0 && <span className="text-danger">−{deletions}</span>}
						</span>
					)}
					<div className="flex items-center gap-1.5 flex-shrink-0">
						<Tooltip content={t("infoPanel.showDiff")} detail={t("ttip.infoPanel.showDiff")}>
							<button
								onClick={(event) => handleFileDiff(event, fileName)}
								aria-label={t("infoPanel.showDiff")}
								className="text-sm text-accent hover:text-accent-emphasis w-6 h-6 flex items-center justify-center rounded bg-accent/10 hover:bg-accent/20 transition-colors"
							>
								<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF4D2"}</span>
							</button>
						</Tooltip>
						<Tooltip content={t("openIn.menuTitle")} detail={t("ttip.openIn.menu")}>
							<button
								onClick={(event) => handleFileOpenIn(event, fileName)}
								aria-label={t("openIn.menuTitle")}
								className="text-sm text-fg-3 hover:text-fg-2 w-6 h-6 flex items-center justify-center rounded bg-raised hover:bg-elevated-hover transition-colors"
							>
								<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0379}"}</span>
							</button>
						</Tooltip>
					</div>
				</div>
			))}
		</div>,
		document.body,
	);
	const fileOpenInMenuPortal = fileOpenInMenu ? (
		<OpenInMenu
			position={fileOpenInMenu.pos}
			path={fileOpenInMenu.path}
			taskId={task.id}
			onClose={() => setFileOpenInMenu(null)}
		/>
	) : null;

	// On a tight panel every inline chip is width the bar does not have — fold the
	// whole strip into the "+k" chip instead of letting it overrun the next bar.
	const maxInlineLabels = tight ? 0 : MAX_INLINE_LABELS;
	const inlineLabels = assignedLabels.slice(0, maxInlineLabels);
	const overflowLabels = assignedLabels.slice(maxInlineLabels);
	const labelStrip = assignedLabels.length > 0 && !veryTight ? (
		<div className="flex items-center gap-1 min-w-0 flex-shrink overflow-hidden">
			{inlineLabels.map((label) => <LabelChip key={label.id} label={label} size="xs" />)}
			{overflowLabels.length > 0 && (
				<span
					className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-elevated text-fg-3 text-dense font-medium flex-shrink-0"
					title={overflowLabels.map((label) => label.name).join(", ")}
					data-testid="label-strip-overflow"
				>
					{/* With no chip beside it a bare "+2" is meaningless — the tag glyph
					    says what is being counted. */}
					{inlineLabels.length === 0 && (
						<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F04F9}"}</span>
					)}
					{inlineLabels.length === 0 ? overflowLabels.length : `+${overflowLabels.length}`}
				</span>
			)}
		</div>
	) : null;

	const watchToggleButton = (
		<Tooltip content={task.watched ? t("task.unwatchTooltip") : t("task.watchTooltip")} detail={t("ttip.task.watch")}>
		<button
			onClick={handleToggleWatch}
			className={`task-anim flex items-center gap-1.5 px-2 py-1 rounded-lg transition-colors flex-shrink-0 ${
				task.watched
					? "text-accent bg-accent/10 border border-accent/25"
					: "text-fg-3 hover:text-fg hover:bg-elevated"
			}`}
			aria-label={task.watched ? t("task.unwatchTooltip") : t("task.watchTooltip")}
		>
			{task.watched
				? <WatchingIcon className="w-[0.95rem] h-[0.95rem]" />
				: <WatchIcon className="w-[0.95rem] h-[0.95rem]" />}
			{!compact && (
				<span className="text-micro font-medium">
					{task.watched ? t("task.watching") : t("task.watch")}
				</span>
			)}
		</button>
		</Tooltip>
	);

	const manualCompletionToggleButton = (
		<Tooltip
			content={task.manualCompletion ? t("task.manualCompletionEnabledTooltip") : t("task.manualCompletionTooltip")}
			detail={t("ttip.task.manualCompletion")}
		>
			<button
				onClick={handleToggleManualCompletion}
				aria-label={task.manualCompletion ? t("task.manualCompletionEnabledTooltip") : t("task.manualCompletionTooltip")}
				aria-pressed={task.manualCompletion === true}
				className={`task-anim flex items-center gap-1.5 px-2 py-1 rounded-lg transition-colors flex-shrink-0 ${
					task.manualCompletion
						? "text-accent bg-accent/10 border border-accent/25"
						: "text-fg-3 hover:text-fg hover:bg-elevated"
				}`}
			>
				<CompletionOwnerIcon className="h-[0.95rem] w-[0.95rem]" active={task.manualCompletion} />
				{/* Always the short label: the full sentence ("I'll complete it myself")
				    costs ~180px of bar — more in ru/es — for a state the accent icon
				    already carries. The sentence stays in the tooltip and in the mobile
				    sheet row. A tight bar drops even the short label. */}
				{!tight && (
					<span className="text-micro font-medium">{t("task.manualCompletionShort")}</span>
				)}
			</button>
		</Tooltip>
	);

	const priorityBadge = <PriorityBadge priority={task.priority} onChange={handleSetPriority} className="shrink-0" />;

	// On narrow the chip is a primary touch target — bump it to ≥44px (§12.6).
	// On narrow this is the one shrinkable region of a no-wrap bar: a long
	// custom-column name truncates here instead of pushing the kebab off screen.
	const statusDropdownButton = (
		<div className={`flex items-center rounded-lg hover:bg-elevated transition-colors ${tight || narrow ? "min-w-0 shrink" : "flex-shrink-0"}`}>
			<button
				ref={statusTriggerRef}
				onClick={toggleStatusMenu}
				disabled={movingStatus}
				className={`flex min-w-0 items-center gap-2 rounded-lg ${narrow ? "px-3 min-h-[2.75rem]" : "px-2.5 py-1"}`}
			>
				{activeCustomColumn ? (
					<div
						className="w-2.5 h-2.5 rounded-full flex-shrink-0"
						style={{ background: activeCustomColumn.color, boxShadow: `0 0 6px ${activeCustomColumn.color}60` }}
					/>
				) : (
					<PipelineRing status={task.status} size={narrow ? "touch" : "default"} />
				)}
				{/* Last thing the narrow bar sheds (bible §12.6): under 300px the ring
				    plus the chevron still read as "status, tap to change", and this is
				    the only survivor still worth its width. `sr-only` keeps it announced. */}
				<span className={`font-medium text-fg-2 truncate ${narrow ? "text-sm [@container(max-width:299px)]:sr-only" : "text-micro"}`}>
					{activeCustomColumn ? activeCustomColumn.name : getStatusLabel(task.status, t, project)}
				</span>
				<svg className={`flex-shrink-0 text-fg-3 ${narrow ? "w-4 h-4" : "w-3 h-3"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
				</svg>
			</button>
			{!narrow && !movingStatus && getAllowedTransitions(task.status).includes("completed") && (
				<Tooltip content={t("pipeline.completeTooltip")} disabled={quickCompleting}>
					<button
						data-testid="task-info-quick-complete"
						onClick={handleQuickComplete}
						disabled={quickCompleting}
						aria-label={t("pipeline.completeTooltip")}
						className={`mr-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-success transition-[color,background-color,opacity] ${
							quickCompleting ? "bg-success/25 opacity-100" : "opacity-60 hover:bg-success/20 hover:opacity-100"
						}`}
					>
						{quickCompleting ? (
							<span className="h-3 w-3 animate-spin rounded-full border-2 border-success/30 border-t-success" />
						) : (
							<CompleteCheckIcon className="w-3 h-3" />
						)}
					</button>
				</Tooltip>
			)}
		</div>
	);

	const statusDropdownPortal = statusMenuOpen && createPortal(
		<div
			ref={statusMenuRef}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[11.25rem]"
			style={{ top: statusMenuPos.top, left: statusMenuPos.left, visibility: statusMenuVisible ? "visible" : "hidden" }}
			onClick={(event) => event.stopPropagation()}
		>
			<PipelineDropdown
				currentStatus={task.status}
				onMove={handleStatusMove}
				onMoveToCustomColumn={handleMoveToCustomColumn}
				customColumns={project.customColumns}
				currentCustomColumnId={task.customColumnId}
				project={project}
			/>
		</div>,
		document.body,
	);

	// Narrow form of the same menu: an anchored popover is a desktop idiom (small
	// rows, edge clipping) — the manifest mandates a BottomSheet for "Move to".
	const statusSheet = (
		<BottomSheet
			open={statusMenuOpen}
			onClose={() => setStatusMenuOpen(false)}
			title={t("task.moveTo")}
			testId="task-status-sheet"
		>
			<PipelineDropdown
				currentStatus={task.status}
				onMove={handleStatusMove}
				onMoveToCustomColumn={handleMoveToCustomColumn}
				customColumns={project.customColumns}
				currentCustomColumnId={task.customColumnId}
				project={project}
				size="touch"
				hideHeader
			/>
		</BottomSheet>
	);

	const spawnAgentButton = isTaskActive && task.worktreePath ? (
		<Tooltip content={t("tmux.spawnExtraAgentDesc")} detail={t("ttip.infoPanel.spawnAgent")}>
			<button
				onClick={() => setSpawnModalOpen(true)}
				className="task-anim flex items-center gap-1 px-2 py-1 rounded-lg transition-colors text-success hover:bg-success/15 border border-success/30"
				aria-label={t("tmux.spawnExtraAgentDesc")}
			>
				<AddAgentIcon className="w-[1.05rem] h-[1.05rem]" />
				{!compact && <span className="text-micro font-semibold whitespace-nowrap">{t("tmux.spawnExtraAgent")}</span>}
			</button>
	</Tooltip>
	) : null;

	// "Send later" — queue a message to this task's live agent (session action).
	// Same live-agent gate as spawn: an active task with a worktree/session.
	// Compact label ("Later") keeps the session bar tight; the full "Send later"
	// stays in the tooltip/aria. The pending queue renders in the adjacent chip.
	async function handleHibernate() {
		// Confirmed, unlike every other reversible action: killing the session is
		// the one part hibernation cannot undo. Extra agent panes come back only
		// through "Resume agent conversation" — waking with a plain shell clears
		// sessionState and drops them for good (see restartTask in tmux-pty.ts).
		const paneCount = task.sessionState?.panes?.length ?? 0;
		const confirmed = await confirm({
			title: t("task.hibernateConfirmTitle"),
			message: paneCount > 1
				? `${t("task.hibernateConfirmBody")}\n\n${t("task.hibernateConfirmMulti", { count: String(paneCount) })}`
				: t("task.hibernateConfirmBody"),
			confirmLabel: t("task.hibernateConfirmCta"),
			danger: true,
			info: { title: task.title },
		});
		if (!confirmed) return;
		setHibernating(true);
		try {
			const { task: updated, freedRssBytes } = await api.request.hibernateTask({ taskId: task.id, projectId: project.id });
			dispatch({ type: "updateTask", task: updated });
			// "about": the reading comes from the resource monitor's last poll, which
			// can be up to one poll interval older than the kill.
			toast.success(freedRssBytes
				? t("task.hibernatedToastMem", { mem: formatBytes(freedRssBytes) })
				: t("task.hibernatedToast"), { taskId: task.id });
		} catch (err) {
			toast.error(t("task.hibernateFailed", { error: String(err) }), { taskId: task.id });
		} finally {
			setHibernating(false);
		}
	}

	// Take responsibility for a reviewed branch's config. The user is allowed to do
	// this — it is their machine — but they must be told what starts running, in
	// plain words, before they do. Warned, never refused.
	async function ownForeignCode() {
		const confirmed = await confirm({
			title: t("infoPanel.foreignCodeOwnConfirmTitle"),
			message: t("infoPanel.foreignCodeOwnConfirmBody"),
			confirmLabel: t("infoPanel.foreignCodeOwnConfirmCta"),
			danger: true,
			info: { title: task.branchName ?? task.title },
		});
		if (!confirmed) return;
		try {
			const updated = await api.request.setTaskForeignCode({ taskId: task.id, projectId: project.id, foreignCode: false });
			dispatch({ type: "updateTask", task: updated });
			toast.info(t("infoPanel.foreignCodeOwnedToast"), { taskId: task.id });
		} catch (err) {
			toast.error(String(err), { taskId: task.id });
		}
	}

	const sendLaterButton = isTaskActive && task.worktreePath ? (
		<Tooltip content={t("task.sendLater")} detail={t("task.sendLaterHint")}>
			<button
				onClick={() => setScheduleMsgOpen(true)}
				className="task-anim flex items-center gap-1 px-2 py-1 rounded-lg transition-colors text-fg-3 hover:text-fg hover:bg-elevated border border-edge"
				aria-label={t("task.sendLater")}
			>
				<svg className="w-[1.05rem] h-[1.05rem]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
					<circle cx="12" cy="13" r="8" />
					<path d="M12 9v4l2.5 1.5" />
					<path d="M5 3 2 6M19 3l3 3" />
				</svg>
				{!compact && <span className="text-micro font-semibold whitespace-nowrap">{t("task.sendLaterShort")}</span>}
			</button>
		</Tooltip>
	) : null;

	// Park the task: kill the agent, its tmux session and the dev server, keep the
	// worktree. Session-domain, so it lives in this bar next to the other
	// agent-session controls — never on the board card (a hibernated card is inert
	// by design, and waking must be an explicit act inside the task).
	// Amber, not danger: red in this app means "destroys something you cannot get
	// back", and the neighbouring Bug Hunters button already owns it here. The skull
	// is the one filled glyph in this bar on purpose — it has to stop the eye before
	// the tooltip explains that the worktree survives.
	const hibernateButton = isTaskActive && task.worktreePath && !task.hibernated && !task.preparing && !task.shuttingDown ? (
		<Tooltip content={t("task.hibernate")} detail={t("task.hibernateHint")}>
			<button
				data-testid="task-hibernate-button"
				onClick={handleHibernate}
				disabled={hibernating}
				className="task-anim flex items-center gap-1 px-2 py-1 rounded-lg transition-colors text-warning hover:text-warning hover:bg-warning/15 border border-warning/30 disabled:opacity-50"
				aria-label={t("task.hibernate")}
			>
				{hibernating ? (
					<span className="w-[1.05rem] h-[1.05rem] animate-spin rounded-full border-2 border-warning/30 border-t-warning" />
				) : (
					<svg className="w-[1.05rem] h-[1.05rem]" viewBox="0 0 24 24" fill="none">
						<path d="M3 13.6 21 20M21 13.6 3 20" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
						<path
							fill="currentColor"
							fillRule="evenodd"
							clipRule="evenodd"
							d="M12 2.2c-3.3 0-5.8 2.4-5.8 5.7 0 1.8.8 3.3 2.1 4.4v1.5c0 .7.6 1.3 1.3 1.3h4.8c.7 0 1.3-.6 1.3-1.3v-1.5c1.3-1.1 2.1-2.6 2.1-4.4 0-3.3-2.5-5.7-5.8-5.7ZM9.4 5.8a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm5.2 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM12 10.6l1.4 2.4h-2.8l1.4-2.4Z"
						/>
					</svg>
				)}
				{!compact && <span className="text-micro font-semibold whitespace-nowrap">{t("task.hibernateShort")}</span>}
			</button>
		</Tooltip>
	) : null;

	// Pending scheduled-message queue for this task's session (open-task view of
	// the same chip shown on the board card). Opens downward under the bar.
	const scheduledMessagesChip = isTaskActive && task.worktreePath ? (
		<ScheduledMessagesChip task={task} project={project} dispatch={dispatch} placement="down" />
	) : null;

	const bugHuntersButton = project.kind !== "virtual" && isTaskActive && task.worktreePath ? (
		<Tooltip content={t("bugHunters.buttonTooltip")} detail={t("ttip.infoPanel.bugHunters")}>
		<button
			onClick={() => setBugHuntersOpen(true)}
			className="task-anim flex items-center gap-1 px-2 py-1 rounded-lg transition-colors text-danger hover:text-danger hover:bg-danger/15 border border-danger/30"
			aria-label={t("bugHunters.buttonTooltip")}
		>
			<FindBugsIcon className="w-[1.05rem] h-[1.05rem]" />
			{!compact && <span className="text-micro font-semibold whitespace-nowrap">{t("bugHunters.buttonLabel")}</span>}
		</button>
		</Tooltip>
	) : null;

	const worktreeSettingsButton = task.worktreePath ? (
		<Tooltip content={t("projectSettings.tabWorktree")} detail={t("ttip.infoPanel.worktreeConfig")}>
			<button
				onClick={() => navigate({ screen: "project-settings", projectId: project.id, tab: "worktree", worktreeTaskId: task.id })}
				className="task-anim flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
				aria-label={t("projectSettings.tabWorktree")}
			>
				<WorktreeSettingsIcon className="w-4 h-4" />
			</button>
	</Tooltip>
	) : null;

	const taskDetailsBody = (
		<>
						<div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs" data-help-id="inspector.metadata">
							<span className="text-fg-3">{t("infoPanel.title")}</span>
							<InlineRename
								taskId={task.id}
								projectId={project.id}
								currentTitle={getTaskTitle(task)}
								hasCustomTitle={!!task.customTitle}
								dispatch={dispatch}
								className="text-fg-2 font-semibold truncate"
								inputClassName="w-full bg-base border border-edge-active rounded px-1.5 py-0.5 text-xs text-fg focus:border-accent"
								showReset
							/>

							<span className="text-fg-3">{t("infoPanel.taskNumber")}</span>
							<span className="text-fg-2 font-mono font-semibold">#{task.seq}</span>

							{task.branchName && (
								<>
									<span className="text-fg-3">{t("infoPanel.branch")}</span>
									<span className="text-fg-2 font-mono">{task.branchName}</span>
								</>
							)}

							{/* Whose code, plus the one consequence of the answer. Metadata, not a
							    quickbar: this is diagnostic ("why did my setup script not run?"),
							    and it is where the branch it qualifies already lives. */}
							{task.foreignCode && (
								<>
									<span className="text-fg-3">{t("infoPanel.foreignCode")}</span>
									<span className="flex items-center gap-2 min-w-0">
										<ForeignCodeMark task={task} className="w-3.5 h-3.5" testId="info-panel-foreign-code" />
										<span className="text-fg-2 truncate">{t("infoPanel.foreignCodeValue")}</span>
										<button
											type="button"
											onClick={ownForeignCode}
											className="task-anim flex-shrink-0 rounded border border-edge px-1.5 py-0.5 text-dense text-fg-3 hover:bg-elevated hover:text-fg transition-colors"
										>
											{t("infoPanel.foreignCodeOwn")}
										</button>
									</span>
								</>
							)}

							{metadataPrInfo && (
								<>
									<span className="text-fg-3">{t("infoPanel.pullRequest")}</span>
									<TaskPrStatusPopover prInfo={metadataPrInfo} projectId={project.id} taskId={task.id} onShowUnresolved={openUnresolvedInDiff}>
										<button
											type="button"
											onClick={() => metadataPrInfo.url && window.open(metadataPrInfo.url, "_blank")}
											className="inline-flex items-center gap-1.5 text-success font-mono font-semibold hover:underline text-left"
										>
											<span>{t("task.prBadge", { number: String(metadataPrInfo.number) })}</span>
											{(metadataPrInfo.unresolvedCount ?? 0) > 0 && (
												<span className="inline-flex items-center gap-0.5 text-warning no-underline" aria-label={t.plural("task.prUnresolvedComments", metadataPrInfo.unresolvedCount ?? 0)}>
													<span className="leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF086"}</span>
													<span>{metadataPrInfo.unresolvedCount}</span>
												</span>
											)}
										</button>
									</TaskPrStatusPopover>
								</>
							)}

							{(() => {
								const projectLabels = project.labels ?? [];
								const assignedLabels = (task.labelIds ?? [])
									.map((id) => projectLabels.find((label) => label.id === id))
									.filter(Boolean) as typeof projectLabels;

								return assignedLabels.length > 0 ? (
									<>
										<span className="text-fg-3">{t("labels.taskLabels")}</span>
										<div className="flex items-center flex-wrap gap-1">
											{assignedLabels.map((label) => (
												<LabelChip key={label.id} label={label} size="xs" />
											))}
										</div>
									</>
								) : null;
							})()}

							{task.description && (
								<>
									<span className="text-fg-3">{t("infoPanel.description")}</span>
									<div>
										<span className="text-fg-2 whitespace-pre-wrap">{task.description}</span>
										<ImageAttachmentsStrip text={task.description} />
									</div>
								</>
							)}

							{task.worktreePath && (
								<>
									<span className="text-fg-3">{t("infoPanel.worktree")}</span>
									<span className="flex items-center gap-1.5 min-w-0">
										<span className="text-fg-3 font-mono truncate">{task.worktreePath}</span>
										<Tooltip content={copiedPath ? t("infoPanel.pathCopied") : t("infoPanel.copyPath")} detail={t("ttip.infoPanel.copyPath")}>
											<button
												onClick={() => {
													navigator.clipboard.writeText(task.worktreePath!);
													setCopiedPath(true);
													setTimeout(() => setCopiedPath(false), 1500);
												}}
												className="flex-shrink-0 text-fg-muted hover:text-fg transition-colors"
												aria-label={copiedPath ? t("infoPanel.pathCopied") : t("infoPanel.copyPath")}
											>
												<span className="text-xs leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
													{copiedPath ? "\u{F012C}" : "\uF0C5"}
												</span>
											</button>
										</Tooltip>
										{copiedPath && <span className="text-dense text-accent flex-shrink-0">{t("infoPanel.pathCopied")}</span>}
									</span>
								</>
							)}

							<span className="text-fg-3">{t("infoPanel.created")}</span>
							<span className="text-fg-3">{formatDate(task.createdAt)}</span>

							<span className="text-fg-3">{t("infoPanel.updated")}</span>
							<span className="text-fg-3">{formatDate(task.updatedAt)}</span>
						</div>

						{allocatedPorts.length > 0 && (
							<div className="mt-3 border-t border-edge pt-3">
								<div className="flex items-center gap-2 mb-2">
									<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0317}"}</span>
									<span className="text-xs text-fg-3 font-semibold uppercase tracking-wider">{t("ports.allocated")}</span>
								</div>
								<div className="flex flex-wrap gap-1.5">
									{allocatedPorts.map((port, index) => (
										<span
											key={port}
											className="inline-flex items-center gap-1 text-xs font-mono text-fg-2 bg-raised px-2 py-1 rounded-md"
											title={`$DEV3_PORT${index}`}
										>
											<span className="text-fg-muted text-dense">DEV3_PORT{index}=</span>
											<span className="font-bold">{port}</span>
										</span>
									))}
								</div>
							</div>
						)}

						{(() => {
							const ports = taskPorts?.get(task.id);
							if (!ports || ports.length === 0) {
								return null;
							}

							return (
								<div className="mt-3 border-t border-edge pt-3">
									<div className="flex items-center gap-2 mb-2">
										<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF0AC"}</span>
										<span className="text-xs text-fg-3 font-semibold uppercase tracking-wider">{t("ports.title")}</span>
										<span className="text-dense text-fg-muted">{t.plural("ports.count", ports.length)}</span>
									</div>
									<div className="flex flex-wrap gap-1.5">
										{ports.map((port) => (
											<Tooltip key={port.port} content={`${port.processName} (PID ${port.pid}) — ${t("ports.openInBrowser")}`}>
												<button
													onClick={() => window.open(`http://localhost:${port.port}`, "_blank")}
													className="inline-flex items-center gap-1.5 text-xs font-mono text-accent bg-accent/10 hover:bg-accent/20 px-2 py-1 rounded-md transition-colors"
												>
													<span className="font-bold">:{port.port}</span>
													<span className="text-fg-muted text-dense">{port.processName}</span>
												</button>
											</Tooltip>
										))}
									</div>
								</div>
							);
						})()}

						{(() => {
							const usage = taskResourceUsage?.get(task.id.slice(0, 8));
							if (!usage) {
								return null;
							}

							return (
								<div className="mt-3 border-t border-edge pt-3">
									<div className="flex items-center gap-2 mb-2">
										<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F035B}"}</span>
										<span className="text-xs text-fg-3 font-semibold uppercase tracking-wider">{t("resources.title")}</span>
									</div>
									<div className="flex items-center gap-4 text-xs font-mono">
										<div>
											<span className="text-fg-muted">{t("resources.memory")}</span>
											<span className="ml-1.5 text-fg-2">{formatBytes(usage.rss)}</span>
										</div>
										<div>
											<span className="text-fg-muted">{t("resources.cpu")}</span>
											<span className="ml-1.5 text-fg-2">{usage.cpu.toFixed(1)}%</span>
										</div>
									</div>
								</div>
							);
						})()}

						<TaskNotes task={task} project={project} dispatch={dispatch} />
		</>
	);

	const height = collapsed ? `${COLLAPSED_HEIGHT_REM}rem` : panelHeight;

	// Narrow viewport (phone / narrow window): the two dense desktop toolbars do
	// not fit. Collapse them into a thin summary bar (status + title + diff) and
	// fold every action + the full details grid into an actions BottomSheet — the
	// same kebab→sheet pattern used in the global header.
	if (narrow) {
		return (
			<div className="flex-shrink-0 border-b border-edge glass-header">
				{diffFilesPopover}
				{fileOpenInMenuPortal}
				{statusSheet}
				{/* The bar sheds, it never stacks (bible §12.6). A second row costs a
				    phone a whole band of screen and moves every control the user was
				    aiming at — worse than losing the least important one. Priority,
				    lowest first: diff badge → artifacts → images → the status label.
				    Thresholds are container queries in PX, not rem: the 0.67× phone
				    factor makes 1rem ≈ 10.7px, so rem thresholds fire ~1.5× too late.
				    Everything shed keeps a row in the actions sheet. */}
				<div className="flex flex-nowrap items-center gap-x-2 px-3 py-2 min-h-[3.25rem] min-w-0 [container-type:inline-size]" data-testid="task-summary-bar">
					{variantSwitcher}
					{statusDropdownButton}
					{/* Priority sits with status (Context domain, §5.1); `sm` gives it a
					    legible chip and a comfortable touch target on a phone (§12.6),
					    versus the dense `xs` desktop badge. */}
					<PriorityBadge priority={task.priority} onChange={handleSetPriority} size="sm" className="shrink-0" />
					{/* Agent outputs (images / artifacts) ride the summary bar next to
					    priority, not only the sheet: they are conditional, and an unread
					    one has to be seen without opening a menu. Same class as the diff
					    badge — a readout, not a folded action (bible §12.6). */}
					<span className="hidden [@container(min-width:340px)]:contents">
						<TaskSharedImages task={task} projectId={project.id} compact touch />
						<TaskArtifacts task={task} projectId={project.id} compact touch />
					</span>
					{/* Task title intentionally omitted here — it already shows in the
					    breadcrumb row above (GlobalHeader). Repeating it wasted the whole
					    bar; the freed space keeps status + priority + diff readable. */}
					<div className="flex-1 min-w-0" />
					{/* First to go: it is the widest chip on the bar ("18 files +195 −131"
					    ≈ 100px) and the only one whose whole content repeats verbatim in
					    the sheet's Show diff row. */}
					<span className="hidden [@container(min-width:400px)]:contents" data-testid="summary-bar-diff-slot">
						{diffSummaryBadge}
					</span>
					<Tooltip content={t("infoPanel.actionsTitle")} detail={t("ttip.infoPanel.actions")}>
						<button
							type="button"
							onClick={() => setActionsSheetOpen(true)}
							aria-label={t("infoPanel.actionsTitle")}
							data-testid="task-actions-kebab"
							className="flex-shrink-0 flex h-9 w-9 items-center justify-center rounded-lg text-fg-3 hover:bg-elevated hover:text-fg transition-colors"
						>
							<span className="text-lg leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F01D9}"}</span>
						</button>
					</Tooltip>
				</div>

				<BottomSheet
					open={actionsSheetOpen}
					onClose={() => setActionsSheetOpen(false)}
					title={t("infoPanel.actionsTitle")}
					testId="task-actions-sheet"
				>
					<div className="flex flex-col gap-4">
						{/* Mobile is a monitor / trigger / read surface, not the dense desktop
						    toolbar. Editor "open in", scripts, tmux layout, dev server, git
						    mutations and durable worktree config are intentionally omitted —
						    they act on the machine you are not sitting at, or need the
						    terminal. The diff stays one tap away via the summary-bar badge
						    above. Kept: watch, agent triggers, tunnels (open the app on this
						    phone), shared images, and the read-only details. */}
						<div className="touch-actions flex flex-col gap-2">
							<button
								type="button"
								onClick={handleToggleWatch}
								aria-pressed={task.watched}
								className={`${SHEET_ROW_CLASS} ${task.watched ? "border-accent/30 bg-accent/10" : ""}`}
							>
								{task.watched
									? <WatchingIcon className="h-5 w-5 shrink-0 text-accent" />
									: <WatchIcon className="h-5 w-5 shrink-0 text-fg-3" />}
								<span className="flex-1 text-sm font-medium">{task.watched ? t("task.watching") : t("task.watch")}</span>
							</button>
							<button
								type="button"
								onClick={handleToggleManualCompletion}
								aria-pressed={task.manualCompletion === true}
								className={`${SHEET_ROW_CLASS} ${task.manualCompletion ? "border-accent/30 bg-accent/10" : ""}`}
							>
								<CompletionOwnerIcon className={`h-5 w-5 shrink-0 ${task.manualCompletion ? "text-accent" : "text-fg-3"}`} active={task.manualCompletion} />
								<span className="flex-1 text-sm font-medium">{task.manualCompletion ? t("task.manualCompletionEnabled") : t("task.manualCompletion")}</span>
							</button>

							{/* The bar may shed the diff badge on a narrow screen, so the diff
							    needs a sheet path that does not depend on the task still being
							    active — TaskGitActionsSheet's own Show diff row requires a live
							    worktree, and a finished task would otherwise lose the diff
							    entirely (bible §12.6: nothing is shed without a sheet path). */}
							{diffSummaryBadge && !(project.kind !== "virtual" && isTaskActive && task.worktreePath) && onOpenInlineDiff && (
								<button
									type="button"
									data-testid="task-actions-show-diff"
									onClick={() => {
										setActionsSheetOpen(false);
										openBranchDiff();
									}}
									className={SHEET_ROW_CLASS}
								>
									<ShowDiffIcon className="h-5 w-5 shrink-0 text-accent" />
									<span className="flex-1 text-sm font-medium">{t("infoPanel.showDiff")}</span>
									<span className="text-xs font-mono text-fg-3 tabular-nums">{visibleDiffFiles}</span>
								</button>
							)}

							{isTaskActive && task.worktreePath && (
								<button type="button" onClick={() => setSpawnModalOpen(true)} className={SHEET_ROW_CLASS}>
									<AddAgentIcon className="h-5 w-5 shrink-0 text-success" />
									<span className="flex-1 text-sm font-medium">{t("tmux.spawnExtraAgent")}</span>
									<ChevronRightIcon />
								</button>
							)}

							{project.kind !== "virtual" && isTaskActive && task.worktreePath && (
								<button type="button" onClick={() => setBugHuntersOpen(true)} className={SHEET_ROW_CLASS}>
									<FindBugsIcon className="h-5 w-5 shrink-0 text-danger" />
									<span className="flex-1 text-sm font-medium">{t("bugHunters.buttonLabel")}</span>
									<ChevronRightIcon />
								</button>
							)}

							<TaskExposedPorts task={task} rowClassName={SHEET_ROW_CLASS} />

							{(task.sharedImages?.length ?? 0) > 0 && (
								<button
									type="button"
									onClick={() => {
										setActionsSheetOpen(false);
										window.dispatchEvent(new CustomEvent("dev3:openImageViewer", {
											detail: { taskId: task.id, projectId: project.id, images: task.sharedImages, index: (task.sharedImages?.length ?? 1) - 1 },
										}));
									}}
									className={SHEET_ROW_CLASS}
								>
									<ImagesIcon className="h-5 w-5 shrink-0 text-fg-3" />
									<span className="flex-1 text-sm font-medium">{t("infoPanel.imagesLabel")}</span>
									<span className="text-xs font-semibold text-accent tabular-nums">{task.sharedImages?.length}</span>
								</button>
							)}

							{(task.sharedArtifacts?.length ?? 0) > 0 && (
								<button
									type="button"
									onClick={() => {
										setActionsSheetOpen(false);
										window.dispatchEvent(new CustomEvent("dev3:openArtifactViewer", {
											detail: { taskId: task.id, projectId: project.id, artifacts: task.sharedArtifacts, index: (task.sharedArtifacts?.length ?? 1) - 1 },
										}));
									}}
									className={SHEET_ROW_CLASS}
								>
									<ArtifactsIcon className="h-5 w-5 shrink-0 text-fg-3" />
									<span className="flex-1 text-sm font-medium">{t("infoPanel.artifactsLabel")}</span>
									<span className="text-xs font-semibold text-accent tabular-nums">{task.sharedArtifacts?.length}</span>
								</button>
							)}
						</div>

						{project.kind !== "virtual" && isTaskActive && task.worktreePath && (
							<TaskGitActionsSheet
								task={task}
								project={project}
								isTaskActive={isTaskActive}
								git={narrowGit}
								rowClassName={SHEET_ROW_CLASS}
								onOpenInlineDiff={onOpenInlineDiff}
								onAction={() => setActionsSheetOpen(false)}
							/>
						)}

						<section className="border-t border-edge pt-4">
							<h3 className="mb-2 text-dense font-semibold uppercase tracking-wider text-fg-muted">{t("infoPanel.sheetDetails")}</h3>
							{taskDetailsBody}
						</section>
					</div>
				</BottomSheet>

				{spawnModalOpen && createPortal(
					<SpawnAgentModal task={task} project={project} onClose={() => setSpawnModalOpen(false)} />,
					document.body,
				)}
				{scheduleMsgOpen && createPortal(
					<ScheduleMessageModal task={task} project={project} dispatch={dispatch} onClose={() => setScheduleMsgOpen(false)} />,
					document.body,
				)}
				{bugHuntersOpen && createPortal(
					<BugHuntersLightbox task={task} project={project} onClose={() => setBugHuntersOpen(false)} />,
					document.body,
				)}
			</div>
		);
	}

	return (
		<div
			ref={panelRef}
			className="flex-shrink-0 border-b border-edge glass-header overflow-hidden transition-[height] duration-200 ease-out"
			style={{ height }}
		>
			{diffFilesPopover}
			{fileOpenInMenuPortal}
			{collapsed ? (
				<div className="flex flex-col h-full px-4 gap-1 justify-center">
					<div className="flex items-center gap-1.5 min-w-0">
						{/* Same bar boxing as the expanded rows: the Context bar is the only
						    shrinkable region, so the Session bar and the pinned chrome to
						    its right can never be pushed out of the panel. */}
						<div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
							{variantSwitcher}
							{watchToggleButton}
							{manualCompletionToggleButton}
							{priorityBadge}
							{statusDropdownButton}
							{diffSummaryBadge}
							{diffIncludeTestsToggle}
							{labelStrip}
						</div>
						{statusDropdownPortal}
						<div className="flex-1" />
						<div className="flex items-center gap-1.5 flex-shrink-0">
							{bugHuntersButton}
							{spawnAgentButton}
							{sendLaterButton}
							{hibernateButton}
							{scheduledMessagesChip}
							<div className="w-px h-6 self-center bg-edge flex-shrink-0 mx-1" aria-hidden="true" />
							<TaskPaneControls taskId={task.id} compact={tight} />
						</div>
						{worktreeSettingsButton}
						{showPanelButton}
						<Tooltip content={terminalFullscreenLabel} detail={terminalFullscreenTooltip}>
							<button
								onClick={toggleTerminalFullscreen}
								className="task-anim flex-shrink-0 p-1 rounded hover:bg-accent/10 transition-colors text-accent hover:text-accent-emphasis"
								aria-label={terminalFullscreenLabel}
							>
								{terminalFullscreenActive
									? <FullscreenExitIcon className="w-3.5 h-3.5" />
									: <FullscreenEnterIcon className="w-3.5 h-3.5" />}
							</button>
						</Tooltip>
						<Tooltip content={t("infoPanel.expand")} detail={t("ttip.infoPanel.expand")}>
							<button
								onClick={toggleCollapsed}
								className="task-anim flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
								aria-label={t("infoPanel.expand")}
							>
								<PanelChevronIcon direction="down" className="w-3.5 h-3.5" />
							</button>
					</Tooltip>
					</div>

					<div className="flex items-center gap-1.5 min-w-0">
						<div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
							{project.kind === "virtual" ? (
								<span className="text-fg-muted text-micro italic flex-shrink-0 truncate">{t("ops.gitUnavailable")}</span>
							) : (
								<TaskGitActions
									task={task}
									project={project}
									dispatch={dispatch}
									navigate={navigate}
									isTaskActive={isTaskActive}
									showWorktreeCopy
									showLoading
									branchNameClassName={`text-fg-3 text-xs font-mono flex-shrink-0 truncate ${veryTight ? "max-w-[4rem]" : tight ? "max-w-[6rem]" : "max-w-[12.5rem]"}`}
									compact={compact}
									onBranchStatusChange={setMetadataBranchState}
									onOpenInlineDiff={onOpenInlineDiff}
								/>
							)}
						</div>
						<div className="flex-1" />
						<div className="flex items-center gap-2 flex-shrink-0">
							<TaskOpenIn task={task} project={project} isTaskActive={isTaskActive} showFileBrowser compact={tight} />
							{project.kind !== "virtual" && (
								<>
									<TaskScripts task={task} project={project} isTaskActive={isTaskActive} />
									<TaskDevServer task={task} project={project} isTaskActive={isTaskActive} compact={tight} />
								</>
							)}
							<TaskExposedPorts task={task} compact={tight} />
							<TaskSharedImages task={task} projectId={project.id} compact={tight} />
							<TaskArtifacts task={task} projectId={project.id} compact={tight} />
						</div>
					</div>
				</div>
			) : (
				<div className="flex flex-col h-full">
					<div className="flex flex-col px-4">
						<div className="flex items-center gap-1.5 min-w-0 pt-1">
							{/* `overflow-hidden` is the backstop that keeps a bar's contents
							    inside its own box: without it the shrink-0 children spill
							    over the neighbouring bar and over the pinned chrome (which
							    then becomes unclickable). `tight` folds content first, so
							    clipping only happens at pathological widths. */}
							<div className="flex items-center gap-1.5 min-w-0 overflow-hidden" data-help-id="inspector.context-bar">
								{variantSwitcher}
								{watchToggleButton}
								{manualCompletionToggleButton}
								{priorityBadge}
								{statusDropdownButton}
								{statusDropdownPortal}
								{diffSummaryBadge}
								{diffIncludeTestsToggle}
								{labelStrip}
							</div>
							<div className="flex-1" />
							<div className="flex items-center gap-1.5 flex-shrink-0" data-help-id="inspector.session-bar">
								{bugHuntersButton}
								{spawnAgentButton}
								{sendLaterButton}
								{hibernateButton}
								{scheduledMessagesChip}
								<div className="w-px h-6 self-center bg-edge flex-shrink-0 mx-1" aria-hidden="true" />
								<TaskPaneControls taskId={task.id} compact={tight} />
							</div>
							<HelpSpot topicId="inspector.panel" className="ml-0.5" />
							{showPanelButton}
							<Tooltip content={terminalFullscreenLabel} detail={terminalFullscreenTooltip}>
								<button
									onClick={toggleTerminalFullscreen}
									className="task-anim flex-shrink-0 p-1 rounded hover:bg-accent/10 transition-colors text-accent hover:text-accent-emphasis"
									aria-label={terminalFullscreenLabel}
								>
									{terminalFullscreenActive
										? <FullscreenExitIcon className="w-3.5 h-3.5" />
										: <FullscreenEnterIcon className="w-3.5 h-3.5" />}
								</button>
							</Tooltip>
							<Tooltip content={t("infoPanel.collapse")} detail={t("ttip.infoPanel.collapse")}>
								<button
									onClick={toggleCollapsed}
									className="task-anim flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
									aria-label={t("infoPanel.collapse")}
								>
									<PanelChevronIcon direction="up" className="w-3.5 h-3.5" />
								</button>
						</Tooltip>
						</div>

						<div className="flex items-center gap-1.5 min-w-0 pb-1">
							<div className="flex items-center gap-1.5 min-w-0 overflow-hidden" data-help-id="inspector.git-bar">
								{project.kind === "virtual" ? (
									<span className="text-fg-muted text-micro italic flex-shrink-0 truncate">{t("ops.gitUnavailable")}</span>
								) : (
									<TaskGitActions
										task={task}
										project={project}
										dispatch={dispatch}
										navigate={navigate}
										isTaskActive={isTaskActive}
										branchNameClassName={`text-fg-3 text-xs font-mono flex-shrink-0 truncate ${veryTight ? "max-w-[4rem]" : tight ? "max-w-[6rem]" : "max-w-[12.5rem]"}`}
										compact={compact}
										onBranchStatusChange={setMetadataBranchState}
										onOpenInlineDiff={onOpenInlineDiff}
									/>
								)}
							</div>
							<div className="flex-1" />
							<div className="flex items-center gap-2 flex-shrink-0" data-help-id="inspector.runtime-bar">
								<TaskOpenIn task={task} project={project} isTaskActive={isTaskActive} showFileBrowser={false} compact={tight} />
								{project.kind !== "virtual" && (
									<>
										<TaskScripts task={task} project={project} isTaskActive={isTaskActive} />
										<TaskDevServer task={task} project={project} isTaskActive={isTaskActive} compact={tight} />
									</>
								)}
								<TaskExposedPorts task={task} compact={tight} />
								<TaskSharedImages task={task} projectId={project.id} compact={tight} />
								<TaskArtifacts task={task} projectId={project.id} compact={tight} />
							</div>
						</div>
					</div>

					<div className="flex-1 overflow-auto px-4 pb-2">
						{taskDetailsBody}
					</div>

					<div
						className="flex-shrink-0 flex items-center justify-center h-[6px] cursor-row-resize group"
						onMouseDown={onDragStart}
						onDoubleClick={toggleCollapsed}
					>
						<div className="w-8 h-[3px] rounded-full bg-fg-muted/60 group-hover:bg-fg-muted/80 transition-colors" />
					</div>
				</div>
			)}

			{spawnModalOpen && createPortal(
				<SpawnAgentModal task={task} project={project} onClose={() => setSpawnModalOpen(false)} />,
				document.body,
			)}

			{bugHuntersOpen && createPortal(
				<BugHuntersLightbox task={task} project={project} onClose={() => setBugHuntersOpen(false)} />,
				document.body,
			)}

			{scheduleMsgOpen && createPortal(
				<ScheduleMessageModal task={task} project={project} dispatch={dispatch} onClose={() => setScheduleMsgOpen(false)} />,
				document.body,
			)}
		</div>
	);
}

export default TaskInfoPanel;
