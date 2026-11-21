import { createPortal } from "react-dom";
import { cloneElement, createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from "react";
import type { Context } from "cordis";
import type { Project, Task, TaskPRBadgeInfo } from "../../shared/types";
import { ACTIVE_STATUSES, taskUsesWorktree } from "../../shared/types";
import { earlierPullRequests, trustedPrStatusCache } from "../../shared/task-pull-requests";
import { useT } from "../i18n";
import { useViewportClamp } from "../hooks/useViewportClamp";
import { useReducedMotion } from "../utils/useReducedMotion";
import { useReviewedPrBackfill } from "../hooks/useReviewedPrBackfill";
import { inspectorPRBadge, isLivePullRequest, reviewedPrLink } from "../utils/taskPrBadge";
import { prBadgeDisplayState, prStateTone } from "../utils/prStateTone";
import { toast } from "../toast";
import Tooltip from "../components/Tooltip";
import TaskPrStatusPopover from "../components/TaskPrStatusPopover";
import ReviewedPrLink from "../components/ReviewedPrLink";
import TaskOpsRepoBar from "../components/task-info-panel/TaskOpsRepoBar";
import { RescanIcon } from "../components/HeaderIcons";
import { AutoMergeIcon, BranchIcon, CommitIcon, CreatePRIcon, MergeIcon, PushIcon, RebaseIcon, ShowDiffIcon } from "../components/task-info-panel/GitIcons";
import type { TaskInlineDiffRequest } from "../components/task-inline-diff";
import type { SlotItemProps } from "../plugins/SlotItems";
import type { TaskHeaderGroup, TaskHeaderItem, TaskHeaderRegion, TaskHeaderScope } from "./registry";
import { TaskHeaderRegionItems, useTaskHeaderInternals, useTaskHeaderScope, useTaskHeaderSurface } from "./scope";

/**
 * The Git bar (bible §5.1, panel 2) as built-in items. Every item reads the header's one
 * `useTaskBranchStatus` instance, so ten items still poll once. Each item draws its bar
 * form and its row of the narrow actions sheet; an item with no sheet row draws nothing there.
 */

/** A task whose Git bar reads a repo: its own worktree, or an Operations task's attached repo. */
export function taskHasGitBar(project: Project, task: Task): boolean {
	return taskUsesWorktree(project, task) || (project.kind === "virtual" && !!task.attachedRepo);
}

/** Write actions need the task's own worktree; an Operations task only reads a repo. */
function hasGitWrites({ project, task }: TaskHeaderScope): boolean {
	return project.kind !== "virtual" && taskUsesWorktree(project, task);
}

function hasGitRead({ project, task }: TaskHeaderScope): boolean {
	return taskHasGitBar(project, task);
}

/** Every write action needs a live worktree to run in. */
function canRunGitActions(task: Task): boolean {
	return ACTIVE_STATUSES.includes(task.status) && !!task.worktreePath;
}

// --- narrow actions sheet --------------------------------------------------------------

interface GitSheetValue {
	/** Full-width row class shared with the rest of the mobile actions sheet. */
	rowClassName: string;
	/** Dismiss the sheet after an action, so the terminal / PR it opened is what shows. */
	onAction: () => void;
}

const GitSheetContext = createContext<GitSheetValue>({ rowClassName: "", onAction: () => {} });

export function GitSheetProvider({ value, children }: { value: GitSheetValue; children: ReactNode }) {
	return <GitSheetContext.Provider value={value}>{children}</GitSheetContext.Provider>;
}

interface GitSheetRowProps {
	icon: ReactNode;
	label: string;
	disabled: boolean;
	/** Muted one-liner explaining why the row is disabled (no hover tooltips on touch). */
	reason?: string;
	external?: boolean;
	run: () => void;
}

function GitSheetRow({ icon, label, disabled, reason, external, run }: GitSheetRowProps) {
	const { rowClassName, onAction } = useContext(GitSheetContext);
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={() => {
				run();
				onAction();
			}}
			className={`${rowClassName} ${disabled ? "cursor-not-allowed opacity-50 hover:bg-raised active:bg-raised" : ""}`}
		>
			{icon}
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-sm font-medium">{label}</span>
				{disabled && reason && (
					<span className="truncate text-micro font-normal text-fg-muted">{reason}</span>
				)}
			</span>
			{external && !disabled && (
				<span className="shrink-0 text-fg-muted" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }} aria-hidden="true">
					{"\u{F0866}"}
				</span>
			)}
		</button>
	);
}

// --- shared git state ------------------------------------------------------------------

/** The status facts every git item derives the same way. */
function useGitFacts() {
	const { task } = useTaskHeaderScope();
	const { git } = useTaskHeaderInternals();
	const { branchStatus } = git;
	const prInfo = useMemo<TaskPRBadgeInfo | null>(
		() => inspectorPRBadge(task, git.prStatus, branchStatus),
		[git.prStatus, branchStatus, task],
	);
	const hasUncommittedChanges = !!branchStatus && (branchStatus.insertions > 0 || branchStatus.deletions > 0);
	// A repo with no `origin` cannot be pushed and has nowhere to open a PR.
	const noRemote = branchStatus?.hasRemote === false;
	// `gh` is the only forge client dev3 speaks, so a GitLab/Gitea origin gets no PR button.
	const noGitHubRemote = !!branchStatus && branchStatus.hasRemote && !branchStatus.remoteIsGitHub;
	// `ahead`/`behind` are 0 here because nothing could be measured; each action says so.
	const baseUnreachable = !!branchStatus?.baseUnreachable;
	// origin/<branch> holds commits HEAD does not: the backend escalates to a leased force push.
	const pushIsForced = !!branchStatus && branchStatus.hasRemote && branchStatus.remoteAhead > 0;
	// A foreign-code task exists to READ commits the local user did not write, so the
	// write actions are gone rather than disabled.
	const ownBranch = !task.foreignCode;
	const hasPR = isLivePullRequest(prInfo?.number, [
		git.prStatus && { number: git.prStatus.number, state: git.prStatus.mergeState?.state },
		branchStatus && { number: branchStatus.prNumber, state: branchStatus.prState },
		task.prStatusCache && { number: task.prStatusCache.number, state: task.prStatusCache.mergeState?.state },
	]);
	return { task, git, branchStatus, prInfo, hasUncommittedChanges, noRemote, noGitHubRemote, baseUnreachable, pushIsForced, ownBranch, hasPR };
}

