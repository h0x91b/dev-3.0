import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import { toast } from "../../toast";
import { confirm } from "../../confirm";
import {
	type BranchStatus,
	type MergeRoute,
	type Project,
	type Task,
	resolveTaskCompareBaseBranch,
} from "../../../shared/types";
import { getTaskOpenMode, taskClosedHomeRoute, type AppAction, type Route } from "../../state";
import { api } from "../../rpc";
import { useT } from "../../i18n";
import { branchStatusCacheKey, readCachedBranchStatus, writeCachedBranchStatus } from "./branchStatusCache";
import { mergeCompletionBlocker } from "./mergeCompletionBlocker";
import { moveTaskToStatus } from "../../utils/moveTaskToStatus";
import { offerMergeCompletion } from "../../utils/offerMergeCompletion";
import { startVisibilityAwarePoll } from "../../utils/poll";
import posthog from "../../posthog";

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
	const [statusEntry, setStatusEntry] = useState<{ key: string; status: BranchStatus | null }>({
		key: "",
		status: null,
	});
	const [rebasing, setRebasing] = useState(false);
	const [committing, setCommitting] = useState(false);
	const [merging, setMerging] = useState(false);
	const [pushing, setPushing] = useState(false);
	const [creatingPR, setCreatingPR] = useState(false);
	const [refreshingStatus, setRefreshingStatus] = useState(false);
	const mergeDialogShownRef = useRef<string | null>(null);

	const baseBranch = resolveTaskCompareBaseBranch(task, project);
	const defaultCompareRef = getDefaultTaskCompareRef(baseBranch, project);
	// Derived, not synced by an effect: a one-render lag would read the cache
	// under the previous task's compare ref and flash an empty git line.
	const [compareRefChoice, setCompareRefChoice] = useState<{
		taskId: string;
		defaultRef: string;
		ref: string;
	} | null>(null);
	const compareRef =
		compareRefChoice && compareRefChoice.taskId === task.id && compareRefChoice.defaultRef === defaultCompareRef
			? compareRefChoice.ref
			: defaultCompareRef;

	// Switching tasks reuses this component instance (no `key={task.id}`), so the
	// state alone would show the previous task's numbers. Key the state by
	// task+compare ref and fall back to this task's last known status, which the
	// pending refetch then replaces in place.
	const cacheKey = branchStatusCacheKey(task.id, compareRef);
	const canShowStatus = enabled && isTaskActive && !!task.worktreePath;
	const branchStatus = !canShowStatus
		? null
		: statusEntry.key === cacheKey
			? statusEntry.status
			: readCachedBranchStatus(cacheKey);

	const applyStatus = useCallback((key: string, status: BranchStatus) => {
		writeCachedBranchStatus(key, status);
		setStatusEntry({ key, status });
	}, []);

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

	const openTask = useCallback(() => {
		if (getTaskOpenMode() === "fullscreen") {
			navigate({ screen: "task", projectId: project.id, taskId: task.id });
		} else {
			navigate({ screen: "project", projectId: project.id, activeTaskId: task.id });
		}
	}, [navigate, project.id, task.id]);

	// Offers the "Branch Merged → complete the task?" popup when the branch is
	// fully merged into its base. `force` is set when the user explicitly clicks
	// the git refresh button: it re-asks even after a prior dismissal or within
	// the same session (bypassing both the in-memory once-guard and the backend
	// suppression), and gives an explicit toast when nothing is mergeable yet.
	const offerMergeCompletionIfMerged = useCallback(
		async (status: BranchStatus, { force }: { force: boolean }) => {
			const blocker = mergeCompletionBlocker(status, { compareRef, baseBranch, taskStatus: task.status });
			if (blocker) {
				if (force) {
					const params = blocker.statusParam
						? { status: t(blocker.statusParam) }
						: blocker.params;
					toast.info(t(blocker.key, params), { taskId: task.id });
				}
				return;
			}

			if (!force && status.mergeCompletionFingerprint && mergeDialogShownRef.current === status.mergeCompletionFingerprint) {
				return;
			}
			// Remember this merged head so the 15s poll does not re-offer it every
			// tick; the primitive re-reserves server-side, this is the client
			// fast-path guard. Set before the prompt so it also covers notice-only
			// and suppressed outcomes.
			if (!force && status.mergeCompletionFingerprint) {
				mergeDialogShownRef.current = status.mergeCompletionFingerprint;
			}

			await offerMergeCompletion({
				context: { task, project },
				t,
				fingerprint: status.mergeCompletionFingerprint,
				reserve: true,
				force,
				onOpenTask: openTask,
				onComplete: completeTask,
			});
		},
		[
			baseBranch,
			compareRef,
			completeTask,
			openTask,
			project.id,
			task.branchName,
			task.customTitle,
			task.id,
			task.manualCompletion,
			task.status,
			task.title,
			t,
		],
	);

	// Read through a ref inside the poll: the callback's identity changes with the
	// `task`/`project` objects, which a task-list push replaces on every render —
	// as an effect dep it would restart the poll (and refetch) each time.
	const offerMergeCompletionIfMergedRef = useRef(offerMergeCompletionIfMerged);
	useEffect(() => {
		offerMergeCompletionIfMergedRef.current = offerMergeCompletionIfMerged;
	}, [offerMergeCompletionIfMerged]);

	useEffect(() => {
		if (!canShowStatus) {
			return;
		}

		mergeDialogShownRef.current = null;
		let cancelled = false;

		const fetchStatus = async () => {
			try {
				const status = await api.request.getBranchStatus({
					taskId: task.id,
					projectId: project.id,
					compareRef: compareRef || undefined,
				});

				if (!cancelled) {
					applyStatus(cacheKey, status);
					await offerMergeCompletionIfMergedRef.current(status, { force: false });
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
		applyStatus,
		cacheKey,
		canShowStatus,
		compareRef,
		project.id,
		task.id,
	]);

	const handleCreatePR = useCallback(async (autoMerge = false) => {
		if (creatingPR) {
			return;
		}

		setCreatingPR(true);
		try {
			const { delivery } = await api.request.createPullRequest({
				taskId: task.id,
				projectId: project.id,
				autoMerge,
			});
			// Three verdicts, three messages — same shape as the rebase and commit
			// handoffs. Nothing here claims a PR exists: all that is ever proven is
			// that the request reached the agent's pane.
			if (delivery.status === "delivered") {
				toast.info(t("infoPanel.createPRAgentStarted"), { taskId: task.id });
				posthog.capture("pull_request_created", { auto_merge: autoMerge });
			} else if (delivery.status === "unconfirmed") {
				toast.info(t("infoPanel.createPRAgentUnconfirmed"), { taskId: task.id });
			} else {
				toast.error(t("infoPanel.createPRAgentNoPane"), { taskId: task.id });
			}
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

			// A git failure INSIDE the pane produced no toast at all: the error path
			// only fires when the RPC itself throws, and opening the pane always
			// succeeds. So a refused push read as nothing happening unless the user
			// happened to be looking at the pane before it closed.
			if (!detail.ok) {
				const failureKey = {
					push: "infoPanel.pushPaneFailed",
					rebase: "infoPanel.rebasePaneFailed",
					merge: "infoPanel.mergePaneFailed",
				}[detail.operation];
				if (failureKey) toast.error(t(failureKey as "infoPanel.pushPaneFailed"), { taskId: task.id });
			}

			let refreshedStatus: BranchStatus | null = null;
			try {
				const status = await api.request.getBranchStatus({
					taskId: task.id,
					projectId: project.id,
					compareRef: compareRef || undefined,
				});
				refreshedStatus = status;
				applyStatus(cacheKey, status);
			} catch {
				// Keep existing state when refresh fails.
			}

			if (detail.operation === "merge" && detail.ok) {
				// Completing the task destroys the worktree — never offer it while
				// uncommitted changes remain.
				if (refreshedStatus && (refreshedStatus.insertions > 0 || refreshedStatus.deletions > 0)) {
					return;
				}
				if (refreshedStatus?.mergeCompletionFingerprint) {
					mergeDialogShownRef.current = refreshedStatus.mergeCompletionFingerprint;
				}
				await offerMergeCompletion({
					context: { task, project },
					t,
					fingerprint: refreshedStatus?.mergeCompletionFingerprint,
					reserve: true,
					onOpenTask: openTask,
					onComplete: completeTask,
				});
			}
		}

		window.addEventListener("rpc:gitOpCompleted", onGitOpCompleted);
		return () => window.removeEventListener("rpc:gitOpCompleted", onGitOpCompleted);
	}, [applyStatus, cacheKey, compareRef, completeTask, enabled, handleCreatePR, openTask, project.id, task.customTitle, task.id, task.manualCompletion, task.status, task.title, t]);

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
			applyStatus(cacheKey, status);
			// A manual click is a force re-check: re-offer completion even if the
			// user dismissed the popup earlier for this same merged head.
			await offerMergeCompletionIfMerged(status, { force: true });
		} catch (err) {
			toast.error(t("infoPanel.refreshStatusFailed", { error: String(err) }), { taskId: task.id });
		}
		setRefreshingStatus(false);
	}, [applyStatus, cacheKey, compareRef, isTaskActive, offerMergeCompletionIfMerged, project.id, refreshingStatus, task.id, task.worktreePath, t]);

	const handleRebase = useCallback(async () => {
		if (rebasing) {
			return;
		}

		setRebasing(true);
		try {
			const requiresAgent = !!(branchStatus && branchStatus.behind > 0 && !branchStatus.canRebase);
			let handedOff = false;
			// Clean rebase → run it directly in a visible terminal pane (unchanged).
			// Conflicting rebase (behind but can't apply cleanly) → hand it off to the
			// agent in the task terminal, mirroring the Create-PR handoff.
			if (requiresAgent) {
				const { delivery } = await api.request.rebaseTaskViaAgent({
					taskId: task.id,
					projectId: project.id,
					compareRef: compareRef || undefined,
				});
				handedOff = delivery.status !== "not-delivered";
				// Three verdicts, three messages. "unconfirmed" may well have landed, so it
				// is neither the success line nor the "no terminal" error.
				if (delivery.status === "delivered") {
					toast.info(t("infoPanel.rebaseAgentStarted"), { taskId: task.id });
				} else if (delivery.status === "unconfirmed") {
					toast.info(t("infoPanel.rebaseAgentUnconfirmed"), { taskId: task.id });
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
			if (!requiresAgent || handedOff) {
				posthog.capture("task_rebased", { via_agent: requiresAgent });
			}
		} catch (err) {
			toast.error(t("infoPanel.rebaseFailed", { error: String(err) }), { taskId: task.id });
		}
		setRebasing(false);
	}, [branchStatus, compareRef, project.id, rebasing, task.id, t]);

	// Commit is always an agent handoff — it picks what to stage and writes the
	// message (issue #271), so there is no direct-git counterpart like rebase has.
	const handleCommit = useCallback(async () => {
		if (committing) {
			return;
		}

		setCommitting(true);
		try {
			const { delivery } = await api.request.commitTaskViaAgent({
				taskId: task.id,
				projectId: project.id,
			});
			if (delivery.status === "delivered") {
				toast.info(t("infoPanel.commitAgentStarted"), { taskId: task.id });
				posthog.capture("task_commit_requested");
			} else if (delivery.status === "unconfirmed") {
				toast.info(t("infoPanel.commitAgentUnconfirmed"), { taskId: task.id });
			} else {
				toast.error(t("infoPanel.commitAgentNoPane"), { taskId: task.id });
			}
		} catch (err) {
			toast.error(t("infoPanel.commitFailed", { error: String(err) }), { taskId: task.id });
		}
		setCommitting(false);
	}, [committing, project.id, task.id, t]);

	// An open PR for this branch is what the button is about: Merge means "merge
	// that PR on GitHub", not "squash it into my local base and push". Both UIs read
	// this one value, so the label, the confirm and the command cannot disagree.
	const mergeRoute: MergeRoute = branchStatus?.prNumber != null ? "pull-request" : "local-squash";

	/**
	 * Two routes, two confirmations. Merging the PR is not destructive — GitHub
	 * still applies branch protection, reviews and CI — so it is confirmed plainly.
	 * The local squash pushes the base branch straight to origin, which bypasses all
	 * of that, and keeps the danger styling.
	 */
	const handleMerge = useCallback(async () => {
		if (merging) {
			return;
		}

		const baseBranch = resolveTaskCompareBaseBranch(task, project);
		if (mergeRoute === "pull-request") {
			const pr = String(branchStatus?.prNumber ?? "");
			const ok = await confirm({
				title: t("infoPanel.mergePrConfirm", { pr }),
				message: t("infoPanel.mergePrConfirmMessage", { pr, branch: baseBranch }),
				confirmLabel: t("infoPanel.mergePr"),
			});
			if (!ok) return;
		} else if (branchStatus?.hasRemote) {
			const ok = await confirm({
				title: t("infoPanel.mergePushConfirm", { branch: baseBranch }),
				message: t("infoPanel.mergePushConfirmMessage", { branch: baseBranch }),
				confirmLabel: t("infoPanel.merge"),
				danger: true,
			});
			if (!ok) return;
		}

		setMerging(true);
		try {
			await api.request.mergeTask({
				taskId: task.id,
				projectId: project.id,
				expectRoute: mergeRoute,
				// The same ref the status line measured "behind" against, so the
				// server's rebase guard cannot check a different one.
				compareRef: compareRef || undefined,
			});
			posthog.capture("task_merged", { route: mergeRoute, pushed_base: !!branchStatus?.hasRemote });
		} catch (err) {
			toast.error(t("infoPanel.mergeFailed", { error: String(err) }), { taskId: task.id });
		}
		setMerging(false);
	}, [branchStatus, compareRef, mergeRoute, merging, project, task, t]);

	// `remoteAhead > 0` means origin/<branch> holds commits HEAD does not, so a
	// plain push is refused as non-fast-forward — almost always a rebase after a
	// push. The backend escalates to `--force-with-lease` on its own; the click is
	// confirmed here because it rewrites a published branch.
	const handlePush = useCallback(async () => {
		if (pushing) {
			return;
		}

		const diverged = branchStatus && branchStatus.hasRemote ? branchStatus.remoteAhead : 0;
		if (diverged > 0) {
			const branch = task.branchName ?? "";
			const ok = await confirm({
				title: t("infoPanel.forcePushConfirm"),
				message: t("infoPanel.forcePushConfirmMessage", { branch, count: String(diverged) }),
				confirmLabel: t("infoPanel.forcePush"),
				danger: true,
			});
			if (!ok) return;
		}

		setPushing(true);
		try {
			await api.request.pushTask({
				taskId: task.id,
				projectId: project.id,
			});
			posthog.capture("task_pushed", { forced: diverged > 0 });
		} catch (err) {
			toast.error(t("infoPanel.pushFailed", { error: String(err) }), { taskId: task.id });
		}
		setPushing(false);
	}, [branchStatus, project.id, pushing, task.branchName, task.id, t]);

	const handleOpenPR = useCallback(() => {
		if (branchStatus?.prUrl) {
			window.open(branchStatus.prUrl, "_blank");
		}
	}, [branchStatus?.prUrl]);

	/**
	 * The status was measured against the old compare ref, so it does not carry
	 * over: the cache is keyed by ref too, and the new key shows this ref's last
	 * known numbers (or the loading state) until the refetch lands.
	 */
	function selectCompareRef(nextCompareRef: string) {
		setCompareRefChoice({ taskId: task.id, defaultRef: defaultCompareRef, ref: nextCompareRef });
	}

	return {
		baseBranch,
		branchStatus,
		compareRef,
		committing,
		creatingPR,
		// `compareRef` is "" when the server owns the choice. Name the project's
		// resolved ref, and the local base branch when even that is unknown —
		// never `origin/<base>`, which is a guess that a remoteless repo turns
		// into a label for a ref that does not exist.
		displayRef: compareRef || project.defaultCompareRef || baseBranch,
		handleCommit,
		handleCreatePR,
		handleMerge,
		handleOpenPR,
		handlePush,
		handleRebase,
		handleRefreshStatus,
		merging,
		mergeRoute,
		pushing,
		rebasing,
		refreshingStatus,
		selectCompareRef,
		statusLoading: canShowStatus && !branchStatus,
	};
}

/**
 * Everything `useTaskBranchStatus` returns — status data plus the git action
 * handlers. Passed as a prop where a parent owns the single hook instance
 * (narrow-viewport TaskInfoPanel → TaskGitActionsSheet).
 */
export type TaskBranchStatusController = ReturnType<typeof useTaskBranchStatus>;
