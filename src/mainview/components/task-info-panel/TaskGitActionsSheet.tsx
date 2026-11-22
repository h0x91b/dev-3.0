import { useEffect } from "react";
import { ACTIVE_STATUSES } from "../../../shared/types";
import { useT } from "../../i18n";
import { GitSheetProvider, taskHasGitBar } from "../../task-header/builtin-git";
import { TaskHeaderRegionItems, useTaskHeaderInternals, useTaskHeaderScope } from "../../task-header/scope";

interface TaskGitActionsSheetProps {
	/** Full-width row class shared with the rest of the mobile actions sheet. */
	rowClassName: string;
	/** Dismiss the sheet after a git action is triggered so the terminal / PR is visible. */
	onAction: () => void;
}

/**
 * The Git section of the narrow-viewport (mobile) task actions BottomSheet. Its rows are
 * the Git bar's own items in their sheet form (`task-header/builtin-git.tsx`), so the two
 * surfaces cannot drift apart. Per the mobile doctrine (Bible §12.3) the inspector bars'
 * actions become sheet sections on narrow, and §12.4 forbids touch-unreachable actions.
 * The branch status comes from the header's single instance, so the sheet opens loaded.
 */
export default function TaskGitActionsSheet(props: TaskGitActionsSheetProps) {
	const { task, project } = useTaskHeaderScope();
	// Git only makes sense on a real, active worktree. An Operations task has no git
	// domain of its own (Bible §3); with an attached repo its items offer only the diff row.
	if (!taskHasGitBar(project, task) || !ACTIVE_STATUSES.includes(task.status) || !task.worktreePath) {
		return null;
	}
	return <GitSection {...props} />;
}

function GitSection({ rowClassName, onAction }: TaskGitActionsSheetProps) {
	const t = useT();
	const { task } = useTaskHeaderScope();
	const { git } = useTaskHeaderInternals();
	const { branchStatus, handleRefreshStatus, refreshStatusQuietly, refreshingStatus, statusError, statusLoading } = git;

	// The sheet mounts only while open, so this runs on every open. The 15s poll
	// never fetches the remote; this does, so ahead/behind and the PR are current.
	useEffect(() => {
		void refreshStatusQuietly();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once per open/task, not per render
	}, [task.id]);

	return (
		<section className="border-t border-edge pt-4">
			<h3 className="mb-2 flex items-center gap-2 text-dense font-semibold uppercase tracking-wider text-fg-muted">
				{t("infoPanel.gitSection")}
				{statusLoading && (
					<span className="h-3 w-3 animate-spin rounded-full border-2 border-[color-mix(in_srgb,currentColor_30%,transparent)] border-t-current" aria-hidden="true" />
				)}
				{statusError && !branchStatus && (
					<span className="flex items-center gap-1 text-micro font-normal normal-case tracking-normal text-danger" title={statusError}>
						{t("infoPanel.statusLoadFailed")}
						<button
							type="button"
							onClick={() => void handleRefreshStatus()}
							disabled={refreshingStatus}
							className="underline hover:text-fg disabled:opacity-40"
						>
							{t("infoPanel.statusRetry")}
						</button>
					</span>
				)}
			</h3>
			<div className="touch-actions flex flex-col gap-2">
				<GitSheetProvider value={{ rowClassName, onAction }}>
					<TaskHeaderRegionItems region="git" surface="sheet" />
				</GitSheetProvider>
			</div>
		</section>
	);
}