/** The sheet's PR rows judge "has a PR" from the stored status only, as they always did. */
function useSheetPrFacts() {
	const t = useT();
	const { task, git, branchStatus, noRemote, noGitHubRemote, ownBranch } = useGitFacts();
	const prNumber = branchStatus?.prNumber ?? task.prNumber ?? null;
	const hasPR = isLivePullRequest(prNumber, [
		branchStatus && { number: branchStatus.prNumber, state: branchStatus.prState },
		task.prStatusCache && { number: task.prStatusCache.number, state: task.prStatusCache.mergeState?.state },
	]);
	const ahead = branchStatus?.ahead ?? 0;
	const canCreate = !hasPR && ownBranch;
	const disabled = noRemote || noGitHubRemote || !branchStatus || ahead === 0;
	const reason = !branchStatus
		? t("infoPanel.statusLoading")
		: noRemote
			? t("infoPanel.noRemoteDisabled")
			: noGitHubRemote
				? t("infoPanel.noGitHubRemoteDisabled")
				: ahead === 0
					? t("infoPanel.createPRDisabledNoCommits")
					: undefined;
	return { task, git, branchStatus, prNumber, canCreate, disabled, reason };
}

// --- bar buttons -----------------------------------------------------------------------

type GitActionButton = ReactElement<{
	className?: string;
	"aria-label"?: string;
	"aria-hidden"?: boolean;
	tabIndex?: number;
}>;

/**
 * Native disabled controls do not dispatch mouse events, so anchor their
 * tooltip to a focusable wrapper while keeping the real button disabled.
 */
function GitActionTooltip({ content, detail, disabled, children }: { content: ReactNode; detail?: ReactNode; disabled: boolean; children: GitActionButton }) {
	if (!disabled) {
		return (
			<Tooltip content={content} detail={detail}>
				{children}
			</Tooltip>
		);
	}
	const disabledButton = cloneElement(children, {
		className: `${children.props.className ?? ""} pointer-events-none`.trim(),
		tabIndex: -1,
		"aria-hidden": true,
	});
	return (
		<Tooltip content={content} detail={detail}>
			<span className="inline-flex" role="button" aria-disabled="true" aria-label={children.props["aria-label"]} tabIndex={0}>
				{disabledButton}
			</span>
		</Tooltip>
	);
}

const DISABLED_BTN_CLASS = "text-fg-muted/50 cursor-not-allowed bg-raised/50";
// Neutral like the rest of the session bar: the colour in this row belongs to the
// status badges (ahead/behind, PR, conflicts), not to the actions.
const ENABLED_BTN_CLASS = "text-fg-3 hover:text-fg hover:bg-elevated border border-edge";
// The one action that rewrites published history earns the danger colour.
const DANGER_BTN_CLASS = "text-danger hover:bg-danger/10 border border-danger/40";
const ICON_CLASS = "w-[0.85rem] h-[0.85rem]";

/** Fixed square slot, so the idle icon and the in-progress ring share one footprint. */
function GitIcon({ icon, spin }: { icon: ReactNode; spin: boolean }) {
	const reducedMotion = useReducedMotion();
	return (
		<span className="inline-flex items-center justify-center w-[0.85rem] h-[0.85rem]" aria-hidden="true">
			{spin ? (
				<span
					className={`w-2.5 h-2.5 rounded-full border-2 border-[color-mix(in_srgb,currentColor_30%,transparent)] border-t-current${reducedMotion ? "" : " animate-spin"}`}
				/>
			) : (
				icon
			)}
		</span>
	);
}

/** Compact = icon only; full = icon + label. */
function GitButtonContent({ icon, label, spin = false }: { icon: ReactNode; label: string; spin?: boolean }) {
	const { layout } = useTaskHeaderInternals();
	if (layout.compact) return <GitIcon icon={icon} spin={spin} />;
	return (
		<span className="inline-flex items-center gap-1">
			<GitIcon icon={icon} spin={spin} />
			<span>{label}</span>
		</span>
	);
}

interface GitBarButtonProps {
	tooltip: ReactNode;
	detail: ReactNode;
	disabled: boolean;
	danger?: boolean;
	ariaLabel: string;
	icon: ReactNode;
	label: string;
	busy: boolean;
	onClick: () => void;
	"data-tour-anchor"?: string;
}

