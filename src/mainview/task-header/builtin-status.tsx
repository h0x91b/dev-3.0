import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type MouseEvent as ReactMouseEvent } from "react";
import type { TaskCompletionOwner, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, getAllowedTransitions, isCoordinatorTask, resolveTaskCompareBaseBranch, taskCompletionOwner } from "../../shared/types";
import { isTestFile } from "../../shared/test-files";
import { getTaskOpenMode, taskClosedHomeRoute } from "../state";
import { api } from "../rpc";
import { useT, type TranslationKey } from "../i18n";
import { toast } from "../toast";
import { confirm } from "../confirm";
import { trackEvent, agentNameFromId } from "../analytics";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import { getStatusLabel } from "../utils/statusLabel";
import { useIncludeTestsInDiff } from "../utils/includeTestsInDiff";
import { useIsControlHidden } from "../hooks/useIsControlHidden";
import Tooltip from "../components/Tooltip";
import BottomSheet from "../components/BottomSheet";
import OpenInMenu from "../components/OpenInMenu";
import PriorityBadge from "../components/PriorityBadge";
import PipelineRing, { CompleteCheckIcon } from "../components/PipelineRing";
import PipelineDropdown from "../components/PipelineDropdown";
import CompletionOwnerMenu from "../components/CompletionOwnerMenu";
import VariantSwitcher from "../components/VariantSwitcher";
import TaskSharedImages from "../components/task-info-panel/TaskSharedImages";
import TaskArtifacts from "../components/task-info-panel/TaskArtifacts";
import { IncludeTestsIcon, ShowDiffIcon } from "../components/task-info-panel/GitIcons";
import { CompletionOwnerIcon, WatchIcon, WatchingIcon } from "../components/TaskIcons";
import type { SlotItemProps } from "../plugins/SlotItems";
import type { TaskHeaderItem, TaskHeaderScope } from "./registry";
import { taskHasGitBar } from "./builtin-git";
import { TaskHeaderRegionItems, useTaskHeaderInternals, useTaskHeaderScope, useTaskHeaderSurface } from "./scope";
import { SHEET_ROW_CLASS } from "./sheet-row";

/**
 * The Context bar (bible §5.1, panel 1) as built-in items. Each item draws its desktop
 * bar form, its narrow summary-bar form and its sheet row, or nothing where it has none.
 * The task's pending completion offer under the header stays host chrome.
 */

// --- placement -------------------------------------------------------------------------

type Placement = "desktop" | "narrow" | "sheet";

function usePlacement(): Placement {
	const surface = useTaskHeaderSurface();
	const { layout } = useTaskHeaderInternals();
	if (surface === "sheet") return "sheet";
	return layout.narrow ? "narrow" : "desktop";
}

// --- items -----------------------------------------------------------------------------

/** Leads the bar on every width; renders nothing below two alive variants. */
function VariantSwitcherItem() {
	const { task, project, navigate } = useTaskHeaderScope();
	const { variants, isFullPage } = useTaskHeaderInternals();
	if (usePlacement() === "sheet") return null;
	return <VariantSwitcher variants={variants} currentTaskId={task.id} projectId={project.id} isFullPage={isFullPage} navigate={navigate} />;
}

function useToggleWatch() {
	const { task, project, dispatch } = useTaskHeaderScope();
	return async (event: ReactMouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		try {
			const updated = await api.request.toggleTaskWatch({ taskId: task.id, projectId: project.id, watched: !task.watched });
			dispatch({ type: "updateTask", task: updated });
		} catch {
			// Secondary action. Failing quietly is fine.
		}
	};
}

