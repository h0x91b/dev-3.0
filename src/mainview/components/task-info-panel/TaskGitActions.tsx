import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type Dispatch } from "react";
import type { BranchStatus, Project, Task } from "../../../shared/types";
import type { AppAction, Route } from "../../state";
import { useT } from "../../i18n";
import { useTaskBranchStatus } from "./useTaskBranchStatus";
import type { TaskInlineDiffRequest } from "../task-inline-diff";

export interface TaskBranchStatusMeta {
	branchStatus: BranchStatus | null;
	compareRef?: string;
	compareLabel: string;
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
	onBranchStatusChange?: (meta: TaskBranchStatusMeta) => void;
	onOpenInlineDiff?: (request: TaskInlineDiffRequest) => void;
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
	onBranchStatusChange,
	onOpenInlineDiff,
}: TaskGitActionsProps) {
	const t = useT();
	const [copiedPath, setCopiedPath] = useState(false);
	const [refMenuOpen, setRefMenuOpen] = useState(false);
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
		handleOpenPR,
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
		onBranchStatusChange?.({
			branchStatus,
			compareRef: compareRef || undefined,
			compareLabel: displayRef,
		});
	}, [branchStatus, compareRef, displayRef, onBranchStatusChange]);

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

	const prBadge = branchStatus && branchStatus.prNumber !== null ? (
		<button
			onClick={(event) => {
				event.stopPropagation();
				if (branchStatus.prUrl) {
					window.open(branchStatus.prUrl, "_blank");
				}
			}}
			className="inline-flex items-center gap-1 text-[0.625rem] font-mono font-semibold text-success bg-success/10 hover:bg-success/20 px-1.5 py-0.5 rounded transition-colors flex-shrink-0"
			title={t("infoPanel.openPRTooltip", { number: String(branchStatus.prNumber) })}
		>
			<span className="text-[0.6875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0401}"}</span>
			PR #{branchStatus.prNumber}
		</button>
	) : null;

	const refDropdownButton = branchStatus ? (
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
			title="Change comparison branch"
		>
			vs {displayRef} ▾
		</button>
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

	const rebaseDisabled = !branchStatus || branchStatus.behind === 0 || !branchStatus.canRebase || rebasing;
	const rebaseTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: branchStatus.behind === 0
			? t("infoPanel.rebaseDisabled")
			: !branchStatus.canRebase
				? t("infoPanel.rebaseConflicts")
				: t("infoPanel.rebase");

	const pushDisabled = !branchStatus || branchStatus.ahead === 0 || pushing;
	const pushTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: branchStatus.ahead === 0
			? t("infoPanel.pushDisabled")
			: t("infoPanel.push");

	const hasPR = branchStatus && branchStatus.prNumber !== null;
	const createPRDisabled = hasPR ? !branchStatus?.prUrl : (!branchStatus || branchStatus.ahead === 0 || creatingPR);

	function getPRButtonLabel(): string {
		if (creatingPR) return t("infoPanel.creatingPR");
		return t("infoPanel.createPR");
	}

	function getPRTooltip(): string {
		if (!branchStatus) return t("infoPanel.statusLoading");
		if (branchStatus.ahead === 0) return t("infoPanel.createPRDisabledNoCommits");
		return t("infoPanel.createPRAgentTooltip");
	}

	function getPRAutoMergeTooltip(): string {
		if (!branchStatus) return t("infoPanel.statusLoading");
		if (branchStatus.ahead === 0) return t("infoPanel.createPRDisabledNoCommits");
		return t("infoPanel.createPRAutoMergeTooltip");
	}

	const mergeDisabled = !branchStatus || branchStatus.ahead === 0 || branchStatus.behind > 0 || merging;
	const mergeTooltip = !branchStatus
		? t("infoPanel.statusLoading")
		: branchStatus.ahead === 0
			? t("infoPanel.mergeDisabledNoCommits")
			: branchStatus.behind > 0
				? t("infoPanel.mergeDisabledBehind")
				: t("infoPanel.merge");

	const showDiffDisabled = !onOpenInlineDiff;
	const showDiffTooltip = t("infoPanel.showDiffTooltip", { branch: displayRef });

	const disabledBtnClass = "text-fg-muted/50 cursor-not-allowed bg-raised/50";
	const enabledBtnClass = "text-accent hover:bg-accent/20 bg-accent/10 border border-accent/25";

	const gitActionButtons = isTaskActive && task.worktreePath ? (
		<span className="flex items-center gap-1 text-[0.6875rem] flex-shrink-0">
			<button
				onClick={() => onOpenInlineDiff?.({
					mode: "branch",
					compareRef: compareRef || undefined,
					compareLabel: displayRef,
				})}
				disabled={showDiffDisabled}
				className={`px-2 py-0.5 rounded text-[0.625rem] font-semibold transition-colors ${
					showDiffDisabled ? disabledBtnClass : "text-accent hover:bg-accent/20 bg-accent/10 border border-accent/30"
				}`}
				title={showDiffTooltip}
			>
				<span className="inline-flex items-center gap-1.5">
					<span className="text-[0.75rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
						{"\uEC0B"}
					</span>
					<span>{t("infoPanel.showDiff")}</span>
				</span>
			</button>
			<button
				onClick={handleRebase}
				disabled={rebaseDisabled}
				className={`px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
					rebaseDisabled ? disabledBtnClass : enabledBtnClass
				}`}
				title={rebaseTooltip}
			>
				{rebasing ? t("infoPanel.rebasing") : t("infoPanel.rebase")}
			</button>
			<button
				onClick={handlePush}
				disabled={pushDisabled}
				className={`px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
					pushDisabled ? disabledBtnClass : enabledBtnClass
				}`}
				title={pushTooltip}
			>
				{pushing ? t("infoPanel.pushing") : t("infoPanel.push")}
			</button>
			{hasPR ? (
				<button
					onClick={handleOpenPR}
					disabled={!branchStatus?.prUrl}
					className={`px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
						!branchStatus?.prUrl ? disabledBtnClass : "text-success hover:bg-success/20 bg-success/10 border border-success/25"
					}`}
					title={branchStatus?.prUrl ? `PR #${branchStatus.prNumber}` : ""}
				>
					{t("infoPanel.openPR")}
				</button>
			) : (
				<>
					<button
						onClick={() => void handleCreatePR(false)}
						disabled={createPRDisabled}
						className={`px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
							createPRDisabled ? disabledBtnClass : enabledBtnClass
						}`}
						title={getPRTooltip()}
					>
						<span className="inline-flex items-center gap-1.5">
							<span className="text-[0.75rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
								{"\u{F16A6}"}
							</span>
							<span>{getPRButtonLabel()}</span>
						</span>
					</button>
					<button
						onClick={() => void handleCreatePR(true)}
						disabled={createPRDisabled}
						className={`px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
							createPRDisabled ? disabledBtnClass : enabledBtnClass
						}`}
						title={getPRAutoMergeTooltip()}
					>
						<span className="inline-flex items-center gap-1.5">
							<span className="text-[0.75rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
								{"\u{F16A6}"}
							</span>
							<span>{creatingPR ? t("infoPanel.creatingPR") : t("infoPanel.createPRAutoMerge")}</span>
						</span>
					</button>
				</>
			)}
			<button
				onClick={handleMerge}
				disabled={mergeDisabled}
				className={`px-1.5 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${
					mergeDisabled ? disabledBtnClass : enabledBtnClass
				}`}
				title={mergeTooltip}
			>
				{merging ? t("infoPanel.merging") : t("infoPanel.merge")}
			</button>
			<button
				onClick={handleRefreshStatus}
				disabled={refreshingStatus}
				className="p-0.5 rounded text-fg-muted hover:text-fg hover:bg-elevated transition-colors disabled:opacity-40"
				title={t("infoPanel.refreshStatus")}
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
					<button
						onClick={handleCopyPath}
						className="flex-shrink-0 flex items-center gap-1 p-0.5 rounded hover:bg-elevated transition-colors text-fg-muted hover:text-fg"
						title={copiedPath ? t("infoPanel.pathCopied") : t("infoPanel.copyPath")}
					>
						<span className="text-xs leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uEF81"}</span>
						<span className="text-xs leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{copiedPath ? "\u{F012C}" : "\uF0C5"}
						</span>
					</button>
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