function GitBarButton({ tooltip, detail, disabled, danger, ariaLabel, icon, label, busy, onClick, "data-tour-anchor": tourAnchor }: GitBarButtonProps) {
	return (
		<GitActionTooltip content={tooltip} detail={detail} disabled={disabled}>
			<button
				onClick={onClick}
				disabled={disabled}
				className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-dense font-medium transition-colors ${
					disabled ? DISABLED_BTN_CLASS : danger ? DANGER_BTN_CLASS : ENABLED_BTN_CLASS
				}`}
				aria-label={ariaLabel}
				data-tour-anchor={tourAnchor}
			>
				<GitButtonContent icon={icon} label={label} spin={busy} />
			</button>
		</GitActionTooltip>
	);
}

// --- items -----------------------------------------------------------------------------

/** An Operations task: attach a repo, or the attached repo's chip. */
function OpsRepoItem() {
	const { task } = useTaskHeaderScope();
	if (useTaskHeaderSurface() === "sheet") return null;
	return <TaskOpsRepoBar task={task} isTaskActive={ACTIVE_STATUSES.includes(task.status)} />;
}

function WorkflowOffItem() {
	const t = useT();
	if (useTaskHeaderSurface() === "sheet") return null;
	return <span className="text-fg-muted text-micro italic flex-shrink-0 truncate">{t("task.gitWorkflowOff")}</span>;
}

/**
 * A labelled chip: the full branch name heads the menu it opens, and the menu names every
 * copy action in words. "Open in Finder" is deliberately absent: TaskOpenIn owns that.
 */
function BranchItem() {
	const t = useT();
	const surface = useTaskHeaderSurface();
	const { task, git, prInfo, noRemote } = useGitFacts();
	const { baseBranch, displayRef, selectCompareRef } = git;
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const { position: clamped, visible } = useViewportClamp(menuRef, pos);

	// Close on click outside / Escape, same contract as every other menu here.
	useEffect(() => {
		if (!open) return;
		function onMouseDown(event: MouseEvent) {
			const target = event.target as Node;
			if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
			setOpen(false);
		}
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") setOpen(false);
		}
		// Capture phase: the terminal swallows mousedown before it bubbles to document.
		document.addEventListener("mousedown", onMouseDown, true);
		window.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("mousedown", onMouseDown, true);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [open]);

	useEffect(() => {
		setOpen(false);
	}, [task.id]);

	if (surface === "sheet" || !task.branchName) return null;

	/** Copy feedback is a toast: a tooltip swap was invisible once the pointer moved on. */
	function copyToClipboard(value: string, confirmation: string) {
		void navigator.clipboard
			.writeText(value)
			// Only claim success once the write resolved.
			.then(() => toast.success(confirmation, { taskId: task.id }))
			.catch(() => toast.error(t("infoPanel.copyFailed"), { taskId: task.id }));
		setOpen(false);
	}

	const items = [
		{ key: "branch", label: t("infoPanel.copyBranchItem"), value: task.branchName, done: t("infoPanel.branchCopied") },
		...(task.worktreePath
			? [{ key: "path", label: t("infoPanel.copyPathItem"), value: task.worktreePath, done: t("infoPanel.worktreePathCopied") }]
			: []),
		{ key: "checkout", label: t("infoPanel.copyCheckoutItem"), value: `git checkout ${task.branchName}`, done: t("infoPanel.checkoutCopied") },
		...(prInfo?.url
			? [{ key: "pr", label: t("infoPanel.copyPrLinkItem"), value: prInfo.url, done: t("infoPanel.prLinkCopied") }]
			: []),
	];

	// With no remote there is no `origin/<base>` to offer. Rows match on the RESOLVED ref:
	// a project default spelled "origin/main" would otherwise tick neither row.
	const compareOptions = noRemote
		? [{ value: "", ref: baseBranch, label: baseBranch }]
		: [
			{ value: "", ref: `origin/${baseBranch}`, label: `origin/${baseBranch}` },
			{ value: baseBranch, ref: baseBranch, label: t("infoPanel.compareRefLocal", { branch: baseBranch }) },
		];

	const menu = open && createPortal(
		<div
			ref={menuRef}
			role="menu"
			className="fixed bg-overlay border border-edge-active rounded-lg shadow-2xl shadow-black/40 py-1 min-w-[13rem] max-w-[calc(100vw-1rem)]"
			style={{ top: clamped.top, left: clamped.left, zIndex: 9999, visibility: visible ? "visible" : "hidden" }}
			onClick={(event) => event.stopPropagation()}
		>
			<div className="px-3 pb-1.5 pt-1 mb-1 border-b border-edge font-mono text-micro text-fg-muted break-all">
				{task.branchName}
			</div>
			{items.map((item) => (
				<button
					key={item.key}
					role="menuitem"
					type="button"
					onClick={() => copyToClipboard(item.value, item.done)}
					className="block w-full text-left px-3 py-1.5 text-micro text-fg-2 hover:bg-overlay-hover hover:text-fg transition-colors"
				>
					{item.label}
				</button>
			))}
			<div className="mt-1 border-t border-edge pt-1">
				<div className="px-3 py-1 text-dense font-semibold uppercase tracking-wider text-fg-muted">
					{t("infoPanel.compareAgainst")}
				</div>
				{compareOptions.map((option) => (
					<button
						key={option.value}
						role="menuitemradio"
						type="button"
						aria-checked={displayRef === option.ref}
						onClick={() => {
							selectCompareRef(option.value);
							setOpen(false);
						}}
						className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-micro transition-colors hover:bg-overlay-hover ${
							displayRef === option.ref ? "text-accent font-medium" : "text-fg-2 hover:text-fg"
						}`}
					>
						<span aria-hidden="true" className="w-2.5 flex-shrink-0">
							{displayRef === option.ref ? "✓" : ""}
						</span>
						<span className="font-mono">{option.label}</span>
					</button>
				))}
			</div>
		</div>,
		document.body,
	);

	return (
		<>
			{menu}
			<Tooltip content={task.branchName} detail={t("ttip.infoPanel.branchChip")}>
				<button
					ref={triggerRef}
					type="button"
					onClick={(event) => {
						event.stopPropagation();
						if (!open && triggerRef.current) {
							const rect = triggerRef.current.getBoundingClientRect();
							setPos({ top: rect.bottom + 4, left: rect.left });
						}
						setOpen((value) => !value);
					}}
					className={`git-anim flex items-center gap-1 flex-shrink-0 rounded px-1.5 py-0.5 text-micro border transition-colors ${
						open
							? "text-fg bg-elevated border-edge-active"
							: "text-fg-3 border-edge bg-raised/60 hover:text-fg hover:bg-elevated hover:border-edge-active"
					}`}
					aria-label={t("infoPanel.branchMenuLabel", { branch: task.branchName })}
					aria-haspopup="menu"
					aria-expanded={open}
					data-testid="branch-chip"
				>
					<BranchIcon className="w-3 h-3" />
					<span className="font-medium">{t("infoPanel.branchChip")}</span>
					<span aria-hidden="true" className="opacity-70">▾</span>
				</button>
			</Tooltip>
		</>
	);
}

