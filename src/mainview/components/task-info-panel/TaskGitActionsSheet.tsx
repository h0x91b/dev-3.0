import type { Dispatch, ReactNode } from "react";
import type { Project, Task } from "../../../shared/types";
import type { AppAction, Route } from "../../state";
import { useT } from "../../i18n";
import { useTaskBranchStatus } from "./useTaskBranchStatus";
import { AutoMergeIcon, CreatePRIcon, MergeIcon, PushIcon, RebaseIcon, ShowDiffIcon } from "./GitIcons";
import type { TaskInlineDiffRequest } from "../task-inline-diff";

interface TaskGitActionsSheetProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	isTaskActive: boolean;
	/** Full-width row class shared with the rest of the mobile actions sheet. */
	rowClassName: string;
	onOpenInlineDiff?: (request: TaskInlineDiffRequest) => void;
	/** Dismiss the sheet after a git action is triggered so the terminal / PR is visible. */
	onAction: () => void;
}

interface GitRow {
	key: string;
	icon: ReactNode;
	label: string;
	disabled: boolean;
	/** Muted one-liner explaining why the row is disabled (no hover tooltips on touch). */
	reason?: string;
	external?: boolean;
	run: () => void;
}

/**
 * Git actions as full-width rows for the narrow-viewport (mobile) task actions
 * BottomSheet. The desktop equivalent is the inspector Git bar (`TaskGitActions`);
 * both are driven by the same `useTaskBranchStatus` hook. Per the mobile doctrine
 * (Bible §12.3) the inspector bars' actions become sheet sections on narrow, and
 * §12.4 forbids touch-unreachable actions — so PR / rebase / push / merge live
 * here, matching the git_action `secondary` token role (§6). Tapping any row runs
 * the action and dismisses the sheet, so the visible terminal / PR is what the
 * user lands on (rebase and PR creation run in the task terminal / via the agent).
 */
