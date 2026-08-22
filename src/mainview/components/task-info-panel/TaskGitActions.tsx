import { createPortal } from "react-dom";
import { cloneElement, useEffect, useMemo, useRef, useState, type Dispatch, type ReactElement, type ReactNode } from "react";
import type { BranchStatus, Project, Task, TaskPRBadgeInfo } from "../../../shared/types";
import type { AppAction, Route } from "../../state";
import { useT } from "../../i18n";
import { api } from "../../rpc";
import { useTaskBranchStatus } from "./useTaskBranchStatus";
import { useViewportClamp } from "../../hooks/useViewportClamp";
import { useReducedMotion } from "../../utils/useReducedMotion";
import Tooltip from "../Tooltip";
import { toast } from "../../toast";
import type { TaskInlineDiffRequest } from "../task-inline-diff";
import { AutoMergeIcon, BranchIcon, CommitIcon, CreatePRIcon, MergeIcon, PushIcon, RebaseIcon, ShowDiffIcon } from "./GitIcons";
import TaskPrStatusPopover from "../TaskPrStatusPopover";

export interface TaskBranchStatusMeta {
	/** Which task this status describes — the panel drops it once they diverge. */
	taskId: string;
	branchStatus: BranchStatus | null;
	compareRef?: string;
	compareLabel: string;
	prStatus?: TaskPRBadgeInfo | null;
}

interface TaskGitActionsProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	isTaskActive: boolean;
	showLoading?: boolean;
	compact?: boolean;
	onBranchStatusChange?: (meta: TaskBranchStatusMeta) => void;
	onOpenInlineDiff?: (request: TaskInlineDiffRequest) => void;
}

type GitActionButton = ReactElement<{
	className?: string;
	"aria-label"?: string;
	"aria-hidden"?: boolean;
	tabIndex?: number;
}>;

/** Placeholder passed into the translated string so the behind half can be split
    off without matching digits that belong to the ahead count. */
const BEHIND_SLOT = "\u0000";

/** Colours the number AND its wording — a lone red digit is easy to miss, the
    whole "N behind" phrase reads as the warning it is. */
function BehindCount({ text, behind }: { text: string; behind: number }) {
	const [before, after = ""] = text.split(BEHIND_SLOT);
	return (
		<>
			{before}
			<span className="text-danger" data-testid="behind-count">{behind}{after}</span>
		</>
	);
}

interface GitActionTooltipProps {
	content: ReactNode;
	detail?: ReactNode;
	disabled: boolean;
	children: GitActionButton;
}

/**
 * Native disabled controls do not dispatch mouse events, so anchor their
 * tooltip to a focusable wrapper while keeping the real button disabled.
 */
function GitActionTooltip({ content, detail, disabled, children }: GitActionTooltipProps) {
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
			<span
				className="inline-flex"
				role="button"
				aria-disabled="true"
				aria-label={children.props["aria-label"]}
				tabIndex={0}
			>
				{disabledButton}
			</span>
		</Tooltip>
	);
}

