import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import { toast } from "../../toast";
import {
	type BranchStatus,
	type Project,
	type Task,
	MERGE_COMPLETE_ELIGIBLE_STATUSES,
	resolveTaskCompareBaseBranch,
} from "../../../shared/types";
import { getTaskOpenMode, taskClosedHomeRoute, type AppAction, type Route } from "../../state";
import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { useT } from "../../i18n";
import { moveTaskToStatus } from "../../utils/moveTaskToStatus";
import { runMergeCompletionPromptOnce } from "../../utils/mergeCompletionPrompt";
import { createMergePromptAbort } from "../../utils/mergePromptAbort";
import { taskDialogInfo } from "../../utils/taskDialogInfo";
import { startVisibilityAwarePoll } from "../../utils/poll";

interface UseTaskBranchStatusParams {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	isTaskActive: boolean;
	/**
	 * When false the hook is inert: no status polling, no git-op refresh
	 * listener, `branchStatus` stays null. Lets a component that renders on
	 * both desktop and narrow viewports own a single hook instance for the
	 * narrow layout without double-polling next to `TaskGitActions` (which
	 * runs its own instance on desktop). Defaults to true.
	 */
	enabled?: boolean;
}

function getDefaultTaskCompareRef(taskBaseBranch: string, project: Project): string {
	const projectBaseBranch = project.defaultBaseBranch || "main";
	const projectDefaultCompareRef = project.defaultCompareRef;

	if (taskBaseBranch !== projectBaseBranch) {
		return taskBaseBranch;
	}

	if (!projectDefaultCompareRef) {
		return project.defaultCompareRefMode === "local" ? taskBaseBranch : "";
	}
	return projectDefaultCompareRef;
}