export default function TaskGitActionsSheet({
	task,
	project,
	dispatch,
	navigate,
	isTaskActive,
	rowClassName,
	onOpenInlineDiff,
	onAction,
}: TaskGitActionsSheetProps) {
	const t = useT();
	const {
		branchStatus,
		compareRef,
		displayRef,
		handleCreatePR,
		handleMerge,
		handleOpenPR,
		handlePush,
		handleRebase,
		statusLoading,
	} = useTaskBranchStatus({ task, project, dispatch, navigate, isTaskActive });

	// Git mutations only make sense on a real, active worktree. Virtual boards have
	// no git domain at all (Bible §3) — the caller already gates on kind, but keep
	// the component self-contained.
	if (project.kind === "virtual" || !isTaskActive || !task.worktreePath) {
		return null;
	}

	const hasPR = !!(branchStatus?.prNumber != null || task.prNumber != null);
	const prNumber = branchStatus?.prNumber ?? task.prNumber ?? null;
	const ahead = branchStatus?.ahead ?? 0;
	const behind = branchStatus?.behind ?? 0;
	const rebaseNeedsAgent = !!branchStatus && behind > 0 && !branchStatus.canRebase;

	const withDismiss = (fn: () => void) => () => {
		fn();
		onAction();
	};

	const rows: GitRow[] = [];

	if (onOpenInlineDiff) {
		rows.push({
			key: "diff",
			icon: <ShowDiffIcon className="h-5 w-5 shrink-0 text-accent" />,
			label: t("infoPanel.showDiff"),
			disabled: false,
			external: true,
			run: withDismiss(() =>
				onOpenInlineDiff({
					mode: "branch",
					compareRef: compareRef || undefined,
					compareLabel: displayRef,
				}),
			),
		});
	}

	rows.push({
		key: "rebase",
		icon: <RebaseIcon className={`h-5 w-5 shrink-0 ${!branchStatus || behind === 0 ? "text-fg-muted" : "text-accent"}`} />,
		label: rebaseNeedsAgent ? t("infoPanel.rebaseViaAgentShort") : t("infoPanel.rebase"),
		disabled: !branchStatus || behind === 0,
		reason: !branchStatus ? t("infoPanel.statusLoading") : behind === 0 ? t("infoPanel.rebaseDisabled") : undefined,
		run: withDismiss(() => void handleRebase()),
	});

	rows.push({
		key: "push",
		icon: <PushIcon className={`h-5 w-5 shrink-0 ${!branchStatus || ahead === 0 ? "text-fg-muted" : "text-accent"}`} />,
		label: t("infoPanel.push"),
		disabled: !branchStatus || ahead === 0,
		reason: !branchStatus ? t("infoPanel.statusLoading") : ahead === 0 ? t("infoPanel.pushDisabled") : undefined,
		run: withDismiss(() => void handlePush()),
	});

	if (hasPR) {
		rows.push({
			key: "open-pr",
			icon: <CreatePRIcon className="h-5 w-5 shrink-0 text-success" />,
			label: prNumber != null ? t("task.openPR", { number: String(prNumber) }) : t("infoPanel.openPR"),
			disabled: !branchStatus?.prUrl,
			reason: !branchStatus?.prUrl ? t("infoPanel.statusLoading") : undefined,
			external: true,
			run: withDismiss(() => handleOpenPR()),
		});
	} else {
		const prDisabled = !branchStatus || ahead === 0;
		const prReason = !branchStatus
			? t("infoPanel.statusLoading")
			: ahead === 0
				? t("infoPanel.createPRDisabledNoCommits")
				: undefined;
		rows.push({
			key: "create-pr",
			icon: <CreatePRIcon className={`h-5 w-5 shrink-0 ${prDisabled ? "text-fg-muted" : "text-success"}`} />,
			label: t("infoPanel.createPR"),
			disabled: prDisabled,
			reason: prReason,
			run: withDismiss(() => void handleCreatePR(false)),
		});
		rows.push({
			key: "create-pr-automerge",
			icon: <AutoMergeIcon className={`h-5 w-5 shrink-0 ${prDisabled ? "text-fg-muted" : "text-success"}`} />,
			label: t("infoPanel.createPRAutoMerge"),
			disabled: prDisabled,
			reason: prReason,
			run: withDismiss(() => void handleCreatePR(true)),
		});
	}

	rows.push({
		key: "merge",
		icon: <MergeIcon className={`h-5 w-5 shrink-0 ${!branchStatus || ahead === 0 || behind > 0 ? "text-fg-muted" : "text-success"}`} />,
		label: t("infoPanel.merge"),
		disabled: !branchStatus || ahead === 0 || behind > 0,
		reason: !branchStatus
			? t("infoPanel.statusLoading")
			: behind > 0
				? t("infoPanel.mergeDisabledBehind")
				: ahead === 0
					? t("infoPanel.mergeDisabledNoCommits")
					: undefined,
		run: withDismiss(() => void handleMerge()),
	});

	return (
		<section className="border-t border-edge pt-4">
			<h3 className="mb-2 flex items-center gap-2 text-[0.625rem] font-semibold uppercase tracking-wider text-fg-muted">
				{t("infoPanel.gitSection")}
				{statusLoading && (
					<span className="h-3 w-3 animate-spin rounded-full border-2 border-current/30 border-t-current" aria-hidden="true" />
				)}
			</h3>
			<div className="touch-actions flex flex-col gap-2">
				{rows.map((row) => (
					<button
						key={row.key}
						type="button"
						disabled={row.disabled}
						onClick={row.run}
						className={`${rowClassName} ${row.disabled ? "cursor-not-allowed opacity-50 hover:bg-raised active:bg-raised" : ""}`}
					>
						{row.icon}
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="truncate text-sm font-medium">{row.label}</span>
							{row.disabled && row.reason && (
								<span className="truncate text-[0.6875rem] font-normal text-fg-muted">{row.reason}</span>
							)}
						</span>
						{row.external && !row.disabled && (
							<span className="shrink-0 text-fg-muted" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }} aria-hidden="true">
								{"\u{F0866}"}
							</span>
						)}
					</button>
				))}
			</div>
		</section>
	);
}