/** Placeholder passed into the translated string so the behind half can be split
    off without matching digits that belong to the ahead count. */
const BEHIND_SLOT = "\u0000";

/** Colours the number AND its wording: the whole "N behind" phrase reads as the warning. */
function BehindCount({ text, behind }: { text: string; behind: number }) {
	const [before, after = ""] = text.split(BEHIND_SLOT);
	return (
		<>
			{before}
			<span className="text-danger" data-testid="behind-count">{behind}{after}</span>
		</>
	);
}

/**
 * Ahead / behind and the uncommitted line counts, as one control that opens the diff the
 * numbers describe; the narrow sheet's form is its "Show diff" row.
 */
function ChangesItem() {
	const t = useT();
	const surface = useTaskHeaderSurface();
	const { layout, onOpenInlineDiff } = useTaskHeaderInternals();
	const { task, git, branchStatus, hasUncommittedChanges } = useGitFacts();
	const { compareRef, displayRef, statusError, statusLoading, refreshingStatus, handleRefreshStatus } = git;

	if (surface === "sheet") {
		if (!onOpenInlineDiff) return null;
		return (
			<GitSheetRow
				icon={<ShowDiffIcon className="h-5 w-5 shrink-0 text-accent" />}
				label={t("infoPanel.showDiff")}
				disabled={false}
				external
				run={() => onOpenInlineDiff({ mode: "branch", compareRef: compareRef || undefined, compareLabel: displayRef })}
			/>
		);
	}

	const showLoading = layout.collapsed;
	// No fork point, so there is no ahead and no behind to print: the slot says what is
	// wrong instead of each side's whole history.
	const branchStatusBadge = branchStatus?.baseUnreachable ? (
		<Tooltip content={t("infoPanel.baseUnreachableTooltip", { ref: displayRef })} detail={t("infoPanel.baseUnreachableDetail")}>
			<span className="flex items-center gap-1 text-micro font-medium text-warning-strong flex-shrink-0" data-testid="base-unreachable">
				{t("infoPanel.baseUnreachable")}
			</span>
		</Tooltip>
	) : branchStatus && (branchStatus.ahead > 0 || branchStatus.behind > 0) ? (
		<span className="flex items-center gap-1.5 text-micro flex-shrink-0">
			{/* Only the behind count is a verdict ("rebase needed"), so only it is red. */}
			{branchStatus.behind > 0 && branchStatus.ahead > 0 ? (
				<span className="text-fg-3 font-medium">
					<BehindCount
						text={t("infoPanel.commitsAheadBehind", { ahead: String(branchStatus.ahead), behind: BEHIND_SLOT })}
						behind={branchStatus.behind}
					/>
				</span>
			) : branchStatus.behind > 0 ? (
				<span className="text-fg-3 font-medium">
					<BehindCount
						text={t.plural("infoPanel.commitsBehind", branchStatus.behind, { count: BEHIND_SLOT })}
						behind={branchStatus.behind}
					/>
				</span>
			) : (
				<span className="text-fg-3 font-medium">
					{t.plural("infoPanel.commitsAhead", branchStatus.ahead)}
				</span>
			)}
		</span>
	) : null;

	const dirty = hasUncommittedChanges ? branchStatus : null;
	const uncommittedBadge = dirty ? (
		<span className="flex items-center gap-1 text-micro font-medium flex-shrink-0">
			<span className="text-success">+{dirty.insertions}</span>
			<span className="text-fg-muted">/</span>
			<span className="text-danger">−{dirty.deletions}</span>
		</span>
	) : null;

	const showStatusError = showLoading && !!statusError && !branchStatus;
	if (!(branchStatusBadge || uncommittedBadge || (showLoading && (statusLoading || showStatusError)))) return null;

	/**
	 * The +/− numbers are the working tree, not the branch: a dirty tree opens the
	 * uncommitted diff, a clean one the branch diff. Pinned, so the remembered mode
	 * cannot undo the choice.
	 */
	const changesTarget: TaskInlineDiffRequest = hasUncommittedChanges
		? { mode: "uncommitted", pinMode: true }
		: { mode: "branch", pinMode: true, compareRef: compareRef || undefined, compareLabel: displayRef };
	const changesTooltip = hasUncommittedChanges
		? t("infoPanel.changesSummaryUncommitted")
		: t("infoPanel.changesSummaryBranch", { branch: displayRef });
	const aheadBehindLabel = !branchStatus || branchStatus.baseUnreachable
		? null
		: branchStatus.ahead > 0 && branchStatus.behind > 0
			? t("infoPanel.commitsAheadBehind", { ahead: String(branchStatus.ahead), behind: String(branchStatus.behind) })
			: branchStatus.behind > 0
				? t.plural("infoPanel.commitsBehind", branchStatus.behind)
				: branchStatus.ahead > 0
					? t.plural("infoPanel.commitsAhead", branchStatus.ahead)
					: null;
	const uncommittedLabel = dirty
		? t("infoPanel.uncommittedLines", { insertions: String(dirty.insertions), deletions: String(dirty.deletions) })
		: null;
	const changesDetail = !hasUncommittedChanges
		? t("ttip.infoPanel.changesSummaryBranch", { branch: displayRef })
		: aheadBehindLabel
			? t("ttip.infoPanel.changesSummaryUncommitted", { branch: displayRef })
			: t("ttip.infoPanel.changesSummaryUncommittedOnly");
	const changesAriaLabel = [changesTooltip, [aheadBehindLabel, uncommittedLabel].filter(Boolean).join(", ")]
		.filter(Boolean)
		.join(": ");

	const changesSummary = branchStatusBadge || uncommittedBadge ? (
		!onOpenInlineDiff ? (
			<span className="flex items-center gap-1.5 flex-shrink-0">
				{branchStatusBadge}
				{uncommittedBadge}
			</span>
		) : (
			<Tooltip content={changesTooltip} detail={changesDetail}>
				<button
					type="button"
					onClick={() => onOpenInlineDiff(changesTarget)}
					className="flex items-center gap-1.5 flex-shrink-0 rounded px-1 py-0.5 hover:bg-elevated transition-colors"
					aria-label={changesAriaLabel}
					data-testid="changes-summary"
				>
					{branchStatusBadge}
					{uncommittedBadge}
				</button>
			</Tooltip>
		)
	) : null;

	return (
		<>
			{task.branchName && <span className="text-fg-muted text-xs flex-shrink-0">|</span>}
			{changesSummary}
			{showStatusError && (
				<span className="flex items-center gap-1 text-micro text-danger flex-shrink-0" title={statusError ?? undefined}>
					{t("infoPanel.statusLoadFailed")}
					<button type="button" onClick={handleRefreshStatus} disabled={refreshingStatus} className="underline hover:text-fg disabled:opacity-40">
						{t("infoPanel.statusRetry")}
					</button>
				</span>
			)}
			{showLoading && statusLoading && (
				<span className="flex items-center gap-1 text-micro text-fg-muted flex-shrink-0">
					<svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
						<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
						<path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
					</svg>
				</span>
			)}
		</>
	);
}