export function useTaskBranchStatus({
	task,
	project,
	dispatch,
	navigate,
	isTaskActive,
	enabled = true,
}: UseTaskBranchStatusParams) {
	const t = useT();
	const [branchStatus, setBranchStatus] = useState<BranchStatus | null>(null);
	const [rebasing, setRebasing] = useState(false);
	const [merging, setMerging] = useState(false);
	const [pushing, setPushing] = useState(false);
	const [creatingPR, setCreatingPR] = useState(false);
	const [refreshingStatus, setRefreshingStatus] = useState(false);
	const mergeDialogShownRef = useRef(false);

	const baseBranch = resolveTaskCompareBaseBranch(task, project);
	const defaultCompareRef = getDefaultTaskCompareRef(baseBranch, project);
	const [compareRef, setCompareRef] = useState(defaultCompareRef);

	useEffect(() => {
		setCompareRef(defaultCompareRef);
	}, [defaultCompareRef, task.id]);

	// Switching tasks reuses this component instance (no `key={task.id}`), so the
	// previous task's branch status would otherwise linger on screen until the
	// new fetch resolves. Clear it eagerly so the git line shows the loading
	// state instead of stale data from the task we just left.
	useEffect(() => {
		setBranchStatus(null);
	}, [task.id]);

	const completeTask = useCallback(() => {
		void moveTaskToStatus({
			task,
			project,
			newStatus: "completed",
			dispatch,
			t,
			confirm: false,
			revertOnFailure: false,
			// Land on the user's home surface: fullscreen open-mode → the board,
			// split open-mode → the split task view with nothing selected.
			afterOptimistic: () => navigate(taskClosedHomeRoute(project.id, getTaskOpenMode())),
		});
	}, [dispatch, navigate, project, task, t]);

	// Offers the "Branch Merged → complete the task?" popup when the branch is
	// fully merged into its base. `force` is set when the user explicitly clicks
	// the git refresh button: it re-asks even after a prior dismissal or within
	// the same session (bypassing both the in-memory once-guard and the backend
	// suppression), and gives an explicit toast when nothing is mergeable yet.
	const offerMergeCompletionIfMerged = useCallback(
		async (status: BranchStatus, { force }: { force: boolean }) => {
			// mergedByContent is computed against whatever ref the user selected in
			// the compare dropdown. The completion prompt is only meaningful against
			// the task's real base branch.
			const isDefaultBaseCompare =
				!compareRef || compareRef === baseBranch || compareRef === `origin/${baseBranch}`;
			const eligible =
				status.mergedByContent &&
				isDefaultBaseCompare &&
				// The popup claims "no changes left" — uncommitted changes mean that's
				// false, and completing would destroy them.
				status.insertions === 0 &&
				status.deletions === 0 &&
				MERGE_COMPLETE_ELIGIBLE_STATUSES.includes(task.status);

			if (!eligible) {
				if (force) {
					toast.info(t("infoPanel.mergeCheckNotMerged", { branch: baseBranch }), { taskId: task.id });
				}
				return;
			}

			if (!force && mergeDialogShownRef.current) {
				return;
			}

			const promptState = await api.request.prepareMergeCompletionPrompt({
				taskId: task.id,
				projectId: project.id,
				fingerprint: status.mergeCompletionFingerprint,
				force,
			});
			if (!force) {
				mergeDialogShownRef.current = true;
			}
			if (!promptState.shouldPrompt) {
				return;
			}

			const abort = createMergePromptAbort(task.id);
			const runPrompt = () =>
				confirm({
					title: t("app.branchMergedTitle"),
					message: t("app.branchMergedMessage", {
						taskTitle: task.customTitle || task.title,
						branchName: task.branchName || "",
					}),
					info: taskDialogInfo(task, project),
					signal: abort.signal,
				});
			let shouldComplete: boolean | null;
			try {
				shouldComplete = force
					? await runPrompt()
					: await runMergeCompletionPromptOnce(task.id, promptState.fingerprint, runPrompt);
			} finally {
				abort.cleanup();
			}
			if (abort.signal.aborted) return;
			if (shouldComplete) {
				completeTask();
			} else if (shouldComplete === false) {
				await api.request.dismissMergeCompletionPrompt({
					taskId: task.id,
					projectId: project.id,
					fingerprint: promptState.fingerprint,
				});
			}
		},
		[
			baseBranch,
			compareRef,
			completeTask,
			project.id,
			task.branchName,
			task.customTitle,
			task.id,
			task.status,
			task.title,
			t,
		],
	);

	useEffect(() => {
		if (!enabled || !isTaskActive || !task.worktreePath) {
			setBranchStatus(null);
			return;
		}

		mergeDialogShownRef.current = false;
		let cancelled = false;

		const fetchStatus = async () => {
			try {
				const status = await api.request.getBranchStatus({
					taskId: task.id,
					projectId: project.id,
					compareRef: compareRef || undefined,
				});

				if (!cancelled) {
					setBranchStatus(status);
					await offerMergeCompletionIfMerged(status, { force: false });
				}
			} catch {
				// Polling retries on the next tick.
			}
		};

		const stop = startVisibilityAwarePoll({ fn: fetchStatus, intervalMs: 15_000 });

		return () => {
			cancelled = true;
			stop();
		};
	}, [
		compareRef,
		enabled,
		isTaskActive,
		offerMergeCompletionIfMerged,
		project.id,
		task.id,
		task.worktreePath,
	]);

	const handleCreatePR = useCallback(async (autoMerge = false) => {
		if (creatingPR) {
			return;
		}

		setCreatingPR(true);
		try {
			await api.request.createPullRequest({
				taskId: task.id,
				projectId: project.id,
				autoMerge,
			});
		} catch (err) {
			toast.error(t("infoPanel.createPRFailed", { error: String(err) }), { taskId: task.id });
		}
		setCreatingPR(false);
	}, [creatingPR, project.id, task.id, t]);

	useEffect(() => {
		if (!enabled) return;
		async function onGitOpCompleted(event: Event) {
			const detail = (event as CustomEvent).detail as {
				taskId: string;
				projectId: string;
				operation: string;
				ok: boolean;
			};

			if (detail.taskId !== task.id) {
				return;
			}

			let refreshedStatus: BranchStatus | null = null;
			try {
				const status = await api.request.getBranchStatus({
					taskId: task.id,
					projectId: project.id,
					compareRef: compareRef || undefined,
				});
				refreshedStatus = status;
				setBranchStatus(status);
			} catch {
				// Keep existing state when refresh fails.
			}

			if (detail.operation === "merge" && detail.ok) {
				// Completing the task destroys the worktree — never offer it while
				// uncommitted changes remain.
				if (refreshedStatus && (refreshedStatus.insertions > 0 || refreshedStatus.deletions > 0)) {
					return;
				}
				const promptState = await api.request.prepareMergeCompletionPrompt({
					taskId: task.id,
					projectId: project.id,
					fingerprint: refreshedStatus?.mergeCompletionFingerprint,
				});
				if (!promptState.shouldPrompt) return;

				const abort = createMergePromptAbort(task.id);
				let shouldComplete: boolean | null;
				try {
					shouldComplete = await runMergeCompletionPromptOnce(task.id, promptState.fingerprint, () =>
						confirm({
							title: t("infoPanel.mergeComplete"),
							message: t("infoPanel.mergeCompleteMessage"),
							info: taskDialogInfo(task, project),
							signal: abort.signal,
						}),
					);
				} finally {
					abort.cleanup();
				}
				if (abort.signal.aborted) return;
				if (shouldComplete) {
					completeTask();
				} else if (shouldComplete === false) {
					await api.request.dismissMergeCompletionPrompt({
						taskId: task.id,
						projectId: project.id,
						fingerprint: promptState.fingerprint,
					});
				}
			}
		}

		window.addEventListener("rpc:gitOpCompleted", onGitOpCompleted);
		return () => window.removeEventListener("rpc:gitOpCompleted", onGitOpCompleted);
	}, [compareRef, completeTask, enabled, handleCreatePR, project.id, task.id, task.status, t]);

	const handleRefreshStatus = useCallback(async () => {
		if (refreshingStatus || !isTaskActive || !task.worktreePath) {
			return;
		}

		setRefreshingStatus(true);
		try {
			const status = await api.request.getBranchStatus({
				taskId: task.id,
				projectId: project.id,
				compareRef: compareRef || undefined,
			});
			setBranchStatus(status);
			// A manual click is a force re-check: re-offer completion even if the
			// user dismissed the popup earlier for this same merged head.
			await offerMergeCompletionIfMerged(status, { force: true });
		} catch (err) {
			toast.error(t("infoPanel.refreshStatusFailed", { error: String(err) }), { taskId: task.id });
		}
		setRefreshingStatus(false);
	}, [compareRef, isTaskActive, offerMergeCompletionIfMerged, project.id, refreshingStatus, task.id, task.worktreePath, t]);

	const handleRebase = useCallback(async () => {
		if (rebasing) {
			return;
		}

		setRebasing(true);
		try {
			// Clean rebase → run it directly in a visible terminal pane (unchanged).
			// Conflicting rebase (behind but can't apply cleanly) → hand it off to the
			// agent in the task terminal, mirroring the Create-PR handoff.
			if (branchStatus && branchStatus.behind > 0 && !branchStatus.canRebase) {
				const { handedOff } = await api.request.rebaseTaskViaAgent({
					taskId: task.id,
					projectId: project.id,
					compareRef: compareRef || undefined,
				});
				if (handedOff) {
					toast.info(t("infoPanel.rebaseAgentStarted"), { taskId: task.id });
				} else {
					toast.error(t("infoPanel.rebaseAgentNoPane"), { taskId: task.id });
				}
			} else {
				await api.request.rebaseTask({
					taskId: task.id,
					projectId: project.id,
					compareRef: compareRef || undefined,
				});
			}
		} catch (err) {
			toast.error(t("infoPanel.rebaseFailed", { error: String(err) }), { taskId: task.id });
		}
		setRebasing(false);
	}, [branchStatus, compareRef, project.id, rebasing, task.id, t]);

	const handleMerge = useCallback(async () => {
		if (merging) {
			return;
		}

		setMerging(true);
		try {
			await api.request.mergeTask({
				taskId: task.id,
				projectId: project.id,
			});
		} catch (err) {
			toast.error(t("infoPanel.mergeFailed", { error: String(err) }), { taskId: task.id });
		}
		setMerging(false);
	}, [merging, project.id, task.id, t]);

	const handlePush = useCallback(async () => {
		if (pushing) {
			return;
		}

		setPushing(true);
		try {
			await api.request.pushTask({
				taskId: task.id,
				projectId: project.id,
			});
		} catch (err) {
			toast.error(t("infoPanel.pushFailed", { error: String(err) }), { taskId: task.id });
		}
		setPushing(false);
	}, [project.id, pushing, task.id, t]);

	const handleOpenPR = useCallback(() => {
		if (branchStatus?.prUrl) {
			window.open(branchStatus.prUrl, "_blank");
		}
	}, [branchStatus?.prUrl]);

	function selectCompareRef(nextCompareRef: string) {
		setCompareRef(nextCompareRef);
		setBranchStatus(null);
	}

	return {
		baseBranch,
		branchStatus,
		compareRef,
		creatingPR,
		displayRef: compareRef || `origin/${baseBranch}`,
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
		statusLoading: enabled && isTaskActive && !!task.worktreePath && !branchStatus,
	};
}

/**
 * Everything `useTaskBranchStatus` returns — status data plus the git action
 * handlers. Passed as a prop where a parent owns the single hook instance
 * (narrow-viewport TaskInfoPanel → TaskGitActionsSheet).
 */
export type TaskBranchStatusController = ReturnType<typeof useTaskBranchStatus>;
