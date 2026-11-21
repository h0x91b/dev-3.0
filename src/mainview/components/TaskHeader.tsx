import { useState, useRef, useCallback, useEffect, type Dispatch, type MouseEvent as ReactMouseEvent } from "react";
import { TaskRefText } from "./TaskRefText";
import { toast } from "../toast";
import { toastClearanceRef } from "../toast-clearance";
import { confirm } from "../confirm";
import type { Task, Project, PortInfo, ResourceUsage, TaskPRBadgeInfo } from "../../shared/types";
import LabelChip from "./LabelChip";
import { formatDate } from "./NoteItem";
import { ACTIVE_STATUSES, getTaskTitle, resolveTaskCompareBaseBranch } from "../../shared/types";
import { earlierPullRequests, trustedPrStatusCache } from "../../shared/task-pull-requests";
import InlineRename from "./InlineRename";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { formatBytes } from "../utils/formatBytes";
import { prBadgeDisplayState, prStateTone } from "../utils/prStateTone";
import { inspectorPRBadge } from "../utils/taskPrBadge";
import { ImageAttachmentsStrip } from "./ImageAttachmentsStrip";
import TaskGitActionsSheet from "./task-info-panel/TaskGitActionsSheet";
import { useTaskBranchStatus } from "./task-info-panel/useTaskBranchStatus";
import TaskPrStatusPopover from "./TaskPrStatusPopover";
import {
	WorktreeSettingsIcon,
	FullscreenEnterIcon,
	FullscreenExitIcon,
	PanelChevronIcon,
	PanelLeftIcon,
} from "./TaskIcons";
import TaskNotes from "./task-info-panel/TaskNotes";
import TaskNotesOverlay from "./TaskNotesOverlay";
import TerminalShortcutsButton from "./task-info-panel/TerminalShortcutsButton";
import { useTaskAllocatedPorts } from "./task-info-panel/useTaskAllocatedPorts";
import type { TaskInlineDiffRequest } from "./task-inline-diff";
import { useCompact } from "../utils/useCompact";
import { useContainerWidth } from "../hooks/useContainerWidth";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { restoreControl } from "../hidden-controls";
import PanelRestoreControl, { type PanelHideableEntry } from "./task-info-panel/PanelRestoreControl";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import { TASK_HEADER_REGIONS } from "../task-header/registry";
import { taskHasGitBar } from "../task-header/builtin-git";
import { useTaskSessionController } from "../task-header/useTaskSession";
import { TaskHeaderProvider, TaskHeaderRegionItems } from "../task-header/scope";
import { SHEET_ROW_CLASS } from "../task-header/sheet-row";
import BottomSheet from "./BottomSheet";
import HelpSpot from "./HelpSpot";
import Tooltip from "./Tooltip";
import ForeignCodeMark from "./ForeignCodeMark";
import TaskOriginRow from "./TaskOriginRow";
import TaskCompletionStrip from "./task-info-panel/TaskCompletionStrip";
import TaskEpicRow from "./TaskEpicRow";
import { isMac } from "../utils/platform";
import { terminalFullscreenShortcutLabel } from "../utils/terminalFullscreen";