/** The PR chip (opens the PR, hover for its checks) and the reviewed-PR link. */
function PrStatusItem() {
	const t = useT();
	const surface = useTaskHeaderSurface();
	const { project } = useTaskHeaderScope();
	const { onOpenInlineDiff } = useTaskHeaderInternals();
	const { task, git, branchStatus, prInfo } = useGitFacts();
	// The bar's job, as before the split: opening the narrow sheet asks nothing new.
	useReviewedPrBackfill(useMemo(() => (surface === "bar" ? [task] : []), [surface, task]));
	// An Operations task reads its attached repo: no PR of its own.
	if (surface === "sheet" || project.kind === "virtual") return null;

	const openUnresolvedInDiff = onOpenInlineDiff
		? () => onOpenInlineDiff({
			mode: "branch",
			compareRef: git.compareRef || undefined,
			compareLabel: git.displayRef,
			focusFirstUnresolvedThread: true,
		})
		: undefined;
	const prState = prInfo ? prBadgeDisplayState(prInfo, branchStatus, trustedPrStatusCache(task)) : null;
	const prTone = prState ? prStateTone(prState) : null;
	const reviewedPr = reviewedPrLink(task, prInfo);
	return (
		<>
			{prInfo && prTone && prState && (
				<TaskPrStatusPopover prInfo={prInfo} projectId={project.id} taskId={task.id} onShowUnresolved={openUnresolvedInDiff} earlierPullRequests={earlierPullRequests(task)} displayState={prState}>
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							if (prInfo.url) window.open(prInfo.url, "_blank");
						}}
						className={`inline-flex items-center gap-1 text-dense font-mono font-semibold px-1.5 py-0.5 rounded transition-colors flex-shrink-0 ${prTone.chip}`}
					>
						<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0401}"}</span>
						{t("task.prBadge", { number: String(prInfo.number) })}
						{prTone.labelKey && <span className="sr-only">{` — ${t(prTone.labelKey)}`}</span>}
						{(prInfo.unresolvedCount ?? 0) > 0 && (
							<span className="inline-flex items-center gap-0.5 text-warning-strong" aria-label={t.plural("task.prUnresolvedComments", prInfo.unresolvedCount ?? 0)}>
								<span className="leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF086"}</span>
								<span>{prInfo.unresolvedCount}</span>
							</span>
						)}
					</button>
				</TaskPrStatusPopover>
			)}
			{reviewedPr && <ReviewedPrLink pr={reviewedPr} labelled testId="git-bar-reviewed-pr" />}
		</>
	);
}