export default function TaskGitActions({
	task,
	project,
	dispatch,
	navigate,
	isTaskActive,
	showLoading = false,
	compact = false,
	onBranchStatusChange,
	onOpenInlineDiff,
}: TaskGitActionsProps) {
	const t = useT();
	const reducedMotion = useReducedMotion();
	const [branchMenuOpen, setBranchMenuOpen] = useState(false);
	const [branchMenuPos, setBranchMenuPos] = useState({ top: 0, left: 0 });
	const branchTriggerRef = useRef<HTMLButtonElement>(null);
	const branchMenuRef = useRef<HTMLDivElement>(null);
	const { position: branchMenuClamped, visible: branchMenuVisible } = useViewportClamp(branchMenuRef, branchMenuPos);
	const [pushedPRStatus, setPushedPRStatus] = useState<TaskPRBadgeInfo | null>(null);
	const initialPrRefreshTaskRef = useRef<string | null>(null);
	const {
		baseBranch,
		branchStatus,
		committing,
		compareRef,
		creatingPR,
		displayRef,
		handleCommit,
		handleCreatePR,
		handleMerge,
		handlePush,
		handleRebase,
		handleRefreshStatus,
		mergeRoute,
		merging,
		pushing,
		rebasing,
		refreshingStatus,
		selectCompareRef,
		statusLoading,
	} = useTaskBranchStatus({
		task,
		project,
		dispatch,
		navigate,
		isTaskActive,
	});

	// Switching tasks reuses this component instance (no `key={task.id}`), and
	// `rpc:taskPrStatus` pushes arrive only for the task being viewed — so a
	// status pushed while viewing the previous task would keep rendering its PR
	// badge on the next task forever (a task without its own PR never gets an
	// overwriting push). Clear it eagerly on every task switch.
	useEffect(() => {
		setPushedPRStatus(null);
	}, [task.id]);

	useEffect(() => {
		function onPrStatus(event: Event) {
			const detail = (event as CustomEvent).detail as {
				projectId?: string;
				taskId?: string;
				prNumber: number | null;
				prUrl: string | null;
				autoMergeEnabled?: TaskPRBadgeInfo["autoMergeEnabled"];
				ciStatus: TaskPRBadgeInfo["ciStatus"];
				reviewState: TaskPRBadgeInfo["reviewState"];
				reviewDecision?: TaskPRBadgeInfo["reviewDecision"];
				unresolvedCount: TaskPRBadgeInfo["unresolvedCount"];
				mergeState: TaskPRBadgeInfo["mergeState"];
				checks: TaskPRBadgeInfo["checks"];
				prTitle: TaskPRBadgeInfo["prTitle"];
				isDraft: TaskPRBadgeInfo["isDraft"];
			};
			if (detail.projectId !== project.id || detail.taskId !== task.id || detail.prNumber == null) return;
			setPushedPRStatus({
				number: detail.prNumber,
				url: detail.prUrl ?? "",
				autoMergeEnabled: detail.autoMergeEnabled,
				ciStatus: detail.ciStatus,
				reviewState: detail.reviewState,
				reviewDecision: detail.reviewDecision,
				unresolvedCount: detail.unresolvedCount,
				mergeState: detail.mergeState,
				checks: detail.checks ?? [],
				prTitle: detail.prTitle,
				isDraft: detail.isDraft,
			});
		}
		window.addEventListener("rpc:taskPrStatus", onPrStatus);
		return () => window.removeEventListener("rpc:taskPrStatus", onPrStatus);
	}, [project.id, task.id]);

	const prInfo = useMemo<TaskPRBadgeInfo | null>(
		() => pushedPRStatus
			?? (branchStatus?.prNumber != null
				? {
					number: branchStatus.prNumber,
					url: branchStatus.prUrl ?? "",
					ciStatus: null,
					reviewState: null,
				}
				: task.prNumber != null
					? {
						number: task.prNumber,
						url: task.prUrl ?? "",
					}
					: null),
		[pushedPRStatus, branchStatus, task.prNumber, task.prUrl],
	);

	useEffect(() => {
		onBranchStatusChange?.({
			taskId: task.id,
			branchStatus,
			compareRef: compareRef || undefined,
			compareLabel: displayRef,
			prStatus: prInfo,
		});
	}, [branchStatus, compareRef, displayRef, onBranchStatusChange, prInfo, task.id]);

	// A task can be opened after the background poller's last push. Once the
	// branch check (or sticky task fields) identifies a PR, hydrate the inspector
	// with the same rich status without requiring the user to press Refresh.
	useEffect(() => {
		if (!isTaskActive || !task.worktreePath || initialPrRefreshTaskRef.current === task.id) return;
		const prNumber = task.prNumber ?? branchStatus?.prNumber;
		const prUrl = task.prUrl ?? branchStatus?.prUrl;
		if (prNumber == null || !prUrl) return;

		initialPrRefreshTaskRef.current = task.id;
		void api.request.refreshTaskPrStatus({ taskId: task.id, projectId: project.id }).catch(() => {
			if (initialPrRefreshTaskRef.current === task.id) initialPrRefreshTaskRef.current = null;
		});
	}, [branchStatus?.prNumber, branchStatus?.prUrl, isTaskActive, project.id, task.id, task.prNumber, task.prUrl, task.worktreePath]);

	/**
	 * Copy feedback is a toast, not a tooltip swap: the old confirmation lived
	 * inside the branch button's tooltip, so it was invisible unless the pointer
	 * happened to still hover the thing you just clicked.
	 */
	function copyToClipboard(value: string, confirmation: string) {
		void navigator.clipboard
			.writeText(value)
			// Only claim success once the write resolved — a denied clipboard used to
			// leave the user with a confirmation and an empty buffer.
			.then(() => toast.success(confirmation, { taskId: task.id }))
			.catch(() => toast.error(t("infoPanel.copyFailed"), { taskId: task.id }));
		setBranchMenuOpen(false);
	}

	// Close on click outside / Escape, same contract as every other menu here.
	useEffect(() => {
		if (!branchMenuOpen) return;

		function onMouseDown(event: MouseEvent) {
			const target = event.target as Node;
			if (branchMenuRef.current?.contains(target) || branchTriggerRef.current?.contains(target)) return;
			setBranchMenuOpen(false);
		}
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") setBranchMenuOpen(false);
		}

		// Capture phase: the terminal swallows mousedown before it bubbles to document.
		document.addEventListener("mousedown", onMouseDown, true);
		window.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("mousedown", onMouseDown, true);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [branchMenuOpen]);

	useEffect(() => {
		setBranchMenuOpen(false);
	}, [task.id]);

	const branchStatusBadge = branchStatus && (branchStatus.ahead > 0 || branchStatus.behind > 0) ? (
		<span className="flex items-center gap-1.5 text-micro flex-shrink-0">
			{/* Only the behind count is a verdict — it means "rebase needed", so the
			    number is red while the wording around it stays a muted readout. */}
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
						text={t("infoPanel.commitsBehind", { count: BEHIND_SLOT })}
						behind={branchStatus.behind}
					/>
				</span>
			) : (
				<span className="text-fg-3 font-medium">
					{t("infoPanel.commitsAhead", { count: String(branchStatus.ahead) })}
				</span>
			)}
		</span>
	) : null;

	const openUnresolvedInDiff = onOpenInlineDiff
		? () => onOpenInlineDiff({
			mode: "branch",
			compareRef: compareRef || undefined,
			compareLabel: displayRef,
			focusFirstUnresolvedThread: true,
		})
		: undefined;

	const prBadge = prInfo ? (
		<TaskPrStatusPopover prInfo={prInfo} projectId={project.id} taskId={task.id} onShowUnresolved={openUnresolvedInDiff}>
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					if (prInfo.url) {
						window.open(prInfo.url, "_blank");
					}
				}}
				className="inline-flex items-center gap-1 text-dense font-mono font-semibold text-success bg-success/10 hover:bg-success/20 px-1.5 py-0.5 rounded transition-colors flex-shrink-0"
			>
				<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0401}"}</span>
				{t("task.prBadge", { number: String(prInfo.number) })}
				{(prInfo.unresolvedCount ?? 0) > 0 && (
					<span className="inline-flex items-center gap-0.5 text-warning-strong" aria-label={t.plural("task.prUnresolvedComments", prInfo.unresolvedCount ?? 0)}>
						<span className="leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF086"}</span>
						<span>{prInfo.unresolvedCount}</span>
					</span>
				)}
			</button>
		</TaskPrStatusPopover>
	) : null;

	const uncommittedBadge = branchStatus && (branchStatus.insertions > 0 || branchStatus.deletions > 0) ? (
		<span className="flex items-center gap-1 text-micro font-medium flex-shrink-0">
			<span className="text-success">+{branchStatus.insertions}</span>
			<span className="text-fg-muted">/</span>
			<span className="text-danger">−{branchStatus.deletions}</span>
		</span>
	) : null;
	const hasUncommittedChanges = !!branchStatus && (branchStatus.insertions > 0 || branchStatus.deletions > 0);

	const commitDisabled = !branchStatus || !hasUncommittedChanges || committing;
	const commitTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: !hasUncommittedChanges
			? t("infoPanel.commitDisabledClean")
			: t("infoPanel.commitAgentTooltip");

	// A conflicting rebase (behind but can't apply cleanly) no longer disables the
	// button — it hands the rebase off to the agent instead. Only "nothing to
	// rebase" / no-status / in-flight disable it.
	const rebaseNeedsAgent = !!branchStatus && branchStatus.behind > 0 && !branchStatus.canRebase;
	const rebaseDisabled = !branchStatus || branchStatus.behind === 0 || rebasing;
	const rebaseTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: branchStatus.behind === 0
			? t("infoPanel.rebaseDisabled")
			: rebaseNeedsAgent
				? t("infoPanel.rebaseViaAgent")
				: t("infoPanel.rebase");

	// A repo with no `origin` cannot be pushed and has nowhere to open a PR. The
	// buttons used to stay live and fail on click, which reads as a broken app
	// rather than as a project that was never connected to a remote.
	const noRemote = branchStatus?.hasRemote === false;
	// `gh` is the only forge client dev3 speaks, so a GitLab/Gitea origin gets no PR
	// button rather than one whose agent prompt cannot run.
	const noGitHubRemote = !!branchStatus && branchStatus.hasRemote && !branchStatus.remoteIsGitHub;

	// A foreign-code task exists to READ commits the local user did not write, so
	// the three write actions are gone rather than disabled — a greyed-out Push on
	// a colleague's branch still invites a click and an explanation.
	const ownBranch = !task.foreignCode;

	// origin/<branch> holds commits HEAD does not: a plain push is refused as
	// non-fast-forward. The backend escalates to a leased force push off this same
	// number, so the label and the command cannot disagree.
	const pushIsForced = !!branchStatus && branchStatus.hasRemote && branchStatus.remoteAhead > 0;

	const pushDisabled = noRemote || !branchStatus || branchStatus.ahead === 0 || pushing;
	const pushTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: noRemote
			? t("infoPanel.noRemoteDisabled")
			: pushIsForced
				? t("infoPanel.forcePushTooltip", { branch: task.branchName ?? "" })
				: branchStatus.ahead === 0
					? t(hasUncommittedChanges ? "infoPanel.pushDisabledUncommitted" : "infoPanel.pushDisabled")
					: t("infoPanel.push");

	const hasPR = prInfo !== null;
	const createPRDisabled = hasPR
		? !branchStatus?.prUrl
		: (noRemote || noGitHubRemote || !branchStatus || branchStatus.ahead === 0 || creatingPR);

	function getPRButtonLabel(): string {
		if (creatingPR) return t("infoPanel.creatingPR");
		// Short visible label — the icon carries the semantics; the aria-label stays descriptive.
		return t("infoPanel.createPRShort");
	}

	function getPRTooltip(): string {
		if (!branchStatus) return t("infoPanel.statusLoading");
		if (noRemote) return t("infoPanel.noRemoteDisabled");
		if (noGitHubRemote) return t("infoPanel.noGitHubRemoteDisabled");
		if (branchStatus.ahead === 0) {
			return t(hasUncommittedChanges ? "infoPanel.createPRDisabledUncommitted" : "infoPanel.createPRDisabledNoCommits");
		}
		return t("infoPanel.createPRAgentTooltip");
	}

	function getPRAutoMergeTooltip(): string {
		if (!branchStatus) return t("infoPanel.statusLoading");
		if (noRemote) return t("infoPanel.noRemoteDisabled");
		if (noGitHubRemote) return t("infoPanel.noGitHubRemoteDisabled");
		if (branchStatus.ahead === 0) {
			return t(hasUncommittedChanges ? "infoPanel.createPRDisabledUncommitted" : "infoPanel.createPRDisabledNoCommits");
		}
		return t("infoPanel.createPRAutoMergeTooltip");
	}

	// With an open PR, Merge merges THAT (see `mergeRoute`): being behind the base is
	// GitHub's problem to judge, not a reason to demand a local rebase first. The
	// local squash route still needs the rebase, because it commits the base itself.
	const mergeIsPr = mergeRoute === "pull-request";
	const mergeDisabled = !branchStatus || branchStatus.ahead === 0 || (!mergeIsPr && branchStatus.behind > 0) || merging;
	const mergeLabel = mergeIsPr ? t("infoPanel.mergePr") : t("infoPanel.merge");
	const mergeTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: branchStatus.ahead === 0
			? t(hasUncommittedChanges ? "infoPanel.mergeDisabledUncommitted" : "infoPanel.mergeDisabledNoCommits")
			: mergeIsPr
				? t("infoPanel.mergePrTooltip", { pr: String(branchStatus.prNumber), branch: baseBranch })
				: branchStatus.behind > 0
					? t("infoPanel.mergeDisabledBehind")
					: t("infoPanel.merge");

	const showDiffDisabled = !onOpenInlineDiff;
	const showDiffTooltip = t("infoPanel.showDiffTooltip", { branch: displayRef });

	const openBranchDiff = () => onOpenInlineDiff?.({
		mode: "branch",
		compareRef: compareRef || undefined,
		compareLabel: displayRef,
	});

	/**
	 * Ahead / behind and the uncommitted line counts are one statement about the
	 * same branch, so they share one control with no separator between them — and
	 * that control opens the diff, which is what the numbers make you want to do.
	 * Which ref they compare against lives in the tooltip now; the project setting
	 * owns the choice (Project Settings → compare ref).
	 */
	const changesSummary = branchStatusBadge || uncommittedBadge ? (
		showDiffDisabled ? (
			<span className="flex items-center gap-1.5 flex-shrink-0">
				{branchStatusBadge}
				{uncommittedBadge}
			</span>
		) : (
			<Tooltip content={showDiffTooltip} detail={t("ttip.infoPanel.showDiff")}>
				<button
					onClick={openBranchDiff}
					className="git-anim flex items-center gap-1.5 flex-shrink-0 rounded px-1 py-0.5 hover:bg-elevated transition-colors"
					aria-label={showDiffTooltip}
				>
					{branchStatusBadge}
					{uncommittedBadge}
				</button>
			</Tooltip>
		)
	) : null;

	const disabledBtnClass = "text-fg-muted/50 cursor-not-allowed bg-raised/50";
	// Neutral like the rest of the session bar (see the #1418 pass): the colour in this
	// row belongs to the status badges (ahead/behind, PR, conflicts), not to the actions.
	const enabledBtnClass = "text-fg-3 hover:text-fg hover:bg-elevated border border-edge";
	// The one action in this row that rewrites published history earns the danger
	// colour, and it is exactly the state in which the label also changes.
	const dangerBtnClass = "text-danger hover:bg-danger/10 border border-danger/40";

	const gitIcon = (icon: ReactNode, spin = false) => (
		// Fixed square slot so the idle icon and the in-progress ring share one footprint
		// (the icon does not shift sideways when the spin starts) and both stay centered.
		<span
			className="inline-flex items-center justify-center w-[0.85rem] h-[0.85rem]"
			aria-hidden="true"
		>
			{spin ? (
				// Circular ring spinner: radially symmetric, so animate-spin rotates it perfectly
				// around its own center — zero wobble.
				<span
					className={`w-2.5 h-2.5 rounded-full border-2 border-current/30 border-t-current${reducedMotion ? "" : " animate-spin"}`}
				/>
			) : (
				icon
			)}
		</span>
	);

	const iconClass = "w-[0.85rem] h-[0.85rem]";

	// Compact = icon only; full = icon + label. Every git button now carries an icon.
	const btnContent = (icon: ReactNode, label: string, spin = false) =>
		compact ? (
			gitIcon(icon, spin)
		) : (
			<span className="inline-flex items-center gap-1">
				{gitIcon(icon, spin)}
				<span>{label}</span>
			</span>
		);

	const gitActionButtons = isTaskActive && task.worktreePath ? (
		<span className="flex items-center gap-1 text-micro flex-shrink-0">
			<GitActionTooltip content={showDiffTooltip} detail={t("ttip.infoPanel.showDiff")} disabled={showDiffDisabled}>
				<button
					onClick={openBranchDiff}
					disabled={showDiffDisabled}
					className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-dense font-semibold transition-colors ${
						showDiffDisabled ? disabledBtnClass : enabledBtnClass
					}`}
					aria-label={t("infoPanel.showDiff")}
				>
					{btnContent(<ShowDiffIcon className={iconClass} />, t("infoPanel.showDiffShort"))}
				</button>
			</GitActionTooltip>
			<GitActionTooltip content={commitTooltip} detail={t("ttip.git.commit")} disabled={commitDisabled}>
					<button
						onClick={() => void handleCommit()}
						disabled={commitDisabled}
						className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-dense font-medium transition-colors ${
							commitDisabled ? disabledBtnClass : enabledBtnClass
						}`}
						aria-label={t("infoPanel.commit")}
					>
						{btnContent(<CommitIcon className={iconClass} />, committing ? t("infoPanel.committing") : t("infoPanel.commit"), committing)}
					</button>
				</GitActionTooltip>
				<GitActionTooltip content={rebaseTooltip} detail={t("ttip.git.rebase")} disabled={rebaseDisabled}>
				<button
					onClick={handleRebase}
					disabled={rebaseDisabled}
					className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-dense font-medium transition-colors ${
						rebaseDisabled ? disabledBtnClass : enabledBtnClass
					}`}
					aria-label={rebaseNeedsAgent ? t("infoPanel.rebaseViaAgent") : t("infoPanel.rebase")}
				>
					{btnContent(
						<RebaseIcon className={iconClass} />,
						rebasing
							? t("infoPanel.rebasing")
							: rebaseNeedsAgent
								? t("infoPanel.rebaseViaAgentShort")
								: t("infoPanel.rebase"),
						rebasing,
					)}
				</button>
			</GitActionTooltip>
			{ownBranch && (
			<GitActionTooltip content={pushTooltip} detail={t("ttip.git.push")} disabled={pushDisabled}>
				<button
					onClick={handlePush}
					disabled={pushDisabled}
					className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-dense font-medium transition-colors ${
						pushDisabled ? disabledBtnClass : pushIsForced ? dangerBtnClass : enabledBtnClass
					}`}
					aria-label={pushIsForced ? t("infoPanel.forcePush") : t("infoPanel.push")}
				>
					{btnContent(
						<PushIcon className={iconClass} />,
						pushing
							? t("infoPanel.pushing")
							: pushIsForced
								? t("infoPanel.forcePush")
								: t("infoPanel.push"),
						pushing,
					)}
				</button>
			</GitActionTooltip>
			)}
			{/* When a PR already exists, the "PR #N" badge above already links to it - no Open PR button needed. */}
			{ownBranch && !hasPR && (
				<>
					<GitActionTooltip content={getPRTooltip()} detail={t("ttip.git.createPR")} disabled={createPRDisabled}>
						<button
							onClick={() => void handleCreatePR(false)}
							disabled={createPRDisabled}
							className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-dense font-medium transition-colors ${
								createPRDisabled ? disabledBtnClass : enabledBtnClass
							}`}
							aria-label={t("infoPanel.createPR")}
						>
							{btnContent(<CreatePRIcon className={iconClass} />, getPRButtonLabel(), creatingPR)}
						</button>
					</GitActionTooltip>
					<GitActionTooltip content={getPRAutoMergeTooltip()} detail={t("ttip.git.autoMerge")} disabled={createPRDisabled}>
						<button
							onClick={() => void handleCreatePR(true)}
							disabled={createPRDisabled}
							className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-dense font-medium transition-colors ${
								createPRDisabled ? disabledBtnClass : enabledBtnClass
							}`}
							aria-label={t("infoPanel.createPRAutoMerge")}
						>
							{btnContent(<AutoMergeIcon className={iconClass} />, creatingPR ? t("infoPanel.creatingPR") : t("infoPanel.createPRAutoMergeShort"), creatingPR)}
						</button>
					</GitActionTooltip>
				</>
			)}
			{ownBranch && (
			<GitActionTooltip content={mergeTooltip} detail={t("ttip.git.merge")} disabled={mergeDisabled}>
				<button
					onClick={handleMerge}
					disabled={mergeDisabled}
					className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-dense font-medium transition-colors ${
						mergeDisabled ? disabledBtnClass : enabledBtnClass
					}`}
					aria-label={mergeLabel}
				>
					{btnContent(<MergeIcon className={iconClass} />, merging ? t("infoPanel.merging") : mergeLabel, merging)}
				</button>
			</GitActionTooltip>
			)}
			<GitActionTooltip content={t("infoPanel.refreshStatus")} detail={t("ttip.git.refresh")} disabled={refreshingStatus}>
				<button
					onClick={handleRefreshStatus}
					disabled={refreshingStatus}
					className="inline-flex items-center justify-center p-0.5 rounded text-fg-muted hover:text-fg hover:bg-elevated transition-colors disabled:opacity-40"
					aria-label={t("infoPanel.refreshStatus")}
				>
					<svg
						className={`w-3 h-3 ${refreshingStatus ? "animate-spin" : ""}`}
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
							d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
					</svg>
				</button>
			</GitActionTooltip>
		</span>
	) : null;

	/**
	 * The branch name used to sit in the bar as bare mono text: ~200px of width, no
	 * affordance, and a tail-truncated string that hid the informative half. It is a
	 * labelled chip now — the full name heads the menu it opens, and the menu names
	 * every copy action in words instead of a Nerd Font glyph nobody decodes.
	 * "Open in Finder" is deliberately absent: TaskOpenIn already owns that.
	 */
	const branchMenuItems = task.branchName
		? [
			{ key: "branch", label: t("infoPanel.copyBranchItem"), value: task.branchName, done: t("infoPanel.branchCopied") },
			...(task.worktreePath
				? [{ key: "path", label: t("infoPanel.copyPathItem"), value: task.worktreePath, done: t("infoPanel.worktreePathCopied") }]
				: []),
			{
				key: "checkout",
				label: t("infoPanel.copyCheckoutItem"),
				value: `git checkout ${task.branchName}`,
				done: t("infoPanel.checkoutCopied"),
			},
			// The PR badge opens the PR; pasting its URL somewhere else needed a
			// round trip through the browser address bar until now.
			...(prInfo?.url
				? [{ key: "pr", label: t("infoPanel.copyPrLinkItem"), value: prInfo.url, done: t("infoPanel.prLinkCopied") }]
				: []),
		]
		: [];

	/**
	 * The compare-ref picker is back — inside the menu this time. It used to print
	 * "vs origin/main ▾" in the bar, spending permanent width to state a setting the
	 * project already owns; here it costs nothing until the menu is open.
	 */
	// With no remote there is no `origin/<base>` to offer: the row would tick a ref
	// that does not exist, and picking it would compare against nothing.
	const compareOptions = noRemote
		? [{ value: "", ref: baseBranch, label: baseBranch }]
		: [
			{ value: "", ref: `origin/${baseBranch}`, label: `origin/${baseBranch}` },
			{ value: baseBranch, ref: baseBranch, label: t("infoPanel.compareRefLocal", { branch: baseBranch }) },
		];
	// Match on the RESOLVED ref, never on the raw value: a project whose default is
	// spelled "origin/main" holds that string in `compareRef`, while the remote option
	// carries "" (meaning "the default"), so a raw comparison ticks neither row.

	const branchChip = task.branchName ? (
		<Tooltip content={task.branchName} detail={t("ttip.infoPanel.branchChip")}>
			<button
				ref={branchTriggerRef}
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					if (!branchMenuOpen && branchTriggerRef.current) {
						const rect = branchTriggerRef.current.getBoundingClientRect();
						setBranchMenuPos({ top: rect.bottom + 4, left: rect.left });
					}
					setBranchMenuOpen((open) => !open);
				}}
				className={`git-anim flex items-center gap-1 flex-shrink-0 rounded px-1.5 py-0.5 text-micro border transition-colors ${
					branchMenuOpen
						? "text-fg bg-elevated border-edge-active"
						: "text-fg-3 border-edge bg-raised/60 hover:text-fg hover:bg-elevated hover:border-edge-active"
				}`}
				aria-label={t("infoPanel.branchMenuLabel", { branch: task.branchName })}
				aria-haspopup="menu"
				aria-expanded={branchMenuOpen}
				data-testid="branch-chip"
			>
				<BranchIcon className="w-3 h-3" />
				<span className="font-medium">{t("infoPanel.branchChip")}</span>
				<span aria-hidden="true" className="opacity-70">▾</span>
			</button>
		</Tooltip>
	) : null;

	const branchMenuPortal = branchMenuOpen && task.branchName && createPortal(
		<div
			ref={branchMenuRef}
			role="menu"
			className="fixed bg-overlay border border-edge-active rounded-lg shadow-2xl shadow-black/40 py-1 min-w-[13rem] max-w-[calc(100vw-1rem)]"
			style={{
				top: branchMenuClamped.top,
				left: branchMenuClamped.left,
				zIndex: 9999,
				visibility: branchMenuVisible ? "visible" : "hidden",
			}}
			onClick={(event) => event.stopPropagation()}
		>
			<div className="px-3 pb-1.5 pt-1 mb-1 border-b border-edge font-mono text-micro text-fg-muted break-all">
				{task.branchName}
			</div>
			{branchMenuItems.map((item) => (
				<button
					key={item.key}
					role="menuitem"
					type="button"
					onClick={() => copyToClipboard(item.value, item.done)}
					className="git-anim block w-full text-left px-3 py-1.5 text-micro text-fg-2 hover:bg-elevated-hover hover:text-fg transition-colors"
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
							setBranchMenuOpen(false);
						}}
						className={`git-anim flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-micro transition-colors hover:bg-elevated-hover ${
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
			{branchMenuPortal}
			{branchChip}

			{(branchStatusBadge || uncommittedBadge || (showLoading && statusLoading)) && (
				<>
					{task.branchName && <span className="text-fg-muted text-xs flex-shrink-0">|</span>}
					{changesSummary}
					{showLoading && statusLoading && (
						<span className="flex items-center gap-1 text-micro text-fg-muted flex-shrink-0">
							<svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
								<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
								<path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
							</svg>
						</span>
					)}
				</>
			)}

			{prBadge}

			{gitActionButtons && (
				<>
					<span className="text-fg-muted text-xs flex-shrink-0">|</span>
					{gitActionButtons}
				</>
			)}
		</>
	);
}
