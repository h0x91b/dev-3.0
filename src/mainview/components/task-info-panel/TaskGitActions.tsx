import { createPortal } from "react-dom";
import { cloneElement, useEffect, useMemo, useRef, useState, type Dispatch, type ReactElement, type ReactNode } from "react";
import type { BranchStatus, Project, Task, TaskPRBadgeInfo } from "../../../shared/types";
import type { AppAction, Route } from "../../state";
import { useT } from "../../i18n";
import { api } from "../../rpc";
import { useTaskBranchStatus } from "./useTaskBranchStatus";
import { useReducedMotion } from "../../utils/useReducedMotion";
import Tooltip from "../Tooltip";
import type { TaskInlineDiffRequest } from "../task-inline-diff";
import { AutoMergeIcon, CreatePRIcon, MergeIcon, PushIcon, RebaseIcon, ShowDiffIcon } from "./GitIcons";
import TaskPrStatusPopover from "../TaskPrStatusPopover";

export interface TaskBranchStatusMeta {
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
	showWorktreeCopy?: boolean;
	showLoading?: boolean;
	branchNameClassName?: string;
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
	showWorktreeCopy = false,
	showLoading = false,
	branchNameClassName = "text-fg-3 text-xs font-mono flex-shrink-0",
	compact = false,
	onBranchStatusChange,
	onOpenInlineDiff,
}: TaskGitActionsProps) {
	const t = useT();
	const reducedMotion = useReducedMotion();
	const [copiedPath, setCopiedPath] = useState(false);
	const [refMenuOpen, setRefMenuOpen] = useState(false);
	const [pushedPRStatus, setPushedPRStatus] = useState<TaskPRBadgeInfo | null>(null);
	const initialPrRefreshTaskRef = useRef<string | null>(null);
	const [refMenuPos, setRefMenuPos] = useState({ top: 0, left: 0 });
	const refTriggerRef = useRef<HTMLButtonElement>(null);
	const refMenuRef = useRef<HTMLDivElement>(null);
	const {
		baseBranch,
		branchStatus,
		compareRef,
		creatingPR,
		displayRef,
		handleCreatePR,
		handleMerge,
		handlePush,
		handleRebase,
		handleRefreshStatus,
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
			branchStatus,
			compareRef: compareRef || undefined,
			compareLabel: displayRef,
			prStatus: prInfo,
		});
	}, [branchStatus, compareRef, displayRef, onBranchStatusChange, prInfo]);

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

	useEffect(() => {
		if (!refMenuOpen) {
			return;
		}

		function handleClick(event: MouseEvent) {
			if (
				refMenuRef.current &&
				!refMenuRef.current.contains(event.target as Node) &&
				refTriggerRef.current &&
				!refTriggerRef.current.contains(event.target as Node)
			) {
				setRefMenuOpen(false);
			}
		}

		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [refMenuOpen]);

	function handleCopyPath() {
		if (!task.worktreePath) {
			return;
		}

		navigator.clipboard.writeText(task.worktreePath);
		setCopiedPath(true);
		setTimeout(() => setCopiedPath(false), 1500);
	}

	const refOptions = [
		{ value: "", label: `origin/${baseBranch}` },
		{ value: baseBranch, label: `${baseBranch} (local)` },
	];

	const branchStatusBadge = branchStatus && (branchStatus.ahead > 0 || branchStatus.behind > 0) ? (
		<span className="flex items-center gap-1.5 text-[0.6875rem] flex-shrink-0">
			{branchStatus.behind > 0 && branchStatus.ahead > 0 ? (
				<span className="font-medium">
					<span className="text-success">{branchStatus.ahead} ahead</span>
					<span className="text-fg-muted"> · </span>
					<span className="text-warning">{branchStatus.behind} behind</span>
				</span>
			) : branchStatus.behind > 0 ? (
				<span className="text-warning font-medium">
					{t("infoPanel.commitsBehind", { count: String(branchStatus.behind) })}
				</span>
			) : (
				<span className="text-success font-medium">
					{t("infoPanel.commitsAhead", { count: String(branchStatus.ahead) })}
				</span>
			)}
		</span>
	) : null;

	const prBadge = prInfo ? (
		<TaskPrStatusPopover prInfo={prInfo} projectId={project.id} taskId={task.id}>
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					if (prInfo.url) {
						window.open(prInfo.url, "_blank");
					}
				}}
				className="inline-flex items-center gap-1 text-[0.625rem] font-mono font-semibold text-success bg-success/10 hover:bg-success/20 px-1.5 py-0.5 rounded transition-colors flex-shrink-0"
			>
				<span className="text-[0.6875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0401}"}</span>
				{t("task.prBadge", { number: String(prInfo.number) })}
				{(prInfo.unresolvedCount ?? 0) > 0 && (
					<span className="inline-flex items-center gap-0.5 text-warning" aria-label={t.plural("task.prUnresolvedComments", prInfo.unresolvedCount ?? 0)}>
						<span className="leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF086"}</span>
						<span>{prInfo.unresolvedCount}</span>
					</span>
				)}
			</button>
		</TaskPrStatusPopover>
	) : null;

	const refDropdownButton = branchStatus ? (
		<Tooltip content={t("ttip.git.changeRef")} detail={t("ttip.git.refDropdown")}>
			<button
				ref={refTriggerRef}
				onClick={(event) => {
					event.stopPropagation();
					if (!refMenuOpen && refTriggerRef.current) {
						const rect = refTriggerRef.current.getBoundingClientRect();
						setRefMenuPos({ top: rect.bottom + 4, left: rect.left });
					}
					setRefMenuOpen((open) => !open);
				}}
				className="text-[0.6875rem] text-accent font-normal hover:text-accent-hover transition-colors cursor-pointer flex-shrink-0"
			>
				vs {displayRef} ▾
			</button>
		</Tooltip>
	) : null;

	const refDropdownPortal = refMenuOpen && createPortal(
		<div
			ref={refMenuRef}
			className="fixed bg-overlay border border-edge-active rounded-md shadow-2xl shadow-black/40 py-1 min-w-[10rem]"
			style={{ top: refMenuPos.top, left: refMenuPos.left, zIndex: 9999 }}
			onClick={(event) => event.stopPropagation()}
		>
			{refOptions.map((option) => (
				<button
					key={option.value}
					onClick={(event) => {
						event.stopPropagation();
						selectCompareRef(option.value);
						setRefMenuOpen(false);
					}}
					className={`block w-full text-left px-3 py-1.5 text-[0.6875rem] hover:bg-elevated-hover transition-colors cursor-pointer ${
						compareRef === option.value ? "text-accent font-medium" : "text-fg-2"
					}`}
				>
					{option.label}
				</button>
			))}
		</div>,
		document.body,
	);

	const uncommittedBadge = branchStatus && (branchStatus.insertions > 0 || branchStatus.deletions > 0) ? (
		<span className="flex items-center gap-1 text-[0.6875rem] font-medium text-danger flex-shrink-0">
			<span>+{branchStatus.insertions}</span>
			<span>/</span>
			<span>−{branchStatus.deletions}</span>
		</span>
	) : null;
	const hasUncommittedChanges = !!branchStatus && (branchStatus.insertions > 0 || branchStatus.deletions > 0);

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

	const pushDisabled = !branchStatus || branchStatus.ahead === 0 || pushing;
	const pushTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: branchStatus.ahead === 0
			? t(hasUncommittedChanges ? "infoPanel.pushDisabledUncommitted" : "infoPanel.pushDisabled")
			: t("infoPanel.push");

	const hasPR = prInfo !== null;
	const createPRDisabled = hasPR ? !branchStatus?.prUrl : (!branchStatus || branchStatus.ahead === 0 || creatingPR);

	function getPRButtonLabel(): string {
		if (creatingPR) return t("infoPanel.creatingPR");
		// Short visible label — the icon carries the semantics; the aria-label stays descriptive.
		return t("infoPanel.createPRShort");
	}

	function getPRTooltip(): string {
		if (!branchStatus) return t("infoPanel.statusLoading");
		if (branchStatus.ahead === 0) {
			return t(hasUncommittedChanges ? "infoPanel.createPRDisabledUncommitted" : "infoPanel.createPRDisabledNoCommits");
		}
		return t("infoPanel.createPRAgentTooltip");
	}

	function getPRAutoMergeTooltip(): string {
		if (!branchStatus) return t("infoPanel.statusLoading");
		if (branchStatus.ahead === 0) {
			return t(hasUncommittedChanges ? "infoPanel.createPRDisabledUncommitted" : "infoPanel.createPRDisabledNoCommits");
		}
		return t("infoPanel.createPRAutoMergeTooltip");
	}

	const mergeDisabled = !branchStatus || branchStatus.ahead === 0 || branchStatus.behind > 0 || merging;
	const mergeTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: branchStatus.ahead === 0
			? t(hasUncommittedChanges ? "infoPanel.mergeDisabledUncommitted" : "infoPanel.mergeDisabledNoCommits")
			: branchStatus.behind > 0
				? t("infoPanel.mergeDisabledBehind")
				: t("infoPanel.merge");

	const showDiffDisabled = !onOpenInlineDiff;
	const showDiffTooltip = t("infoPanel.showDiffTooltip", { branch: displayRef });

	const disabledBtnClass = "text-fg-muted/50 cursor-not-allowed bg-raised/50";
	const enabledBtnClass = "text-accent hover:bg-accent/20 bg-accent/10 border border-accent/25";

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
		<span className="flex items-center gap-1 text-[0.6875rem] flex-shrink-0">
			<GitActionTooltip content={showDiffTooltip} detail={t("ttip.infoPanel.showDiff")} disabled={showDiffDisabled}>
				<button
					onClick={() => onOpenInlineDiff?.({
						mode: "branch",
						compareRef: compareRef || undefined,
						compareLabel: displayRef,
					})}
					disabled={showDiffDisabled}
					className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[0.625rem] font-semibold transition-colors ${
						showDiffDisabled ? disabledBtnClass : "text-accent hover:bg-accent/20 bg-accent/10 border border-accent/30"
					}`}
					aria-label={t("infoPanel.showDiff")}
				>
					{btnContent(<ShowDiffIcon className={iconClass} />, t("infoPanel.showDiffShort"))}
				</button>
			</GitActionTooltip>
			<GitActionTooltip content={rebaseTooltip} detail={t("ttip.git.rebase")} disabled={rebaseDisabled}>
				<button
					onClick={handleRebase}
					disabled={rebaseDisabled}
					className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
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
			<GitActionTooltip content={pushTooltip} detail={t("ttip.git.push")} disabled={pushDisabled}>
				<button
					onClick={handlePush}
					disabled={pushDisabled}
					className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
						pushDisabled ? disabledBtnClass : enabledBtnClass
					}`}
					aria-label={t("infoPanel.push")}
				>
					{btnContent(<PushIcon className={iconClass} />, pushing ? t("infoPanel.pushing") : t("infoPanel.push"), pushing)}
				</button>
			</GitActionTooltip>
			{/* When a PR already exists, the "PR #N" badge above already links to it - no Open PR button needed. */}
			{!hasPR && (
				<>
					<GitActionTooltip content={getPRTooltip()} detail={t("ttip.git.createPR")} disabled={createPRDisabled}>
						<button
							onClick={() => void handleCreatePR(false)}
							disabled={createPRDisabled}
							className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
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
							className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
								createPRDisabled ? disabledBtnClass : enabledBtnClass
							}`}
							aria-label={t("infoPanel.createPRAutoMerge")}
						>
							{btnContent(<AutoMergeIcon className={iconClass} />, creatingPR ? t("infoPanel.creatingPR") : t("infoPanel.createPRAutoMergeShort"), creatingPR)}
						</button>
					</GitActionTooltip>
				</>
			)}
			<GitActionTooltip content={mergeTooltip} detail={t("ttip.git.merge")} disabled={mergeDisabled}>
				<button
					onClick={handleMerge}
					disabled={mergeDisabled}
					className={`git-anim inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
						mergeDisabled ? disabledBtnClass : enabledBtnClass
					}`}
					aria-label={t("infoPanel.merge")}
				>
					{btnContent(<MergeIcon className={iconClass} />, merging ? t("infoPanel.merging") : t("infoPanel.merge"), merging)}
				</button>
			</GitActionTooltip>
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

	return (
		<>
			{refDropdownPortal}

			{task.branchName && (
				<span className={branchNameClassName}>
					{task.branchName}
				</span>
			)}

			{showWorktreeCopy && task.worktreePath && (
				<>
					<span className="text-fg-muted text-xs flex-shrink-0">|</span>
					<Tooltip content={copiedPath ? t("infoPanel.pathCopied") : t("infoPanel.copyPath")} detail={t("ttip.infoPanel.copyPath")}>
						<button
							onClick={handleCopyPath}
							className="flex-shrink-0 flex items-center gap-1 p-0.5 rounded hover:bg-elevated transition-colors text-fg-muted hover:text-fg"
							aria-label={copiedPath ? t("infoPanel.pathCopied") : t("infoPanel.copyPath")}
						>
							<span className="text-xs leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uEF81"}</span>
							<span className="text-xs leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
								{copiedPath ? "\u{F012C}" : "\uF0C5"}
							</span>
						</button>
					</Tooltip>
				</>
			)}

			{(branchStatusBadge || refDropdownButton || (showLoading && statusLoading)) && (
				<>
					{task.branchName && <span className="text-fg-muted text-xs flex-shrink-0">|</span>}
					{branchStatusBadge}
					{refDropdownButton}
					{showLoading && statusLoading && (
						<span className="flex items-center gap-1 text-[0.6875rem] text-fg-muted flex-shrink-0">
							<svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
								<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
								<path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
							</svg>
						</span>
					)}
				</>
			)}

			{uncommittedBadge && (
				<>
					<span className="text-fg-muted text-xs flex-shrink-0">|</span>
					{uncommittedBadge}
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