function CommitItem() {
	const t = useT();
	const surface = useTaskHeaderSurface();
	const { task, git, branchStatus, hasUncommittedChanges } = useGitFacts();
	if (!canRunGitActions(task)) return null;
	if (surface === "sheet") {
		return (
			<GitSheetRow
				icon={<CommitIcon className={`h-5 w-5 shrink-0 ${hasUncommittedChanges ? "text-success" : "text-fg-muted"}`} />}
				label={t("infoPanel.commit")}
				disabled={!hasUncommittedChanges}
				reason={!branchStatus ? t("infoPanel.statusLoading") : !hasUncommittedChanges ? t("infoPanel.commitDisabledClean") : undefined}
				run={() => void git.handleCommit()}
			/>
		);
	}
	return (
		<GitBarButton
			tooltip={!branchStatus ? t("infoPanel.statusLoading") : !hasUncommittedChanges ? t("infoPanel.commitDisabledClean") : t("infoPanel.commitAgentTooltip")}
			detail={t("ttip.git.commit")}
			disabled={!branchStatus || !hasUncommittedChanges || git.committing}
			ariaLabel={t("infoPanel.commit")}
			icon={<CommitIcon className={ICON_CLASS} />}
			label={git.committing ? t("infoPanel.committing") : t("infoPanel.commit")}
			busy={git.committing}
			onClick={() => void git.handleCommit()}
		/>
	);
}

/** A conflicting rebase is handed to the agent instead of being disabled. */
function RebaseItem() {
	const t = useT();
	const surface = useTaskHeaderSurface();
	const { task, git, branchStatus, baseUnreachable } = useGitFacts();
	if (!canRunGitActions(task)) return null;
	const behind = branchStatus?.behind ?? 0;
	const needsAgent = !!branchStatus && behind > 0 && !branchStatus.canRebase;
	if (surface === "sheet") {
		return (
			<GitSheetRow
				icon={<RebaseIcon className={`h-5 w-5 shrink-0 ${!branchStatus || behind === 0 ? "text-fg-muted" : "text-accent"}`} />}
				label={needsAgent ? t("infoPanel.rebaseViaAgentShort") : t("infoPanel.rebase")}
				disabled={!branchStatus || behind === 0}
				reason={!branchStatus ? t("infoPanel.statusLoading") : behind === 0 ? t("infoPanel.rebaseDisabled") : undefined}
				run={() => void git.handleRebase()}
			/>
		);
	}
	const tooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: baseUnreachable
			? t("infoPanel.baseUnreachableTooltip", { ref: git.displayRef })
			: behind === 0
				? t("infoPanel.rebaseDisabled")
				: needsAgent
					? t("infoPanel.rebaseViaAgent")
					: t("infoPanel.rebase");
	return (
		<GitBarButton
			tooltip={tooltip}
			detail={t("ttip.git.rebase")}
			disabled={!branchStatus || behind === 0 || git.rebasing}
			ariaLabel={needsAgent ? t("infoPanel.rebaseViaAgent") : t("infoPanel.rebase")}
			icon={<RebaseIcon className={ICON_CLASS} />}
			label={git.rebasing ? t("infoPanel.rebasing") : needsAgent ? t("infoPanel.rebaseViaAgentShort") : t("infoPanel.rebase")}
			busy={git.rebasing}
			onClick={git.handleRebase}
		/>
	);
}

function PushItem() {
	const t = useT();
	const surface = useTaskHeaderSurface();
	const { task, git, branchStatus, hasUncommittedChanges, noRemote, baseUnreachable, pushIsForced, ownBranch } = useGitFacts();
	if (!canRunGitActions(task) || !ownBranch) return null;
	const ahead = branchStatus?.ahead ?? 0;
	if (surface === "sheet") {
		const disabled = noRemote || !branchStatus || ahead === 0;
		return (
			<GitSheetRow
				icon={<PushIcon className={`h-5 w-5 shrink-0 ${disabled ? "text-fg-muted" : pushIsForced ? "text-danger" : "text-accent"}`} />}
				label={pushIsForced ? t("infoPanel.forcePush") : t("infoPanel.push")}
				disabled={disabled}
				reason={!branchStatus
					? t("infoPanel.statusLoading")
					: noRemote
						? t("infoPanel.noRemoteDisabled")
						: pushIsForced
							? t("infoPanel.forcePushTooltip", { branch: task.branchName ?? "" })
							: ahead === 0 ? t("infoPanel.pushDisabled") : undefined}
				run={() => void git.handlePush()}
			/>
		);
	}
	const tooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: noRemote
			? t("infoPanel.noRemoteDisabled")
			: baseUnreachable
				? t("infoPanel.baseUnreachableTooltip", { ref: git.displayRef })
				: pushIsForced
					? t("infoPanel.forcePushTooltip", { branch: task.branchName ?? "" })
					: ahead === 0
						? t(hasUncommittedChanges ? "infoPanel.pushDisabledUncommitted" : "infoPanel.pushDisabled")
						: t("infoPanel.push");
	return (
		<GitBarButton
			tooltip={tooltip}
			detail={t("ttip.git.push")}
			disabled={noRemote || !branchStatus || ahead === 0 || git.pushing}
			danger={pushIsForced}
			ariaLabel={pushIsForced ? t("infoPanel.forcePush") : t("infoPanel.push")}
			icon={<PushIcon className={ICON_CLASS} />}
			label={git.pushing ? t("infoPanel.pushing") : pushIsForced ? t("infoPanel.forcePush") : t("infoPanel.push")}
			busy={git.pushing}
			onClick={git.handlePush}
		/>
	);
}

