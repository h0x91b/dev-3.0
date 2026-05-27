import { useState, useRef, useCallback, useEffect, useLayoutEffect, type Dispatch, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { Task, Project, TaskStatus, PortInfo, ResourceUsage, Label } from "../../shared/types";
import LabelChip from "./LabelChip";
import OpenInMenu from "./OpenInMenu";
import { formatDate } from "./NoteItem";
import { ACTIVE_STATUSES, getTaskTitle } from "../../shared/types";
import InlineRename from "./InlineRename";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { formatBytes } from "../utils/formatBytes";
import { getStatusLabel } from "../utils/statusLabel";
import { trackEvent } from "../analytics";
import { confirmTaskCompletion } from "../utils/confirmTaskCompletion";
import { ImageAttachmentsStrip } from "./ImageAttachmentsStrip";
import MiniPipeline from "./MiniPipeline";
import PipelineDropdown from "./PipelineDropdown";
import SpawnAgentModal from "./SpawnAgentModal";
import TaskDevServer from "./task-info-panel/TaskDevServer";
import TaskScripts from "./task-info-panel/TaskScripts";
import TaskGitActions from "./task-info-panel/TaskGitActions";
import type { TaskBranchStatusMeta } from "./task-info-panel/TaskGitActions";
import TaskNotes from "./task-info-panel/TaskNotes";
import TaskOpenIn from "./task-info-panel/TaskOpenIn";
import TaskTmuxControls from "./task-info-panel/TaskTmuxControls";
import { useTaskAllocatedPorts } from "./task-info-panel/useTaskAllocatedPorts";
import type { TaskInlineDiffRequest } from "./task-inline-diff";
import { isTestFile } from "../../shared/test-files";
import { useIncludeTestsInDiff } from "../utils/includeTestsInDiff";

interface TaskInfoPanelProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	taskPorts?: Map<string, PortInfo[]>;
	taskResourceUsage?: Map<string, ResourceUsage>;
	isFullPage?: boolean;
	onOpenInlineDiff?: (request: TaskInlineDiffRequest) => void;
}

const COLLAPSED_HEIGHT_REM = 3.875;
const DEFAULT_HEIGHT = 200;
const MIN_HEIGHT = 80;
const MAX_RATIO = 0.33;

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