function WatchItem() {
	const t = useT();
	const { task } = useTaskHeaderScope();
	const placement = usePlacement();
	const toggleWatch = useToggleWatch();
	if (placement === "sheet") {
		return (
			<button
				type="button"
				onClick={toggleWatch}
				aria-pressed={task.watched}
				className={`${SHEET_ROW_CLASS} ${task.watched ? "border-accent/30 bg-accent/10" : ""}`}
			>
				{task.watched
					? <WatchingIcon className="h-5 w-5 shrink-0 text-accent" />
					: <WatchIcon className="h-5 w-5 shrink-0 text-fg-3" />}
				<span className="flex-1 text-sm font-medium">{task.watched ? t("task.watching") : t("task.watch")}</span>
			</button>
		);
	}
	if (placement === "narrow") return null;
	const label = task.watched ? t("task.unwatchTooltip") : t("task.watchTooltip");
	return (
		<Tooltip content={label} detail={t("ttip.task.watch")}>
			<button
				onClick={toggleWatch}
				className={`task-anim flex items-center gap-1.5 px-2 py-1 rounded-lg transition-colors flex-shrink-0 ${
					task.watched
						? "text-accent bg-accent/10 border border-accent/25"
						: "text-fg-3 hover:text-fg hover:bg-elevated"
				}`}
				aria-label={label}
			>
				{/* Icon only, at every width: the accent bell already says "watching", and
					the word cost bar space the tags and the status chip need more. The
					sentence stays in the tooltip and in the mobile sheet row. */}
				{task.watched
					? <WatchingIcon className="w-[0.95rem] h-[0.95rem]" />
					: <WatchIcon className="w-[0.95rem] h-[0.95rem]" />}
			</button>
		</Tooltip>
	);
}

function useSetPriority() {
	const t = useT();
	const { task, project, dispatch } = useTaskHeaderScope();
	return async (priority: TaskHeaderScope["task"]["priority"]) => {
		if (!priority) return;
		try {
			const changed = await api.request.setTaskPriority({ taskId: task.id, projectId: project.id, priority });
			for (const changedTask of changed) {
				dispatch({ type: "updateTask", task: changedTask });
			}
		} catch (err) {
			toast.error(t("priority.failedSet", { error: String(err) }), { taskId: task.id });
		}
	};
}

/** The desktop badge; on narrow the status item draws priority beside status, as one band. */
function PriorityItem() {
	const { task } = useTaskHeaderScope();
	const setPriority = useSetPriority();
	if (usePlacement() !== "desktop") return null;
	return <PriorityBadge priority={task.priority} onChange={setPriority} className="shrink-0" />;
}

