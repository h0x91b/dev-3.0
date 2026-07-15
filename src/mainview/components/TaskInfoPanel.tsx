import { useState, useRef, useCallback, useEffect, useLayoutEffect, type Dispatch, type MouseEvent as ReactMouseEvent } from "react";
import { toast } from "../toast";
import { createPortal } from "react-dom";
import type { Task, Project, TaskStatus, PortInfo, ResourceUsage, Label } from "../../shared/types";
import LabelChip from "./LabelChip";
import OpenInMenu from "./OpenInMenu";
import { formatDate } from "./NoteItem";
import { ACTIVE_STATUSES, getTaskTitle } from "../../shared/types";
import InlineRename from "./InlineRename";
import { getTaskOpenMode, taskClosedHomeRoute, type AppAction, type Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { formatBytes } from "../utils/formatBytes";
import { getStatusLabel } from "../utils/statusLabel";
import { trackEvent, agentNameFromId } from "../analytics";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import { ImageAttachmentsStrip } from "./ImageAttachmentsStrip";
import MiniPipeline from "./MiniPipeline";
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
import { IncludeTestsIcon } from "./task-info-panel/GitIcons";
import {
	WatchingIcon,
	WatchIcon,
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
import TaskTmuxControls from "./task-info-panel/TaskTmuxControls";
import { useTaskAllocatedPorts } from "./task-info-panel/useTaskAllocatedPorts";
import type { TaskInlineDiffRequest } from "./task-inline-diff";
import { isTestFile } from "../../shared/test-files";
import { useIncludeTestsInDiff } from "../utils/includeTestsInDiff";
import { useCompact } from "../utils/useCompact";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import BottomSheet from "./BottomSheet";
import HelpSpot from "./HelpSpot";
import Tooltip from "./Tooltip";
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
	const [spawnModalOpen, setSpawnModalOpen] = useState(false);
	const [scheduleMsgOpen, setScheduleMsgOpen] = useState(false);
	const [bugHuntersOpen, setBugHuntersOpen] = useState(false);
	const [metadataBranchState, setMetadataBranchState] = useState<TaskBranchStatusMeta | null>(null);
	const [includeTests, setIncludeTests] = useIncludeTestsInDiff();
	const [diffFilesHover, setDiffFilesHover] = useState(false);
	const [diffFilesPos, setDiffFilesPos] = useState({ top: 0, left: 0 });
	const [fileOpenInMenu, setFileOpenInMenu] = useState<{ path: string; pos: { top: number; left: number } } | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);
	const statusTriggerRef = useRef<HTMLButtonElement>(null);
	const statusMenuRef = useRef<HTMLDivElement>(null);
	const diffFilesTriggerRef = useRef<HTMLButtonElement>(null);
	const diffFilesHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

	// Leaving the narrow viewport (window widened) must not strand an open sheet.
	useEffect(() => {
		if (!narrow) setActionsSheetOpen(false);
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

	async function handleStatusMove(newStatus: TaskStatus) {
		setStatusMenuOpen(false);
		const terminal = newStatus === "completed" || newStatus === "cancelled";
		// Terminal moves leave the task screen immediately (worktree teardown runs
		// in the background); other moves keep the panel and show a spinner.
		const leaveScreen = terminal || !ACTIVE_STATUSES.includes(newStatus);
		await moveTaskToStatus({
			task,
			project,
			newStatus,
			dispatch,
			t,
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
				? () => navigate(taskClosedHomeRoute(project.id, getTaskOpenMode()))
				: undefined,
			onSuccess: !terminal && leaveScreen
				? () => navigate(taskClosedHomeRoute(project.id, getTaskOpenMode()))
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
			toast.error(t("task.failedMove", { error: String(err) }));
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
			compareRef: metadataBranchState?.compareRef,
			compareLabel: metadataBranchState?.compareLabel ?? `origin/${task.baseBranch || project.defaultBaseBranch || "main"}`,
			focusFile,
		});
	}

	function handleFileDiff(event: ReactMouseEvent<HTMLButtonElement>, relativePath: string) {
		event.stopPropagation();
		setDiffFilesHover(false);
		setFileOpenInMenu(null);
		openBranchDiff(relativePath);
	}

	const metadataBranchStatus = metadataBranchState?.branchStatus ?? null;
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
		? t("infoPanel.diffTestsHidden", { count: String(excludedTestCount) })
		: t("infoPanel.showDiff");
	const diffSummaryBadge = project.kind !== "virtual" && metadataBranchStatus && metadataBranchStatus.diffFiles > 0 ? (
		<button
			type="button"
			ref={diffFilesTriggerRef}
			className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-elevated border border-edge text-[0.6875rem] font-mono text-fg-2 flex-shrink-0 cursor-pointer transition-colors hover:bg-elevated-hover"
			onClick={() => openBranchDiff()}
			onMouseEnter={showDiffFilesPopover}
			onMouseLeave={hideDiffFilesPopover}
			title={diffBadgeTitle}
			data-testid="diff-summary-badge"
		>
			<span className="text-fg-muted text-[0.8rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF0CB"}</span>
			<span>{visibleDiffFiles} {visibleDiffFiles === 1 ? "file" : "files"}</span>
			<span className="text-success">+{visibleDiffInsertions}</span>
			<span className="text-danger">−{visibleDiffDeletions}</span>
			{!includeTests && excludedTestCount > 0 && (
				<span
					className="text-fg-muted text-[0.8rem] leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					title={t("infoPanel.diffTestsHidden", { count: String(excludedTestCount) })}
				>
					{"\u{F0912}"}
				</span>
			)}
		</button>
	) : null;
	const diffIncludeTestsToggle = project.kind !== "virtual" && metadataBranchStatus && metadataBranchStatus.diffFiles > 0 ? (
		<Tooltip content={t("infoPanel.diffIncludeTestsTooltip")} detail={t("ttip.infoPanel.includeTests")}>
		<button
			type="button"
			data-testid="diff-include-tests-toggle"
			onClick={() => setIncludeTests(!includeTests)}
			className={`git-anim inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[0.6875rem] font-mono flex-shrink-0 transition-colors ${
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
			<div className="text-[0.625rem] text-fg-muted font-semibold uppercase tracking-wider mb-1.5">
				{t("infoPanel.changedFiles")}
			</div>
			{visibleDiffFileStats.map(({ path: fileName, insertions, deletions }) => (
				<div key={fileName} className="group/file flex items-center gap-1.5 py-0.5 leading-snug">
					<span className="text-[0.6875rem] text-fg-2 font-mono truncate flex-1">{fileName}</span>
					{(insertions > 0 || deletions > 0) && (
						<span className="text-[0.625rem] font-mono flex-shrink-0">
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
								className="text-sm text-accent hover:text-accent-hover w-6 h-6 flex items-center justify-center rounded bg-accent/10 hover:bg-accent/20 transition-colors"
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
			onClose={() => setFileOpenInMenu(null)}
		/>
	) : null;

	const inlineLabels = assignedLabels.slice(0, MAX_INLINE_LABELS);
	const overflowLabels = assignedLabels.slice(MAX_INLINE_LABELS);
	const labelStrip = assignedLabels.length > 0 ? (
		<div className="flex items-center gap-1 min-w-0 flex-shrink">
			{inlineLabels.map((label) => <LabelChip key={label.id} label={label} size="xs" />)}
			{overflowLabels.length > 0 && (
				<span
					className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-elevated text-fg-3 text-[0.625rem] font-medium flex-shrink-0"
					title={overflowLabels.map((label) => label.name).join(", ")}
				>
					+{overflowLabels.length}
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
				<span className="text-[0.6875rem] font-medium">
					{task.watched ? t("task.watching") : t("task.watch")}
				</span>
			)}
		</button>
		</Tooltip>
	);

	const statusDropdownButton = (
		<button
			ref={statusTriggerRef}
			onClick={toggleStatusMenu}
			disabled={movingStatus}
			className="flex items-center gap-2 px-2.5 py-1 rounded-lg hover:bg-elevated transition-colors flex-shrink-0"
		>
			{activeCustomColumn ? (
				<div
					className="w-2.5 h-2.5 rounded-full flex-shrink-0"
					style={{ background: activeCustomColumn.color, boxShadow: `0 0 6px ${activeCustomColumn.color}60` }}
				/>
			) : (
				<MiniPipeline status={task.status} />
			)}
			<span className="text-[0.6875rem] font-medium text-fg-2">
				{activeCustomColumn ? activeCustomColumn.name : getStatusLabel(task.status, t, project)}
			</span>
			<svg className="w-3 h-3 text-fg-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
			</svg>
		</button>
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

	const spawnAgentButton = isTaskActive && task.worktreePath ? (
		<Tooltip content={t("tmux.spawnExtraAgentDesc")} detail={t("ttip.infoPanel.spawnAgent")}>
			<button
				onClick={() => setSpawnModalOpen(true)}
				className="task-anim flex items-center gap-1 px-2 py-1 rounded-lg transition-colors text-success hover:text-success-hover hover:bg-success/15 border border-success/30"
				aria-label={t("tmux.spawnExtraAgentDesc")}
			>
				<AddAgentIcon className="w-[1.05rem] h-[1.05rem]" />
				{!compact && <span className="text-[0.6875rem] font-semibold whitespace-nowrap">{t("tmux.spawnExtraAgent")}</span>}
			</button>
	</Tooltip>
	) : null;

	// "Send later" — queue a message to this task's live agent (session action).
	// Same live-agent gate as spawn: an active task with a worktree/session.
	// Compact label ("Later") keeps the session bar tight; the full "Send later"
	// stays in the tooltip/aria. The pending queue renders in the adjacent chip.
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
				{!compact && <span className="text-[0.6875rem] font-semibold whitespace-nowrap">{t("task.sendLaterShort")}</span>}
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
			{!compact && <span className="text-[0.6875rem] font-semibold whitespace-nowrap">{t("bugHunters.buttonLabel")}</span>}
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
						<div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
							<span className="text-fg-3">{t("infoPanel.title")}</span>
							<InlineRename
								taskId={task.id}
								projectId={project.id}
								currentTitle={getTaskTitle(task)}
								hasCustomTitle={!!task.customTitle}
								dispatch={dispatch}
								className="text-fg-2 font-semibold truncate"
								inputClassName="w-full bg-base border border-edge-active rounded px-1.5 py-0.5 text-xs text-fg focus:outline-none focus:border-accent"
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

							{metadataBranchStatus && metadataBranchStatus.prNumber !== null && (
								<>
									<span className="text-fg-3">{t("infoPanel.pullRequest")}</span>
									<button
										onClick={() => metadataBranchStatus.prUrl && window.open(metadataBranchStatus.prUrl, "_blank")}
										className="text-success font-mono font-semibold hover:underline text-left"
									>
										PR #{metadataBranchStatus.prNumber}
									</button>
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
												<span className="text-[0.75rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
													{copiedPath ? "\u{F012C}" : "\uF0C5"}
												</span>
											</button>
										</Tooltip>
										{copiedPath && <span className="text-[0.625rem] text-accent flex-shrink-0">{t("infoPanel.pathCopied")}</span>}
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
									<span className="text-[0.875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0317}"}</span>
									<span className="text-xs text-fg-3 font-semibold uppercase tracking-wider">{t("ports.allocated")}</span>
								</div>
								<div className="flex flex-wrap gap-1.5">
									{allocatedPorts.map((port, index) => (
										<span
											key={port}
											className="inline-flex items-center gap-1 text-xs font-mono text-fg-2 bg-raised px-2 py-1 rounded-md"
											title={`$DEV3_PORT${index}`}
										>
											<span className="text-fg-muted text-[0.625rem]">DEV3_PORT{index}=</span>
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
										<span className="text-[0.875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF0AC"}</span>
										<span className="text-xs text-fg-3 font-semibold uppercase tracking-wider">{t("ports.title")}</span>
										<span className="text-[0.625rem] text-fg-muted">{t.plural("ports.count", ports.length)}</span>
									</div>
									<div className="flex flex-wrap gap-1.5">
										{ports.map((port) => (
											<Tooltip key={port.port} content={`${port.processName} (PID ${port.pid}) — ${t("ports.openInBrowser")}`}>
												<button
													onClick={() => window.open(`http://localhost:${port.port}`, "_blank")}
													className="inline-flex items-center gap-1.5 text-xs font-mono text-accent bg-accent/10 hover:bg-accent/20 px-2 py-1 rounded-md transition-colors"
												>
													<span className="font-bold">:{port.port}</span>
													<span className="text-fg-muted text-[0.625rem]">{port.processName}</span>
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
										<span className="text-[0.875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F035B}"}</span>
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
				{statusDropdownPortal}
				<div className="flex items-center gap-2 px-3 h-[3.25rem] min-w-0">
					{variantSwitcher}
					{statusDropdownButton}
					<span className="flex-1 min-w-0 truncate text-fg-2 text-sm font-semibold">{getTaskTitle(task)}</span>
					{diffSummaryBadge}
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
									onClick={() => window.dispatchEvent(new CustomEvent("dev3:openImageViewer", {
										detail: { taskId: task.id, images: task.sharedImages, index: (task.sharedImages?.length ?? 1) - 1 },
									}))}
									className={SHEET_ROW_CLASS}
								>
									<ImagesIcon className="h-5 w-5 shrink-0 text-fg-3" />
									<span className="flex-1 text-sm font-medium">{t("infoPanel.imagesLabel")}</span>
									<span className="text-[0.75rem] font-semibold text-accent tabular-nums">{task.sharedImages?.length}</span>
								</button>
							)}

							{(task.sharedArtifacts?.length ?? 0) > 0 && (
								<button
									type="button"
									onClick={() => {
										setActionsSheetOpen(false);
										window.dispatchEvent(new CustomEvent("dev3:openArtifactViewer", {
											detail: { taskId: task.id, artifacts: task.sharedArtifacts, index: (task.sharedArtifacts?.length ?? 1) - 1 },
										}));
									}}
									className={SHEET_ROW_CLASS}
								>
									<ArtifactsIcon className="h-5 w-5 shrink-0 text-fg-3" />
									<span className="flex-1 text-sm font-medium">{t("infoPanel.artifactsLabel")}</span>
									<span className="text-[0.75rem] font-semibold text-accent tabular-nums">{task.sharedArtifacts?.length}</span>
								</button>
							)}
						</div>

						<section className="border-t border-edge pt-4">
							<h3 className="mb-2 text-[0.625rem] font-semibold uppercase tracking-wider text-fg-muted">{t("infoPanel.sheetDetails")}</h3>
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
						{variantSwitcher}
						{watchToggleButton}
						{statusDropdownButton}
						{statusDropdownPortal}
						{diffSummaryBadge}
						{diffIncludeTestsToggle}
						{labelStrip}
						<div className="flex-1" />
						{bugHuntersButton}
						{spawnAgentButton}
						{sendLaterButton}
						{scheduledMessagesChip}
						<div className="w-px h-6 self-center bg-edge flex-shrink-0 mx-1" aria-hidden="true" />
						<TaskTmuxControls taskId={task.id} />
						{worktreeSettingsButton}
						{showPanelButton}
						<Tooltip content={terminalFullscreenLabel} detail={terminalFullscreenTooltip}>
							<button
								onClick={toggleTerminalFullscreen}
								className="task-anim flex-shrink-0 p-1 rounded hover:bg-accent/10 transition-colors text-accent hover:text-accent-hover"
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
						{project.kind === "virtual" ? (
							<span className="text-fg-muted text-[0.6875rem] italic flex-shrink-0 truncate">{t("ops.gitUnavailable")}</span>
						) : (
							<TaskGitActions
								task={task}
								project={project}
								dispatch={dispatch}
								navigate={navigate}
								isTaskActive={isTaskActive}
								showWorktreeCopy
								showLoading
								compact={compact}
								onBranchStatusChange={setMetadataBranchState}
								onOpenInlineDiff={onOpenInlineDiff}
							/>
						)}
						<div className="flex-1" />
						<div className="flex items-center gap-2 flex-shrink-0">
							<TaskOpenIn task={task} project={project} isTaskActive={isTaskActive} showFileBrowser />
							{project.kind !== "virtual" && (
								<>
									<TaskScripts task={task} project={project} isTaskActive={isTaskActive} />
									<TaskDevServer task={task} project={project} isTaskActive={isTaskActive} />
								</>
							)}
							<TaskExposedPorts task={task} />
							<TaskSharedImages task={task} />
							<TaskArtifacts task={task} />
						</div>
					</div>
				</div>
			) : (
				<div className="flex flex-col h-full">
					<div className="flex flex-col px-4">
						<div className="flex items-center gap-1.5 min-w-0 pt-1">
							<div className="flex items-center gap-1.5 min-w-0" data-help-id="inspector.context-bar">
								{variantSwitcher}
								{watchToggleButton}
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
								{scheduledMessagesChip}
								<div className="w-px h-6 self-center bg-edge flex-shrink-0 mx-1" aria-hidden="true" />
								<TaskTmuxControls taskId={task.id} />
							</div>
							<HelpSpot topicId="inspector.panel" className="ml-0.5" />
							{showPanelButton}
							<Tooltip content={terminalFullscreenLabel} detail={terminalFullscreenTooltip}>
								<button
									onClick={toggleTerminalFullscreen}
									className="task-anim flex-shrink-0 p-1 rounded hover:bg-accent/10 transition-colors text-accent hover:text-accent-hover"
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
							<div className="flex items-center gap-1.5 min-w-0" data-help-id="inspector.git-bar">
								{project.kind === "virtual" ? (
									<span className="text-fg-muted text-[0.6875rem] italic flex-shrink-0 truncate">{t("ops.gitUnavailable")}</span>
								) : (
									<TaskGitActions
										task={task}
										project={project}
										dispatch={dispatch}
										navigate={navigate}
										isTaskActive={isTaskActive}
										branchNameClassName="text-fg-3 text-xs font-mono flex-shrink-0 truncate max-w-[12.5rem]"
										compact={compact}
										onBranchStatusChange={setMetadataBranchState}
										onOpenInlineDiff={onOpenInlineDiff}
									/>
								)}
							</div>
							<div className="flex-1" />
							<div className="flex items-center gap-2 flex-shrink-0" data-help-id="inspector.runtime-bar">
								<TaskOpenIn task={task} project={project} isTaskActive={isTaskActive} showFileBrowser={false} />
								{project.kind !== "virtual" && (
									<>
										<TaskScripts task={task} project={project} isTaskActive={isTaskActive} />
										<TaskDevServer task={task} project={project} isTaskActive={isTaskActive} />
									</>
								)}
								<TaskExposedPorts task={task} />
								<TaskSharedImages task={task} />
								<TaskArtifacts task={task} />
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
						<div className="w-8 h-[3px] rounded-full bg-fg-muted/40 group-hover:bg-fg-muted/70 transition-colors" />
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