function TaskInfoPanel({ task, project, dispatch, navigate, taskPorts, taskResourceUsage, isFullPage, onOpenInlineDiff }: TaskInfoPanelProps) {
	const t = useT();
	const [collapsed, setCollapsed] = useState(() => readBool(LS_COLLAPSED, true));
	const [panelHeight, setPanelHeight] = useState(() => readNumber(LS_HEIGHT, DEFAULT_HEIGHT));
	const [copiedPath, setCopiedPath] = useState(false);
	const [statusMenuOpen, setStatusMenuOpen] = useState(false);
	const [statusMenuPos, setStatusMenuPos] = useState({ top: 0, left: 0 });
	const [statusMenuVisible, setStatusMenuVisible] = useState(false);
	const [movingStatus, setMovingStatus] = useState(false);
	const [spawnModalOpen, setSpawnModalOpen] = useState(false);
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
	const allocatedPorts = useTaskAllocatedPorts(task);
	const isTaskActive = ACTIVE_STATUSES.includes(task.status);

	useEffect(() => {
		setMetadataBranchState(null);
	}, [task.id]);

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
		if (task.worktreePath && (newStatus === "completed" || newStatus === "cancelled")) {
			setStatusMenuOpen(false);
			const proceed = await confirmTaskCompletion(task, project, newStatus, t);
			if (!proceed) {
				return;
			}
		}

		const fromStatus = task.status;
		setMovingStatus(true);
		setStatusMenuOpen(false);

		if (newStatus === "completed" || newStatus === "cancelled") {
			dispatch({
				type: "updateTask",
				task: {
					...task,
					status: newStatus,
					worktreePath: null,
					branchName: null,
					movedAt: new Date().toISOString(),
					columnOrder: undefined,
				},
			});
			dispatch({ type: "clearBell", taskId: task.id });
			trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
			navigate({ screen: "project", projectId: project.id });
			api.request.moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus,
			}).catch(() => {
				api.request.moveTask({
					taskId: task.id,
					projectId: project.id,
					newStatus,
					force: true,
				}).catch((err) => console.error("Background moveTask failed:", err));
			});
			return;
		}

		try {
			const updated = await api.request.moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus,
			});
			dispatch({ type: "updateTask", task: updated });
			trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
			if (!ACTIVE_STATUSES.includes(newStatus)) {
				navigate({ screen: "project", projectId: project.id });
			}
		} catch {
			try {
				const updated = await api.request.moveTask({
					taskId: task.id,
					projectId: project.id,
					newStatus,
					force: true,
				});
				dispatch({ type: "updateTask", task: updated });
				trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
				if (!ACTIVE_STATUSES.includes(newStatus)) {
					navigate({ screen: "project", projectId: project.id });
				}
			} catch (retryErr) {
				alert(t("task.failedMove", { error: String(retryErr) }));
			}
		}

		setMovingStatus(false);
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
			trackEvent("task_moved", { from_status: task.status, to_status: `custom:${customColumnId}` });
		} catch (err) {
			alert(t("task.failedMove", { error: String(err) }));
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
	const diffSummaryBadge = metadataBranchStatus && metadataBranchStatus.diffFiles > 0 ? (
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
				<span className="text-fg-muted text-[0.625rem] uppercase tracking-wider">
					{t("infoPanel.noTestsSuffix")}
				</span>
			)}
		</button>
	) : null;
	const diffIncludeTestsToggle = metadataBranchStatus && metadataBranchStatus.diffFiles > 0 ? (
		<button
			type="button"
			data-testid="diff-include-tests-toggle"
			onClick={() => setIncludeTests(!includeTests)}
			className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[0.6875rem] font-mono flex-shrink-0 transition-colors ${
				includeTests
					? "bg-elevated border-edge text-fg-2 hover:bg-elevated-hover"
					: "bg-accent/10 border-accent/30 text-accent hover:bg-accent/20"
			}`}
			title={t("infoPanel.diffIncludeTestsTooltip")}
		>
			<span
				className="text-[0.75rem] leading-none"
				style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
			>
				{includeTests ? "☑" : "☐"}
			</span>
			<span>{t("infoPanel.diffIncludeTests")}</span>
		</button>
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
						<button
							onClick={(event) => handleFileDiff(event, fileName)}
							aria-label={t("infoPanel.showDiff")}
							className="text-sm text-accent hover:text-accent-hover w-6 h-6 flex items-center justify-center rounded bg-accent/10 hover:bg-accent/20 transition-colors"
							title={t("infoPanel.showDiff")}
						>
							<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF4D2"}</span>
						</button>
						<button
							onClick={(event) => handleFileOpenIn(event, fileName)}
							aria-label={t("openIn.menuTitle")}
							className="text-sm text-fg-3 hover:text-fg-2 w-6 h-6 flex items-center justify-center rounded bg-raised hover:bg-elevated-hover transition-colors"
							title={t("openIn.menuTitle")}
						>
							<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0379}"}</span>
						</button>
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

	const watchToggleButton = (
		<button
			onClick={handleToggleWatch}
			className={`flex items-center gap-1.5 px-2 py-1 rounded-lg transition-colors flex-shrink-0 ${
				task.watched
					? "text-accent bg-accent/10 border border-accent/25"
					: "text-fg-3 hover:text-fg hover:bg-elevated"
			}`}
			title={task.watched ? t("task.unwatchTooltip") : t("task.watchTooltip")}
		>
			<span className="text-[0.875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
				{task.watched ? "\u{F009A}" : "\u{F0F1C}"}
			</span>
			<span className="text-[0.6875rem] font-medium">
				{task.watched ? t("task.watching") : t("task.watch")}
			</span>
		</button>
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
		<button
			onClick={() => setSpawnModalOpen(true)}
			className="flex items-center gap-1 px-2 py-1 rounded-lg transition-colors text-success hover:text-success-hover hover:bg-success/15 border border-success/30"
			title={t("tmux.spawnExtraAgentDesc")}
		>
			<span className="text-[1rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0313}"}</span>
			<span className="text-[0.6875rem] font-semibold whitespace-nowrap">{t("tmux.spawnExtraAgent")}</span>
		</button>
	) : null;

	const worktreeSettingsButton = task.worktreePath ? (
		<button
			onClick={() => navigate({ screen: "project-settings", projectId: project.id, tab: "worktree", worktreeTaskId: task.id })}
			className="flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
			title={t("projectSettings.tabWorktree")}
		>
			<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF013"}</span>
		</button>
	) : null;

	const height = collapsed ? `${COLLAPSED_HEIGHT_REM}rem` : panelHeight;

	return (
		<div
			ref={panelRef}
			className="flex-shrink-0 border-b border-edge glass-header overflow-hidden transition-[height] duration-200 ease-out"
			style={{ height }}
		>
			{diffFilesPopover}
			{fileOpenInMenuPortal}
			{collapsed ? (
				<div className="flex flex-col h-full px-4">
					<div className="flex items-center gap-1.5 min-w-0 pt-1">
						{watchToggleButton}
						{statusDropdownButton}
						{statusDropdownPortal}
						{diffSummaryBadge}
						{diffIncludeTestsToggle}
						{assignedLabels.map((label) => <LabelChip key={label.id} label={label} size="xs" />)}
						<div className="flex-1" />
						{spawnAgentButton}
						<TaskOpenIn task={task} project={project} isTaskActive={isTaskActive} showFileBrowser />
						<TaskTmuxControls taskId={task.id} />
						<TaskScripts task={task} project={project} isTaskActive={isTaskActive} />
						<TaskDevServer task={task} project={project} isTaskActive={isTaskActive} />
						{worktreeSettingsButton}
						<button
							onClick={() => isFullPage
								? navigate({ screen: "project", projectId: project.id, activeTaskId: task.id })
								: navigate({ screen: "task", projectId: project.id, taskId: task.id })
							}
							className="flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
							title={isFullPage ? t("infoPanel.exitFullScreen") : t("infoPanel.fullScreen")}
						>
							<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								{isFullPage
									? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4" />
									: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
								}
							</svg>
						</button>
						<button
							onClick={toggleCollapsed}
							className="flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
							title={t("infoPanel.expand")}
						>
							<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
							</svg>
						</button>
					</div>

					<div className="flex items-center gap-1.5 min-w-0 pb-1">
						<TaskGitActions
							task={task}
							project={project}
							dispatch={dispatch}
							navigate={navigate}
							isTaskActive={isTaskActive}
							showWorktreeCopy
							showLoading
							onBranchStatusChange={setMetadataBranchState}
							onOpenInlineDiff={onOpenInlineDiff}
						/>
					</div>
				</div>
			) : (
				<div className="flex flex-col h-full">
					<div className="flex flex-col px-4">
						<div className="flex items-center gap-1.5 min-w-0 pt-1">
							{watchToggleButton}
							{statusDropdownButton}
							{statusDropdownPortal}
							{diffSummaryBadge}
						{diffIncludeTestsToggle}
							{assignedLabels.map((label) => <LabelChip key={label.id} label={label} size="xs" />)}
							<div className="flex-1" />
							{spawnAgentButton}
							<TaskOpenIn task={task} project={project} isTaskActive={isTaskActive} showFileBrowser={false} />
							<TaskTmuxControls taskId={task.id} />
							<TaskScripts task={task} project={project} isTaskActive={isTaskActive} />
							<TaskDevServer task={task} project={project} isTaskActive={isTaskActive} />
							<button
								onClick={() => isFullPage
									? navigate({ screen: "project", projectId: project.id, activeTaskId: task.id })
									: navigate({ screen: "task", projectId: project.id, taskId: task.id })
								}
								className="flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
								title={isFullPage ? t("infoPanel.exitFullScreen") : t("infoPanel.fullScreen")}
							>
								<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									{isFullPage
										? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4" />
										: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
									}
								</svg>
							</button>
							<button
								onClick={toggleCollapsed}
								className="flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
								title={t("infoPanel.collapse")}
							>
								<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
								</svg>
							</button>
						</div>

						<div className="flex items-center gap-1.5 min-w-0 pb-1">
							<TaskGitActions
								task={task}
								project={project}
								dispatch={dispatch}
								navigate={navigate}
								isTaskActive={isTaskActive}
								branchNameClassName="text-fg-3 text-xs font-mono flex-shrink-0 truncate max-w-[12.5rem]"
								onBranchStatusChange={setMetadataBranchState}
								onOpenInlineDiff={onOpenInlineDiff}
							/>
						</div>
					</div>

					<div className="flex-1 overflow-auto px-4 pb-2">
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
										<button
											onClick={() => {
												navigator.clipboard.writeText(task.worktreePath!);
												setCopiedPath(true);
												setTimeout(() => setCopiedPath(false), 1500);
											}}
											className="flex-shrink-0 text-fg-muted hover:text-fg transition-colors"
											title={copiedPath ? t("infoPanel.pathCopied") : t("infoPanel.copyPath")}
										>
											<span className="text-[0.75rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
												{copiedPath ? "\u{F012C}" : "\uF0C5"}
											</span>
										</button>
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
											<button
												key={port.port}
												onClick={() => window.open(`http://localhost:${port.port}`, "_blank")}
												className="inline-flex items-center gap-1.5 text-xs font-mono text-accent bg-accent/10 hover:bg-accent/20 px-2 py-1 rounded-md transition-colors"
												title={`${port.processName} (PID ${port.pid}) — ${t("ports.openInBrowser")}`}
											>
												<span className="font-bold">:{port.port}</span>
												<span className="text-fg-muted text-[0.625rem]">{port.processName}</span>
											</button>
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
		</div>
	);
}

export default TaskInfoPanel;