/** The status dropdown with its quick-complete ✓ split; on narrow its menu is a BottomSheet. */
function StatusItem() {
	const t = useT();
	const { task, project, dispatch, navigate } = useTaskHeaderScope();
	const { layout } = useTaskHeaderInternals();
	const placement = usePlacement();
	const setPriority = useSetPriority();
	const { narrow, tight } = layout;
	const [menuOpen, setMenuOpen] = useState(false);
	const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
	const [menuVisible, setMenuVisible] = useState(false);
	const [movingStatus, setMovingStatus] = useState(false);
	const [quickCompleting, setQuickCompleting] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
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

	// Crossing the narrow breakpoint must not strand an open menu — it renders as a
	// sheet on narrow and an anchored popover on desktop.
	useEffect(() => {
		setMenuOpen(false);
	}, [narrow]);

	useEffect(() => {
		if (!menuOpen) return;
		function handleClick(event: MouseEvent) {
			if (
				menuRef.current &&
				!menuRef.current.contains(event.target as Node) &&
				triggerRef.current &&
				!triggerRef.current.contains(event.target as Node)
			) {
				setMenuOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [menuOpen]);

	useLayoutEffect(() => {
		if (!menuOpen || !menuRef.current || !triggerRef.current) return;
		const menu = menuRef.current.getBoundingClientRect();
		const trigger = triggerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;
		let top = trigger.bottom + 6;
		let left = trigger.left;
		if (top + menu.height > vh - pad) top = trigger.top - menu.height - 6;
		if (left + menu.width > vw - pad) left = vw - menu.width - pad;
		if (left < pad) left = pad;
		if (top < pad) top = pad;
		setMenuPos({ top, left });
		setMenuVisible(true);
	}, [menuOpen]);

	if (placement === "sheet") return null;

	function toggleMenu(event: ReactMouseEvent<HTMLButtonElement>) {
		event.stopPropagation();
		if (!menuOpen && triggerRef.current) {
			const rect = triggerRef.current.getBoundingClientRect();
			setMenuPos({ top: rect.bottom + 6, left: rect.left });
			setMenuVisible(false);
		}
		setMenuOpen((open) => !open);
	}

	async function moveTo(newStatus: TaskStatus, opts?: { alwaysConfirm?: boolean }) {
		setMenuOpen(false);
		const terminal = newStatus === "completed" || newStatus === "cancelled";
		const openTaskFromDialog = () => {
			navigate(getTaskOpenMode() === "fullscreen"
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
			// Terminal moves keep the optimistic completion on failure; other moves
			// revert and toast if the RPC fails.
			revertOnFailure: !terminal,
			onMovingChange: terminal ? undefined : (moving) => setMovingStatus(moving),
			// Land on the user's home surface: fullscreen open-mode → the board, split
			// open-mode → the split task view with nothing selected. Non-terminal moves
			// wait for the server, so a reverted move doesn't kick the user off the task.
			afterOptimistic: terminal && leaveScreen ? navigateHomeIfTaskStillSelected : undefined,
			onSuccess: !terminal && leaveScreen ? navigateHomeIfTaskStillSelected : undefined,
		});
	}

	// Acknowledge the ✓ on the same tick — its dialog still has a git check
	// streaming in, so silence here reads as a dead button.
	async function quickComplete() {
		setQuickCompleting(true);
		try {
			await moveTo("completed", { alwaysConfirm: true });
		} finally {
			setQuickCompleting(false);
		}
	}

	async function moveToCustomColumn(customColumnId: string) {
		setMovingStatus(true);
		setMenuOpen(false);
		try {
			const updated = await api.request.moveTaskToCustomColumn({ taskId: task.id, projectId: project.id, customColumnId });
			dispatch({ type: "updateTask", task: updated });
			trackEvent("task_moved", { from_status: task.status, to_status: `custom:${customColumnId}`, agent_name: agentNameFromId(task.agentId) });
		} catch (err) {
			toast.error(t("task.failedMove", { error: String(err) }), { taskId: task.id });
		}
		setMovingStatus(false);
	}

	const activeCustomColumn = task.customColumnId
		? (project.customColumns ?? []).find((column) => column.id === task.customColumnId)
		: null;
	// On narrow the chip is a primary touch target (≥44px, §12.6) and the one shrinkable
	// region of a no-wrap bar. Boxed like its neighbours so the ✓ reads as a segment of
	// the status control: the border owns the group, the hairline divides the targets.
	const showQuickComplete = !narrow && !movingStatus && getAllowedTransitions(task.status).includes("completed");
	const dropdown = (
		<PipelineDropdown
			currentStatus={task.status}
			onMove={moveTo}
			onMoveToCustomColumn={moveToCustomColumn}
			customColumns={project.customColumns}
			currentCustomColumnId={task.customColumnId}
			project={project}
			{...(narrow ? { size: "touch" as const, hideHeader: true } : {})}
		/>
	);
	return (
		<>
			<div className={`flex items-center rounded-lg border border-edge hover:border-edge-active transition-colors ${tight || narrow ? "min-w-0 shrink" : "flex-shrink-0"}`}>
				<button
					ref={triggerRef}
					onClick={toggleMenu}
					disabled={movingStatus}
					className={`flex min-w-0 items-center gap-2 transition-colors hover:bg-elevated ${showQuickComplete ? "rounded-l-lg" : "rounded-lg"} ${narrow ? "px-3 min-h-[2.75rem]" : "px-2.5 py-1"}`}
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
						plus the chevron still read as "status, tap to change". `sr-only` keeps it announced. */}
					<span className={`font-medium text-fg-2 truncate ${narrow ? "text-sm [@container(max-width:299px)]:sr-only" : "text-micro"}`}>
						{activeCustomColumn ? activeCustomColumn.name : getStatusLabel(task.status, t, project)}
					</span>
					<svg className={`flex-shrink-0 text-fg-3 ${narrow ? "w-4 h-4" : "w-3 h-3"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
					</svg>
				</button>
				{showQuickComplete && (
					<>
						<span className="h-4 w-px flex-shrink-0 bg-edge" aria-hidden="true" />
						<Tooltip content={t("pipeline.completeTooltip")} disabled={quickCompleting}>
							<button
								data-testid="task-info-quick-complete"
								onClick={quickComplete}
								disabled={quickCompleting}
								aria-label={t("pipeline.completeTooltip")}
								className={`task-anim flex flex-shrink-0 items-center justify-center self-stretch rounded-r-lg px-1.5 text-success transition-[color,background-color,opacity] ${
									quickCompleting ? "bg-success/25 opacity-100" : "opacity-75 hover:bg-success/20 hover:opacity-100"
								}`}
							>
								{quickCompleting ? (
									<span className="h-3 w-3 animate-spin rounded-full border-2 border-success/30 border-t-success" />
								) : (
									<CompleteCheckIcon className="w-3 h-3" />
								)}
							</button>
						</Tooltip>
					</>
				)}
			</div>
			{narrow ? (
				<>
					{/* Priority sits with status (§5.1); `touch` matches the status control's
						height so the pair reads as one band and clears the 44px target (§12.6). */}
					<PriorityBadge priority={task.priority} onChange={setPriority} size="touch" className="shrink-0" />
					{/* An anchored popover is a desktop idiom: the manifest mandates a BottomSheet for "Move to". */}
					<BottomSheet open={menuOpen} onClose={() => setMenuOpen(false)} title={t("task.moveTo")} testId="task-status-sheet">
						{dropdown}
					</BottomSheet>
				</>
			) : menuOpen && createPortal(
				<div
					ref={menuRef}
					className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[11.25rem]"
					style={{ top: menuPos.top, left: menuPos.left, visibility: menuVisible ? "visible" : "hidden" }}
					onClick={(event) => event.stopPropagation()}
				>
					{dropdown}
				</div>,
				document.body,
			)}
		</>
	);
}

/**
 * Agent outputs ride the narrow summary bar next to priority, not only the sheet: they
 * are conditional, and an unread one has to be seen without opening a menu (bible §12.6).
 * The desktop bar and the sheet draw them as runtime items.
 */
function NarrowOutputsItem() {
	const { task, project } = useTaskHeaderScope();
	if (usePlacement() !== "narrow") return null;
	return (
		<span className="hidden [@container(min-width:340px)]:contents">
			<TaskSharedImages task={task} projectId={project.id} compact touch />
			<TaskArtifacts task={task} projectId={project.id} compact touch />
		</span>
	);
}

/**
 * One control, three owners: dev3 suggests → I decide → the agent closes it → back. A
 * menu, never a click-to-cycle: no habitual click may land on the owner that lets the
 * agent destroy the worktree, and picking that one is confirmed.
 */
function CompletionOwnerItem() {
	const t = useT();
	const { task, project, dispatch } = useTaskHeaderScope();
	const { layout } = useTaskHeaderInternals();
	const placement = usePlacement();
	const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
	if (placement === "narrow") return null;

	function openMenu(event: ReactMouseEvent<HTMLButtonElement>) {
		event.stopPropagation();
		if (isCoordinatorTask(task)) return;
		const anchor = event.currentTarget;
		setMenuAnchor((open) => (open ? null : anchor));
	}

	async function selectOwner(owner: TaskCompletionOwner) {
		setMenuAnchor(null);
		if (owner === taskCompletionOwner(task)) return;
		if (owner === "agent") {
			const granted = await confirm({
				title: t("task.selfCompletionConfirmTitle"),
				message: t("task.selfCompletionConfirmMessage"),
				confirmLabel: t("task.selfCompletionConfirmAction"),
				danger: true,
				focusCancel: true,
			});
			if (!granted) return;
		}
		try {
			const updated = await api.request.setTaskCompletionOwner({ taskId: task.id, projectId: project.id, owner });
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			toast.error(t("task.manualCompletionChangeFailed", { error: String(err) }), { taskId: task.id });
		}
	}

	// A coordinator owns its completion unconditionally (`taskCompletesManually`), so the
	// control shows it on and refuses the click instead of offering an ignored toggle.
	const forced = isCoordinatorTask(task);
	const owner = taskCompletionOwner(task);
	const isAgent = owner === "agent";
	// "Held": dev3 no longer suggests completing it — you decide, or the agent does.
	const isManual = owner !== "dev3";
	const ownerLabel = isAgent ? t("task.selfCompletionEnabled") : t("task.manualCompletionEnabled");
	const menu = menuAnchor && (
		<CompletionOwnerMenu selected={owner} anchorEl={menuAnchor} onClose={() => setMenuAnchor(null)} onSelect={selectOwner} />
	);

	if (placement === "sheet") {
		return (
			<>
				<button
					type="button"
					onClick={openMenu}
					aria-haspopup="menu"
					aria-expanded={menuAnchor !== null}
					disabled={forced}
					aria-pressed={isManual}
					className={`${SHEET_ROW_CLASS} ${isManual ? "warning-paper border-warning/30 bg-warning/10 text-warning-strong" : ""} ${forced ? "cursor-not-allowed opacity-60" : ""}`}
				>
					<CompletionOwnerIcon className={`h-5 w-5 shrink-0 ${isManual ? "text-warning-strong" : "text-fg-3"}`} active={isManual} agent={isAgent} />
					<span className="flex-1 min-w-0">
						<span className="block text-sm font-medium">{isManual ? ownerLabel : t("task.manualCompletion")}</span>
						{/* A phone has no tooltip, so the row itself carries the
							consequence — the thing that reads as a bug when unsaid. */}
						{isManual && (
							<span className="block text-micro font-normal leading-snug opacity-80">
								{forced
									? t("task.manualCompletionCoordinatorTooltip")
									: isAgent
										? t("task.selfCompletionConsequence")
										: t("task.manualCompletionConsequence")}
							</span>
						)}
					</span>
				</button>
				{menu}
			</>
		);
	}

	const ownerName = forced
		? t("task.manualCompletionCoordinatorTooltip")
		: isAgent
			? t("task.selfCompletionEnabledTooltip")
			: isManual ? t("task.manualCompletionEnabledTooltip") : t("task.manualCompletionTooltip");
	return (
		<>
			<Tooltip content={ownerName} detail={t("ttip.task.manualCompletion")}>
				<button
					onClick={openMenu}
					aria-haspopup="menu"
					aria-expanded={menuAnchor !== null}
					disabled={forced}
					aria-label={ownerName}
					aria-pressed={isManual}
					data-testid="task-completion-owner"
					className={`task-anim flex items-center gap-1.5 px-2 py-1 rounded-lg transition-colors flex-shrink-0 ${
						isManual
							? "warning-paper text-warning-strong hover:bg-warning/15 border border-warning/30"
							: "text-fg-3 hover:text-fg hover:bg-elevated border border-edge"
					} ${forced ? "cursor-not-allowed" : ""}`}
				>
					{/* Amber, not accent: blue is "a toggle is on" (the watch bell), and the
						state read as a bug. Yellow is this bar's "deliberate hold", never an
						error or a finished task. Off stays grey and wordless. */}
					<CompletionOwnerIcon className="h-[0.95rem] w-[0.95rem]" active={isManual} agent={isAgent} />
					{/* Colour never carries the state alone: a roomy bar spells the mode out in
						the merge dialog's words; tight folds it back to the icon. */}
					{isManual && !layout.tight && (
						<span className="text-micro font-semibold whitespace-nowrap">{ownerLabel}</span>
					)}
				</button>
			</Tooltip>
			{menu}
		</>
	);
}

// --- the diff summary ------------------------------------------------------------------

/**
 * The branch's committed diff as the badge counts it, read from the header's one branch
 * status. Test files drop out unless the user includes them; without per-file stats there
 * is nothing to subtract, so the raw totals stand instead of collapsing to zero.
 */
function useDiffSummary() {
	const t = useT();
	const { task, project } = useTaskHeaderScope();
	const { git, layout } = useTaskHeaderInternals();
	const [includeTests, setIncludeTests] = useIncludeTestsInDiff();
	const testsToggleHidden = useIsControlHidden("builtin:status.include-tests");
	const hasGit = taskHasGitBar(project, task);
	const status = hasGit ? git.branchStatus : null;
	const compareRef = hasGit ? git.compareRef || undefined : undefined;
	const compareLabel = (hasGit ? git.displayRef : undefined) ?? project.defaultCompareRef ?? resolveTaskCompareBaseBranch(task, project);
	const allStats = status?.diffFileStats ?? [];
	const showRawTotals = includeTests || allStats.length === 0;
	const visibleStats = includeTests ? allStats : allStats.filter((entry) => !isTestFile(entry.path));
	const excludedTestCount = allStats.length - visibleStats.length;
	const files = showRawTotals ? (status?.diffFiles ?? 0) : visibleStats.length;
	const insertions = showRawTotals ? (status?.diffInsertions ?? 0) : visibleStats.reduce((sum, e) => sum + e.insertions, 0);
	const deletions = showRawTotals ? (status?.diffDeletions ?? 0) : visibleStats.reduce((sum, e) => sum + e.deletions, 0);
	const testsHiddenNote = !includeTests && excludedTestCount > 0 ? t.plural("infoPanel.diffTestsHidden", excludedTestCount) : null;
	const hasCommittedDiff = (status?.diffFiles ?? 0) > 0;
	return {
		hasGit,
		status,
		compareRef,
		compareLabel,
		includeTests,
		setIncludeTests,
		visibleStats,
		files,
		insertions,
		deletions,
		testsHiddenNote,
		/** The wide badge exists only for committed work. */
		hasBadge: hasGit && hasCommittedDiff,
		hasCommittedDiff,
		/** The tests filter is a segment of the badge; it hides with the badge, on narrow and on request. */
		showTestsSegment: !testsToggleHidden && hasGit && !layout.narrow && hasCommittedDiff,
		title: [t("infoPanel.diffBadgeTooltip", { branch: compareLabel }), testsHiddenNote].filter(Boolean).join(" "),
	};
}

type DiffSummary = ReturnType<typeof useDiffSummary>;

/** Opens the branch diff, pinned: the badge counts committed work, so the viewer's remembered mode must not swap scope. */
function useOpenBranchDiff({ compareRef, compareLabel }: DiffSummary) {
	const { onOpenInlineDiff } = useTaskHeaderInternals();
	return (focusFile?: string) => onOpenInlineDiff?.({ mode: "branch", pinMode: true, compareRef, compareLabel, focusFile });
}

/**
 * The diff summary badge with its include-tests segment (the `status.diff` group): one
 * border owns the group, a hairline splits the click targets, like the status control.
 * Hovering lists the changed files; each row opens the diff or an editor on that file.
 */
function DiffBadge() {
	const t = useT();
	const { task } = useTaskHeaderScope();
	const { layout } = useTaskHeaderInternals();
	const diff = useDiffSummary();
	const openBranchDiff = useOpenBranchDiff(diff);
	const [hover, setHover] = useState(false);
	const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
	const [fileOpenInMenu, setFileOpenInMenu] = useState<{ path: string; pos: { top: number; left: number } } | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => {
		if (hoverTimer.current) clearTimeout(hoverTimer.current);
	}, []);
	if (!diff.hasBadge) return null;

	function showPopover() {
		// Hover is dead on touch, and a tap fires mouseenter with no mouseleave, so the
		// popover would stick over the freshly opened diff (bible §12.3).
		if (layout.narrow) return;
		if (hoverTimer.current) clearTimeout(hoverTimer.current);
		if (triggerRef.current) {
			const rect = triggerRef.current.getBoundingClientRect();
			setPopoverPos({ top: rect.bottom + 4, left: rect.left });
		}
		setHover(true);
	}
	function hidePopover() {
		hoverTimer.current = setTimeout(() => setHover(false), 150);
	}
	function cancelHide() {
		if (hoverTimer.current) clearTimeout(hoverTimer.current);
	}
	function fileDiff(event: ReactMouseEvent<HTMLButtonElement>, relativePath: string) {
		event.stopPropagation();
		setHover(false);
		setFileOpenInMenu(null);
		openBranchDiff(relativePath);
	}
	function fileOpenIn(event: ReactMouseEvent<HTMLButtonElement>, relativePath: string) {
		event.stopPropagation();
		if (!task.worktreePath) return;
		setFileOpenInMenu({ path: `${task.worktreePath}/${relativePath}`, pos: { top: event.clientY, left: event.clientX } });
	}

	const ariaLabel = t("infoPanel.diffBadgeAria", {
		files: t.plural("infoPanel.diffFileCount", diff.files),
		insertions: String(diff.insertions),
		deletions: String(diff.deletions),
		branch: diff.compareLabel,
	});
	return (
		<>
			<div className="inline-flex items-center rounded-lg bg-elevated border border-edge hover:border-edge-active transition-colors flex-shrink-0">
				<button
					type="button"
					ref={triggerRef}
					className={`git-anim inline-flex items-center gap-1.5 px-2 py-1 text-micro font-mono text-fg-2 cursor-pointer transition-colors hover:bg-elevated-hover ${diff.showTestsSegment ? "rounded-l-lg" : "rounded-lg"}`}
					onClick={() => openBranchDiff()}
					onMouseEnter={showPopover}
					onMouseLeave={hidePopover}
					title={diff.title}
					aria-label={ariaLabel}
					data-testid="diff-summary-badge"
				>
					<ShowDiffIcon className="w-[0.95rem] h-[0.95rem] flex-shrink-0 text-fg-muted" />
					<span>{t.plural("infoPanel.diffFileCount", diff.files)}</span>
					<span className="text-success">+{diff.insertions}</span>
					<span className="text-danger">−{diff.deletions}</span>
				</button>
				<TaskHeaderRegionItems region="status.diff" />
			</div>
			{/* Sits at z 9999, above the default tooltip tier — so the row tooltips take
				the "popover" layer, or they open underneath this very list. */}
			{hover && diff.visibleStats.length > 0 && createPortal(
				<div
					className="fixed bg-overlay border border-edge-active rounded-lg shadow-2xl shadow-black/40 py-2 pl-3 pr-1.5 max-w-[25rem] max-h-[20rem] overflow-auto"
					style={{ top: popoverPos.top, left: popoverPos.left, zIndex: 9999 }}
					onMouseEnter={cancelHide}
					onMouseLeave={hidePopover}
				>
					<div className="text-dense text-fg-muted font-semibold uppercase tracking-wider mb-1.5">
						{t("infoPanel.changedFiles")}
					</div>
					{diff.visibleStats.map(({ path: fileName, insertions, deletions }) => (
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
								<Tooltip content={t("infoPanel.showDiff")} detail={t("ttip.infoPanel.showDiff")} layer="popover">
									<button
										onClick={(event) => fileDiff(event, fileName)}
										aria-label={t("infoPanel.showDiff")}
										className="text-sm text-accent hover:text-accent-emphasis w-6 h-6 flex items-center justify-center rounded bg-accent/10 hover:bg-accent/20 transition-colors"
									>
										<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF4D2"}</span>
									</button>
								</Tooltip>
								<Tooltip content={t("openIn.menuTitle")} detail={t("ttip.openIn.menu")} layer="popover">
									<button
										onClick={(event) => fileOpenIn(event, fileName)}
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
			)}
			{fileOpenInMenu && (
				<OpenInMenu position={fileOpenInMenu.pos} path={fileOpenInMenu.path} taskId={task.id} onClose={() => setFileOpenInMenu(null)} />
			)}
		</>
	);
}

/**
 * The narrow bar's counterpart to the wide badge, at icon width so it never has to shed.
 * It steps aside once the wide badge fits, unless the diff is uncommitted-only: the badge
 * counts committed files and renders nothing then, so this is the only path to it.
 */
function NarrowDiffButton() {
	const t = useT();
	const { onOpenInlineDiff } = useTaskHeaderInternals();
	const diff = useDiffSummary();
	// `diffFiles` is `<compare>...HEAD` — committed work only. A branch whose changes are
	// all still in the working tree has no committed diff, so the dirty totals decide.
	const uncommittedInsertions = diff.status?.insertions ?? 0;
	const uncommittedDeletions = diff.status?.deletions ?? 0;
	const hasUncommittedDiff = uncommittedInsertions > 0 || uncommittedDeletions > 0;
	if (!diff.hasGit || !(diff.hasCommittedDiff || hasUncommittedDiff)) return null;

	// It knows which side carries the changes, so it pins the mode: the remembered
	// preference would otherwise open the empty one and read as a broken button.
	function openWhereTheChangesAre() {
		if (!onOpenInlineDiff) return;
		if (!diff.hasCommittedDiff) {
			onOpenInlineDiff({ mode: "uncommitted", pinMode: true });
			return;
		}
		onOpenInlineDiff({ mode: "branch", pinMode: true, compareRef: diff.compareRef, compareLabel: diff.compareLabel });
	}

	return (
		<button
			type="button"
			data-testid="summary-bar-diff-compact"
			onClick={openWhereTheChangesAre}
			aria-label={t("infoPanel.showDiff")}
			title={diff.title}
			className={`git-anim flex-shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg border border-edge bg-elevated px-2 min-w-[2.75rem] min-h-[2.75rem] text-micro font-mono text-fg-2 transition-colors hover:bg-elevated-hover ${
				diff.hasCommittedDiff ? "[@container(min-width:400px)]:hidden" : ""
			}`}
		>
			<ShowDiffIcon className="w-[0.95rem] h-[0.95rem] flex-shrink-0 text-fg-muted" />
			{/* The numbers go before the chip does: a 390px bar has ~44px left, a dirty
				"+4000 −2000" needs ~72px. Only the uncommitted-only chip has numbers to
				reveal; the committed one hands over to the wide badge at 400px. */}
			{!diff.hasCommittedDiff && (
				<span className="hidden [@container(min-width:440px)]:flex items-center gap-1 tabular-nums" data-testid="summary-bar-diff-compact-numbers">
					<span className="text-success">+{uncommittedInsertions}</span>
					<span className="text-danger">−{uncommittedDeletions}</span>
				</span>
			)}
		</button>
	);
}

/**
 * The bar may shed the badge on a narrow screen, so the diff keeps a sheet row that does
 * not need a live task: the Git section's own Show diff row requires a live worktree, and
 * a finished task would lose the diff entirely (bible §12.6).
 */
function DiffSheetRow() {
	const t = useT();
	const { task } = useTaskHeaderScope();
	const { isTaskActive, onOpenInlineDiff, closeSheet } = useTaskHeaderInternals();
	const diff = useDiffSummary();
	const openBranchDiff = useOpenBranchDiff(diff);
	if (!diff.hasBadge || (isTaskActive && task.worktreePath) || !onOpenInlineDiff) return null;
	return (
		<button
			type="button"
			data-testid="task-actions-show-diff"
			onClick={() => {
				closeSheet();
				openBranchDiff();
			}}
			className={SHEET_ROW_CLASS}
		>
			<ShowDiffIcon className="h-5 w-5 shrink-0 text-accent" />
			<span className="flex-1 text-sm font-medium">{t("infoPanel.showDiff")}</span>
			<span className="text-xs font-mono text-fg-3 tabular-nums">{diff.files}</span>
		</button>
	);
}

function DiffItem() {
	const placement = usePlacement();
	if (placement === "sheet") return <DiffSheetRow />;
	if (placement === "desktop") return <DiffBadge />;
	return (
		<>
			<NarrowDiffButton />
			{/* The title is in the breadcrumb row above, so the bar leaves this gap instead. */}
			<div className="flex-1 min-w-0" />
			{/* First to go: the widest chip on the bar, and its whole content repeats in
				the sheet's Show diff row. */}
			<span className="hidden [@container(min-width:400px)]:contents" data-testid="summary-bar-diff-slot">
				<DiffBadge />
			</span>
		</>
	);
}

/** Only ever modifies the badge's numbers, so it is drawn as the badge's second segment. */
function IncludeTestsItem() {
	const t = useT();
	const diff = useDiffSummary();
	if (!diff.showTestsSegment) return null;
	return (
		<>
			<span className="h-4 w-px flex-shrink-0 bg-edge" aria-hidden="true" />
			<Tooltip content={t("infoPanel.diffIncludeTestsTooltip")} detail={t("ttip.infoPanel.includeTests")}>
				<button
					type="button"
					data-testid="diff-include-tests-toggle"
					onClick={() => diff.setIncludeTests(!diff.includeTests)}
					title={diff.testsHiddenNote ?? undefined}
					className={`git-anim flex flex-shrink-0 items-center justify-center self-stretch rounded-r-lg px-1.5 transition-colors ${
						diff.includeTests ? "text-fg-3 hover:bg-elevated-hover hover:text-fg-2" : "bg-accent/10 text-accent hover:bg-accent/20"
					}`}
					aria-label={t("infoPanel.diffIncludeTestsAria")}
					aria-pressed={diff.includeTests}
				>
					<IncludeTestsIcon className="w-[0.95rem] h-[0.95rem]" off={!diff.includeTests} />
				</button>
			</Tooltip>
		</>
	);
}

function item(id: string, component: ComponentType<SlotItemProps>): TaskHeaderItem {
	return { id: `builtin:status.${id}`, region: "status", label: `taskHeaderItem.status.${id}` as TranslationKey, component };
}

/**
 * The Context bar, left to right. Desktop: variant switcher, watch, priority, status,
 * completion owner, diff badge. Narrow: variant switcher, status band, agent outputs,
 * diff. Sheet: watch, completion owner, Show diff. Each item renders only its own forms.
 */
export const STATUS_ITEMS: readonly TaskHeaderItem[] = [
	item("variant-switcher", VariantSwitcherItem),
	item("watch", WatchItem),
	item("priority", PriorityItem),
	item("status", StatusItem),
	item("narrow-outputs", NarrowOutputsItem),
	item("completion-owner", CompletionOwnerItem),
	item("diff", DiffItem),
];

/** The diff badge's segments after its counts. */
export const STATUS_DIFF_ITEMS: readonly TaskHeaderItem[] = [
	{ id: "builtin:status.include-tests", region: "status.diff", label: "taskHeaderItem.status.include-tests", component: IncludeTestsItem },
];