/** Bar: Create PR / Auto PR are offered only while no PR exists (the PR chip links to it). */
function useCreatePrBar(autoMerge: boolean) {
	const t = useT();
	const { git, branchStatus, hasUncommittedChanges, noRemote, noGitHubRemote, baseUnreachable, hasPR } = useGitFacts();
	const disabled = hasPR
		? !branchStatus?.prUrl
		: (noRemote || noGitHubRemote || !branchStatus || branchStatus.ahead === 0 || git.creatingPR);
	const tooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: noRemote
			? t("infoPanel.noRemoteDisabled")
			: noGitHubRemote
				? t("infoPanel.noGitHubRemoteDisabled")
				: baseUnreachable
					? t("infoPanel.baseUnreachableTooltip", { ref: git.displayRef })
					: branchStatus.ahead === 0
						? t(hasUncommittedChanges ? "infoPanel.createPRDisabledUncommitted" : "infoPanel.createPRDisabledNoCommits")
						: t(autoMerge ? "infoPanel.createPRAutoMergeTooltip" : "infoPanel.createPRAgentTooltip");
	return { offered: !hasPR, disabled, tooltip };
}

/** Sheet: a merged or closed PR keeps its "Open PR" row, and Create PR comes back beside it. */
function PrItem() {
	const t = useT();
	const surface = useTaskHeaderSurface();
	const { task, git, ownBranch } = useGitFacts();
	const bar = useCreatePrBar(false);
	const sheet = useSheetPrFacts();
	if (!canRunGitActions(task)) return null;
	if (surface === "sheet") {
		const { prNumber, branchStatus } = sheet;
		const reviewedPr = reviewedPrLink(task, prNumber != null ? { number: prNumber, url: branchStatus?.prUrl ?? "" } : null);
		return (
			<>
				{prNumber != null && (
					<GitSheetRow
						icon={<CreatePRIcon className="h-5 w-5 shrink-0 text-success" />}
						label={t("task.openPR", { number: String(prNumber) })}
						disabled={!branchStatus?.prUrl}
						reason={!branchStatus?.prUrl ? t("infoPanel.statusLoading") : undefined}
						external
						run={() => git.handleOpenPR()}
					/>
				)}
				{reviewedPr && (
					<GitSheetRow
						icon={<CreatePRIcon className="h-5 w-5 shrink-0 text-fg-2" />}
						label={t("task.reviewedPr.open", { number: String(reviewedPr.number) })}
						disabled={false}
						external
						run={() => window.open(reviewedPr.url, "_blank")}
					/>
				)}
				{sheet.canCreate && (
					<GitSheetRow
						icon={<CreatePRIcon className={`h-5 w-5 shrink-0 ${sheet.disabled ? "text-fg-muted" : "text-success"}`} />}
						label={t("infoPanel.createPR")}
						disabled={sheet.disabled}
						reason={sheet.reason}
						run={() => void git.handleCreatePR(false)}
					/>
				)}
			</>
		);
	}
	if (!ownBranch || !bar.offered) return null;
	return (
		<GitBarButton
			tooltip={bar.tooltip}
			detail={t("ttip.git.createPR")}
			disabled={bar.disabled}
			ariaLabel={t("infoPanel.createPR")}
			icon={<CreatePRIcon className={ICON_CLASS} />}
			// Short visible label: the icon carries the semantics, the aria-label stays descriptive.
			label={git.creatingPR ? t("infoPanel.creatingPR") : t("infoPanel.createPRShort")}
			busy={git.creatingPR}
			onClick={() => void git.handleCreatePR(false)}
		/>
	);
}

function AutoPrItem() {
	const t = useT();
	const surface = useTaskHeaderSurface();
	const { task, git, ownBranch } = useGitFacts();
	const bar = useCreatePrBar(true);
	const sheet = useSheetPrFacts();
	if (!canRunGitActions(task)) return null;
	if (surface === "sheet") {
		if (!sheet.canCreate) return null;
		return (
			<GitSheetRow
				icon={<AutoMergeIcon className={`h-5 w-5 shrink-0 ${sheet.disabled ? "text-fg-muted" : "text-success"}`} />}
				label={t("infoPanel.createPRAutoMerge")}
				disabled={sheet.disabled}
				reason={sheet.reason}
				run={() => void git.handleCreatePR(true)}
			/>
		);
	}
	if (!ownBranch || !bar.offered) return null;
	return (
		<GitBarButton
			tooltip={bar.tooltip}
			detail={t("ttip.git.autoMerge")}
			disabled={bar.disabled}
			ariaLabel={t("infoPanel.createPRAutoMerge")}
			icon={<AutoMergeIcon className={ICON_CLASS} />}
			label={git.creatingPR ? t("infoPanel.creatingPR") : t("infoPanel.createPRAutoMergeShort")}
			busy={git.creatingPR}
			onClick={() => void git.handleCreatePR(true)}
		/>
	);
}

/**
 * With an open PR, Merge merges THAT: being behind the base is GitHub's call. The local
 * squash route still needs the rebase, because it commits the base itself.
 */