interface TaskHeaderProps {
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


// The 2×2 bar grid is sized by the panel's own width, not the viewport: in split
// view the board eats most of a 1100px window, so the bars go tight while
// `useCompact` (1600) still reports "roomy". Below this the branch name clamps
// harder, keeping both rows on one line.
const TIGHT_PANEL_WIDTH = 1280;

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

function TaskHeaderFrame({
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
}: TaskHeaderProps) {
	const t = useT();
	const compact = useCompact();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [actionsSheetOpen, setActionsSheetOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(() => readBool(LS_COLLAPSED, true));
	const [panelHeight, setPanelHeight] = useState(() => readNumber(LS_HEIGHT, DEFAULT_HEIGHT));
	const [copiedPath, setCopiedPath] = useState(false);
	const [notesOverlayOpen, setNotesOverlayOpen] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const setPanelRef = useCallback((node: HTMLDivElement | null) => {
		panelRef.current = node;
		const release = toastClearanceRef(node);
		return () => {
			release?.();
			panelRef.current = null;
		};
	}, []);
	const panelWidth = useContainerWidth(panelRef);
	const tight = panelWidth > 0 && panelWidth < TIGHT_PANEL_WIDTH;
	const dragging = useRef(false);
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
	// screen (sidebar hidden) this brings the Active Tasks panel back. Leads the
	// git row, at the left edge where the sidebar it restores will reappear.
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
	// Lives on the ops row (next to the ports/artifacts chips), immediately left of
	// the panel collapse chevron — it is a view control, not a session action.
	const terminalFullscreenButton = (
		<Tooltip content={terminalFullscreenLabel} detail={terminalFullscreenTooltip}>
			<button
				onClick={toggleTerminalFullscreen}
				className="task-anim flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
				aria-label={terminalFullscreenLabel}
			>
				{terminalFullscreenActive
					? <FullscreenExitIcon className="w-3.5 h-3.5" />
					: <FullscreenEnterIcon className="w-3.5 h-3.5" />}
			</button>
		</Tooltip>
	);
	const allocatedPorts = useTaskAllocatedPorts(task);
	const isTaskActive = ACTIVE_STATUSES.includes(task.status);
	// An Operations task gets the diff (never the write actions) once a repo is attached;
	// a project with the git workflow off gets none. Scripts and the dev server need neither.
	const hasGit = taskHasGitBar(project, task);
	// The header's one branch-status instance, shared through the scope: the Git bar's
	// items and the narrow sheet's rows act on it, and the Context bar's diff badge reads
	// it. It also owns the merge completion prompt, so it must never run twice.
	const git = useTaskBranchStatus({
		task,
		project,
		dispatch,
		navigate,
		isTaskActive,
		enabled: hasGit,
	});
	// The session bar's dialogs and hibernation, shared by its items, its sheet rows and
	// the restore control (chrome).
	const session = useTaskSessionController({ task, project, dispatch });
	const variantMembers = task.groupId
		? tasks.filter((candidate) => candidate.groupId === task.groupId)
		: [];

	// Crossing the narrow breakpoint must not strand an open actions sheet.
	useEffect(() => {
		if (!narrow) setActionsSheetOpen(false);
	}, [narrow]);

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

	const openUnresolvedInDiff = onOpenInlineDiff
		? () => onOpenInlineDiff({
			mode: "branch",
			compareRef: branchMeta?.compareRef,
			compareLabel: branchMeta?.compareLabel ?? project.defaultCompareRef ?? resolveTaskCompareBaseBranch(task, project),
			focusFirstUnresolvedThread: true,
		})
		: undefined;

	const branchMeta = hasGit
		? {
			branchStatus: git.branchStatus,
			prStatus: git.prStatus,
			compareRef: git.compareRef || undefined,
			compareLabel: git.displayRef,
		}
		: null;
	const metadataBranchStatus = branchMeta?.branchStatus ?? null;
	const metadataPrInfo: TaskPRBadgeInfo | null = inspectorPRBadge(task, branchMeta?.prStatus, metadataBranchStatus);
	const metadataPrState = metadataPrInfo ? prBadgeDisplayState(metadataPrInfo, metadataBranchStatus, trustedPrStatusCache(task)) : undefined;
	const metadataPrTone = metadataPrState ? prStateTone(metadataPrState) : null;

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

	// Entries for the panel's one restore control (PanelRestoreControl filters
	// to whichever of these are actually hidden right now, and groups them by
	// bar). Row click runs the same action the visible control would; the
	// three multi-action surfaces (pane layout, scripts, dev-server setup)
	// have no single atomic action, so their row restores instead.
	const panelHideableEntries: PanelHideableEntry[] = [
		{ id: "spawn-agent", label: t("tmux.spawnExtraAgent"), onRun: session.openSpawnAgent },
		{ id: "bug-hunters", label: t("bugHunters.buttonLabel"), onRun: session.openBugHunters },
		{ id: "hibernate", label: t("task.hibernateShort"), onRun: () => { void session.hibernate(); } },
		{ id: "scheduled-message", label: t("task.sendLaterShort"), onRun: session.openScheduleMessage },
		{ id: "tmux-pane-controls", label: t("infoPanel.paneControlsLabel"), onRun: () => restoreControl("tmux-pane-controls") },
		{ id: "scripts-runner", label: t("infoPanel.scriptsRunnerLabel"), onRun: () => restoreControl("scripts-runner") },
		{ id: "setup-dev-server", label: t("header.setupDevServer"), onRun: () => restoreControl("setup-dev-server") },
		{ id: "diff-include-tests", label: t("infoPanel.includeTestsLabel"), onRun: () => restoreControl("diff-include-tests") },
	];

	const worktreeSettingsButton = task.worktreePath ? (
		<Tooltip content={t("projectSettings.tabWorktree")} detail={t("ttip.infoPanel.worktreeConfig")}>
			<button
				onClick={() => navigate({ screen: "project-settings", projectId: project.id, tab: "worktree", worktreeTaskId: task.id })}
				className="task-anim flex-shrink-0 px-1.5 py-1 rounded border border-edge hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
				aria-label={t("projectSettings.tabWorktree")}
			>
				<WorktreeSettingsIcon className="w-4 h-4" />
			</button>
	</Tooltip>
	) : null;

	// A function, not an element: collapsed (the default) never shows it, so it is built only when drawn.
	const taskDetailsBody = () => (
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
											className="flex-shrink-0 rounded border border-edge px-1.5 py-0.5 text-dense text-fg-3 hover:bg-elevated hover:text-fg transition-colors"
										>
											{t("infoPanel.foreignCodeOwn")}
										</button>
									</span>
								</>
							)}

							{metadataPrInfo && (
								<>
									<span className="text-fg-3">{t("infoPanel.pullRequest")}</span>
									<TaskPrStatusPopover prInfo={metadataPrInfo} projectId={project.id} taskId={task.id} onShowUnresolved={openUnresolvedInDiff} earlierPullRequests={earlierPullRequests(task)} displayState={metadataPrState}>
										<button
											type="button"
											onClick={() => metadataPrInfo.url && window.open(metadataPrInfo.url, "_blank")}
											className={`inline-flex items-center gap-1.5 font-mono font-semibold hover:underline text-left ${metadataPrTone?.text ?? "text-fg-3"}`}
										>
											<span>{t("task.prBadge", { number: String(metadataPrInfo.number) })}</span>
											{metadataPrTone?.labelKey && <span className="sr-only">{` — ${t(metadataPrTone.labelKey)}`}</span>}
											{(metadataPrInfo.unresolvedCount ?? 0) > 0 && (
												<span className="inline-flex items-center gap-0.5 text-warning-strong no-underline" aria-label={t.plural("task.prUnresolvedComments", metadataPrInfo.unresolvedCount ?? 0)}>
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
										<span className="text-fg-2 whitespace-pre-wrap"><TaskRefText text={task.description} contextProjectId={task.projectId} taskId={task.id} /></span>
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

							<TaskOriginRow task={task} navigate={navigate} testId="info-panel-origin" />
							<TaskEpicRow task={task} testId="info-panel-epic" />

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

						<TaskNotes
							task={task}
							project={project}
							dispatch={dispatch}
							onShowAll={() => {
								// Narrow reaches the preview from inside the actions sheet;
								// the log replaces it rather than stacking a second sheet.
								setActionsSheetOpen(false);
								setNotesOverlayOpen(true);
							}}
						/>
		</>
	);

	const height = collapsed ? `${COLLAPSED_HEIGHT_REM}rem` : panelHeight;

	// Ends the Runtime bar (right of Images / Artifacts) instead of sitting in the
	// panel chrome above: it is the rarest control up there, and crowding it next
	// to Full screen made the two easy to confuse.
	const collapseToggleButton = (
		<Tooltip
			content={collapsed ? t("infoPanel.expand") : t("infoPanel.collapse")}
			detail={collapsed ? t("ttip.infoPanel.expand") : t("ttip.infoPanel.collapse")}
		>
			<button
				onClick={toggleCollapsed}
				className="task-anim flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
				aria-label={collapsed ? t("infoPanel.expand") : t("infoPanel.collapse")}
			>
				<PanelChevronIcon direction={collapsed ? "down" : "up"} className="w-3.5 h-3.5" />
			</button>
		</Tooltip>
	);

	const headerValue = {
		scope: { task, project, dispatch, navigate },
		layout: { compact, tight, collapsed, narrow },
		isTaskActive,
		git,
		session,
		onOpenInlineDiff,
		closeSheet: () => setActionsSheetOpen(false),
		variants: variantMembers,
		isFullPage,
	};

	// Narrow viewport (phone / narrow window): the two dense desktop toolbars do
	// not fit. Collapse them into a thin summary bar (status + title + diff) and
	// fold every action + the full details grid into an actions BottomSheet — the
	// same kebab→sheet pattern used in the global header.
	if (narrow) {
		return (
			<TaskHeaderProvider value={headerValue}>
				<div ref={toastClearanceRef} className="flex-shrink-0 border-b border-edge glass-header">
					{/* The bar sheds, it never stacks (bible §12.6). A second row costs a
					    phone a whole band of screen and moves every control the user was
					    aiming at — worse than losing the least important one. Priority,
					    lowest first: diff badge → artifacts → images → the status label.
					    Thresholds are container queries in PX, not rem: the 0.67× phone
					    factor makes 1rem ≈ 10.7px, so rem thresholds fire ~1.5× too late.
					    Everything shed keeps a row in the actions sheet. */}
					<div className="flex flex-nowrap items-center gap-x-2 px-3 py-2 min-h-[3.25rem] min-w-0 [container-type:inline-size]" data-testid="task-summary-bar">
						{/* No Git items here: on a phone they live in the sheet's Git section. */}
						{TASK_HEADER_REGIONS.filter((region) => region !== "git").map((region) => <TaskHeaderRegionItems key={region} region={region} />)}
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
						<div className="touch-actions flex flex-col gap-2">
							<button
								type="button"
								data-testid="task-actions-fullscreen"
								onClick={() => {
									setActionsSheetOpen(false);
									toggleTerminalFullscreen();
								}}
								className={SHEET_ROW_CLASS}
							>
								<FullscreenEnterIcon className="h-5 w-5 shrink-0 text-fg-3" />
								<span className="flex-1 text-sm font-medium">{t("infoPanel.fullScreen")}</span>
							</button>
							{/* Session closes the group: its last row is the one that stops the session. */}
							<TaskHeaderRegionItems region="status" surface="sheet" />
							<TaskHeaderRegionItems region="runtime" surface="sheet" />
							<TaskHeaderRegionItems region="session" surface="sheet" />
						</div>
						<TaskGitActionsSheet rowClassName={SHEET_ROW_CLASS} onAction={() => setActionsSheetOpen(false)} />
							<section className="border-t border-edge pt-4">
								<h3 className="mb-2 text-dense font-semibold uppercase tracking-wider text-fg-muted">{t("infoPanel.sheetDetails")}</h3>
								{taskDetailsBody()}
							</section>
						</div>
					</BottomSheet>

					{session.dialogs}
					{notesOverlayOpen && (
						<TaskNotesOverlay task={task} project={project} dispatch={dispatch} onClose={() => setNotesOverlayOpen(false)} />
					)}
				</div>
		</TaskHeaderProvider>
		);
	}

	return (
		<TaskHeaderProvider value={headerValue}>
			<div
				ref={setPanelRef}
				className="flex-shrink-0 border-b border-edge glass-header overflow-hidden transition-[height] duration-200 ease-out"
				style={{ height }}
			>
				{/* One tree for both states: a toggle changes classes, never element positions,
				    so the bars and their controls stay mounted (decisions/2026/11/21/task-header-single-tree.md). */}
				<div className={collapsed ? "flex flex-col h-full px-2 gap-1 justify-center" : "flex flex-col h-full"}>
					<div className={collapsed ? "contents" : "flex flex-col px-2"}>
						<div className={`flex items-center gap-1.5 min-w-0${collapsed ? "" : " pt-1"}`}>
							{/* `overflow-hidden` is the backstop that keeps a bar's contents
							    inside its own box: without it the shrink-0 children spill
							    over the neighbouring bar and over the pinned chrome (which
							    then becomes unclickable). `tight` folds content first, so
							    clipping only happens at pathological widths. */}
							<div className="flex items-center gap-1.5 min-w-0 overflow-hidden" data-help-id="inspector.context-bar">
								<TaskHeaderRegionItems region="status" />
							</div>
							<div className="flex-1" />
							<div className="flex items-center gap-1.5 flex-shrink-0" data-help-id="inspector.session-bar">
								<TaskHeaderRegionItems region="session" />
							</div>
							{/* Keep in place, even when empty: it holds the index of the controls after it. */}
							{collapsed && worktreeSettingsButton}
							<PanelRestoreControl entries={panelHideableEntries} />
							<HelpSpot topicId="inspector.panel" className="ml-0.5" />
							<TerminalShortcutsButton taskId={task.id} />
						</div>

						<div className={`flex items-center gap-1.5 min-w-0${collapsed ? "" : " pb-1"}`}>
							{showPanelButton}
							<div className="flex items-center gap-1.5 min-w-0 overflow-hidden" data-help-id="inspector.git-bar" data-tour-anchor="task.git-bar">
								<TaskHeaderRegionItems region="git" />
							</div>
							<div className="flex-1" />
							<div className="flex items-center gap-2 flex-shrink-0" data-help-id="inspector.runtime-bar">
								<TaskHeaderRegionItems region="runtime" />
								{terminalFullscreenButton}
								{collapseToggleButton}
							</div>
						</div>
					</div>

					{!collapsed && (
						<div className="flex-1 overflow-auto px-2 pb-2">
							{taskDetailsBody()}
						</div>
					)}

					{!collapsed && (
						<div
							className="flex-shrink-0 flex items-center justify-center h-[6px] cursor-row-resize group"
							onMouseDown={onDragStart}
							onDoubleClick={toggleCollapsed}
						>
							<div className="w-8 h-[3px] rounded-full bg-fg-muted/60 group-hover:bg-fg-muted/80 transition-colors" />
						</div>
					)}
				</div>

				{session.dialogs}

				{notesOverlayOpen && (
					<TaskNotesOverlay task={task} project={project} dispatch={dispatch} onClose={() => setNotesOverlayOpen(false)} />
				)}
			</div>
		</TaskHeaderProvider>
	);
}

/**
 * The task header: four bars rendered from the `taskHeader` slot plus pinned chrome,
 * and the task's pending completion offer right under it.
 */
function TaskHeader(props: TaskHeaderProps) {
	return (
		<>
			<TaskHeaderFrame {...props} />
			<TaskCompletionStrip task={props.task} project={props.project} />
		</>
	);
}

export default TaskHeader;