function MergeItem() {
	const t = useT();
	const surface = useTaskHeaderSurface();
	const { task, git, branchStatus, hasUncommittedChanges, baseUnreachable, ownBranch } = useGitFacts();
	if (!canRunGitActions(task) || !ownBranch) return null;
	const { baseBranch, localMergeBlocked } = git;
	const mergeIsPr = git.mergeRoute === "pull-request";
	const label = mergeIsPr ? t("infoPanel.mergePr") : t("infoPanel.merge");
	const ahead = branchStatus?.ahead ?? 0;
	const behind = branchStatus?.behind ?? 0;
	const blocked = !branchStatus || ahead === 0 || (!mergeIsPr && behind > 0) || localMergeBlocked;
	if (surface === "sheet") {
		return (
			<GitSheetRow
				icon={<MergeIcon className={`h-5 w-5 shrink-0 ${blocked ? "text-fg-muted" : "text-success"}`} />}
				label={label}
				disabled={blocked}
				reason={!branchStatus
					? t("infoPanel.statusLoading")
					: ahead === 0
						? t("infoPanel.mergeDisabledNoCommits")
						: localMergeBlocked
							? t("infoPanel.mergeDisabledSharedFolder")
							: mergeIsPr
								? t("infoPanel.mergePrTooltip", { pr: String(branchStatus.prNumber), branch: baseBranch })
								: behind > 0
									? t("infoPanel.mergeDisabledBehind")
									: undefined}
				run={() => void git.handleMerge()}
			/>
		);
	}
	const tooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: baseUnreachable
			? t("infoPanel.baseUnreachableTooltip", { ref: git.displayRef })
			: ahead === 0
				? t(hasUncommittedChanges ? "infoPanel.mergeDisabledUncommitted" : "infoPanel.mergeDisabledNoCommits")
				: localMergeBlocked
					? t("infoPanel.mergeDisabledSharedFolder")
					: mergeIsPr
						? t("infoPanel.mergePrTooltip", { pr: String(branchStatus.prNumber), branch: baseBranch })
						: behind > 0
							? t("infoPanel.mergeDisabledBehind")
							: t("infoPanel.merge");
	return (
		<GitBarButton
			tooltip={tooltip}
			detail={t("ttip.git.merge")}
			disabled={blocked || git.merging}
			ariaLabel={label}
			icon={<MergeIcon className={ICON_CLASS} />}
			label={git.merging ? t("infoPanel.merging") : label}
			busy={git.merging}
			onClick={git.handleMerge}
			data-tour-anchor="task.merge"
		/>
	);
}

/** Bar only: the sheet refreshes the status every time it opens. */
function RefreshItem() {
	const t = useT();
	const surface = useTaskHeaderSurface();
	const { task } = useTaskHeaderScope();
	const { git } = useTaskHeaderInternals();
	if (surface === "sheet" || !canRunGitActions(task)) return null;
	return (
		<GitActionTooltip content={t("infoPanel.refreshStatus")} detail={t("ttip.git.refresh")} disabled={git.refreshingStatus}>
			<button
				onClick={git.handleRefreshStatus}
				disabled={git.refreshingStatus}
				className={`header-anim inline-flex items-center justify-center p-0.5 rounded text-fg-muted hover:text-fg hover:bg-elevated transition-colors disabled:opacity-40${git.refreshingStatus ? " hdr-rescan-busy" : ""}`}
				aria-label={t("infoPanel.refreshStatus")}
			>
				<RescanIcon className="w-3 h-3" />
			</button>
		</GitActionTooltip>
	);
}

/**
 * The action buttons as one group: a divider, then the `git.actions` items 4px apart,
 * tighter than the bar's 6px gap, never shrinking. On the sheet the rows follow the
 * PR rows in the same order. Every action keeps its own error boundary.
 */
function ActionsItem() {
	const surface = useTaskHeaderSurface();
	const { task } = useTaskHeaderScope();
	if (!canRunGitActions(task)) return null;
	if (surface === "sheet") return <TaskHeaderRegionItems region="git.actions" surface="sheet" />;
	return (
		<>
			<span className="text-fg-muted text-xs flex-shrink-0">|</span>
			<span className="flex items-center gap-1 text-micro flex-shrink-0">
				<TaskHeaderRegionItems region="git.actions" />
			</span>
		</>
	);
}

function item(
	region: TaskHeaderRegion | TaskHeaderGroup,
	id: string,
	order: number,
	component: ComponentType<SlotItemProps>,
	when: (scope: TaskHeaderScope) => boolean,
): TaskHeaderItem {
	return { id: `builtin:git.${id}`, region, order, component, when };
}

/** In bar order; the sheet reads the same order. */
export const BUILTIN_GIT_ITEMS: readonly TaskHeaderItem[] = [
	item("git", "ops-repo", 10, OpsRepoItem, ({ project }) => project.kind === "virtual"),
	item("git", "workflow-off", 20, WorkflowOffItem, ({ project, task }) => project.kind !== "virtual" && !taskUsesWorktree(project, task)),
	item("git", "branch", 30, BranchItem, hasGitRead),
	item("git", "changes", 40, ChangesItem, hasGitRead),
	item("git", "pr-status", 50, PrStatusItem, hasGitRead),
	item("git", "actions", 60, ActionsItem, hasGitWrites),
	item("git.actions", "commit", 10, CommitItem, hasGitWrites),
	item("git.actions", "rebase", 20, RebaseItem, hasGitWrites),
	item("git.actions", "push", 30, PushItem, hasGitWrites),
	item("git.actions", "pr", 40, PrItem, hasGitWrites),
	item("git.actions", "auto-pr", 50, AutoPrItem, hasGitWrites),
	item("git.actions", "merge", 60, MergeItem, hasGitWrites),
	item("git.actions", "refresh", 70, RefreshItem, hasGitWrites),
];

export function registerGitItems(ctx: Context): void {
	for (const def of BUILTIN_GIT_ITEMS) ctx.taskHeader.register(def);
}
