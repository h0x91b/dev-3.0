import type {
	PRCIStatus,
	PRInfo,
	PRMergeState,
	Project,
	Task,
	TaskPRStatusCache,
} from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import * as github from "../github";
import { loadSettings } from "../settings";
import { getActiveContext, getPushMessage, isAppForeground, log } from "../rpc-handlers/shared";
import {
	ACTIVE_PROJECT_MERGE_INTERVAL_MS,
	ACTIVE_PROJECT_PENDING_PR_INTERVAL_MS,
	ACTIVE_PROJECT_PR_INTERVAL_MS,
	BACKGROUND_PROJECT_MERGE_INTERVAL_MS,
	BACKGROUND_PROJECT_PENDING_PR_INTERVAL_MS,
	BACKGROUND_PROJECT_PR_INTERVAL_MS,
	MERGE_POLL_INTERVAL_MS,
	PR_POLL_INTERVAL_MS,
	intervalForTask,
	isDue,
	nextDueAfterRun,
	staggeredDue,
	wasAsleep,
} from "../rpc-handlers/git-poll-throttle";
import {
	type MergeCompletionFingerprint,
	MERGE_PROMPT_RETRY_SUPPRESS_MS,
	shouldSuppressMergePrompt,
} from "./merge-prompt";
import {
	computeSignalKey,
	countUnresolvedReviewThreads,
	mapReviewDecision,
	normalizeChecks,
	parseAutoMergeEnabled,
	parseGitHubPullRequestUrl,
	parseReviewDecision,
	reasonForSignal,
	rollupCiStatus,
} from "../rpc-handlers/pr-status";
import {
	dispatchLifecycleEvent,
	dispatchLifecycleFinding,
	forEachLifecycleActorRuntime,
	lifecycleActorRuntime,
} from "./service";
import { activitiesFor } from "./machine";
import { lifecycleStateFromTask } from "./state";

// Cap the PR-detection `gh` call: it holds a semaphore slot for its whole
// duration, so a hung gh on a slow network must not stall branch-status globally.
export const PR_DETECTION_TIMEOUT_MS = 15_000;
// Wall-clock of the previous tick, per poller, to detect host sleep gaps.
let mergeLastTickAt = 0;
let prLastTickAt = 0;
// Injectable RNG so jitter is deterministic under test.
let scheduleRandom: () => number = Math.random;

export function _setScheduleRandomForTest(fn: () => number): void {
	scheduleRandom = fn;
}

function isPromptReserved(taskId: string, fingerprint: string, nowMs: number): boolean {
	const runtime = lifecycleActorRuntime(taskId);
	const reservation = runtime.mergePromptReservation;
	if (!reservation || reservation.fingerprint !== fingerprint) return false;
	if (nowMs - reservation.reservedAt > MERGE_PROMPT_RETRY_SUPPRESS_MS) {
		delete runtime.mergePromptReservation;
		return false;
	}
	return true;
}

export async function getMergeCompletionFingerprint(task: Pick<Task, "id" | "worktreePath" | "branchName">, branchName: string | null): Promise<MergeCompletionFingerprint> {
	const resolvedBranchName = branchName || task.branchName || task.id;
	if (task.worktreePath) {
		const headSha = await git.getHeadSha(task.worktreePath);
		if (headSha) {
			return {
				fingerprint: `v1:${resolvedBranchName}:${headSha}`,
				precise: true,
			};
		}
	}
	return {
		fingerprint: `fallback:${resolvedBranchName}`,
		precise: false,
	};
}

export async function prepareMergeCompletionPrompt(params: { taskId: string; projectId: string; fingerprint?: string | null; force?: boolean }): Promise<{ shouldPrompt: boolean; fingerprint: string | null; shouldNotify?: boolean }> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const settings = await loadSettings();
	const suggestCompletion = settings.suggestCompletingTasksAfterMerge !== false;
	const fingerprint = params.fingerprint
		? { fingerprint: params.fingerprint, precise: params.fingerprint.startsWith("v1:") }
		: await getMergeCompletionFingerprint(task, task.branchName);
	const promptedAt = new Date().toISOString();
	const previousReservation = lifecycleActorRuntime(task.id).mergePromptReservation;
	const updated = await dispatchLifecycleEvent(project.id, task.id, {
		type: "mergePromptPrepared",
		fingerprint: fingerprint.fingerprint,
		precise: fingerprint.precise,
		promptedAt,
		suggestCompletion,
		force: params.force === true,
	});
	const manualCompletion = updated.manualCompletion === true;
	const noticeOnly = manualCompletion || !suggestCompletion;
	if (noticeOnly) {
		const reservation = lifecycleActorRuntime(task.id).mergePromptReservation;
		return {
			shouldPrompt: false,
			fingerprint: fingerprint.fingerprint,
			shouldNotify: !manualCompletion
				&& reservation !== previousReservation
				&& reservation?.fingerprint === fingerprint.fingerprint
				&& reservation.reservedAt === Date.parse(promptedAt),
		};
	}
	const shouldPrompt = updated.mergeCompletionPrompt?.fingerprint === fingerprint.fingerprint
		&& updated.mergeCompletionPrompt.promptedAt === promptedAt
		&& updated.mergeCompletionPrompt.dismissedAt == null;
	return { shouldPrompt, fingerprint: fingerprint.fingerprint };
}

export async function dismissMergeCompletionPrompt(params: { taskId: string; projectId: string; fingerprint: string | null }): Promise<Task> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const fingerprint = params.fingerprint
		? { fingerprint: params.fingerprint, precise: params.fingerprint.startsWith("v1:") }
		: await getMergeCompletionFingerprint(task, task.branchName);
	return dispatchLifecycleEvent(project.id, task.id, {
		type: "mergePromptDismissed",
		fingerprint: fingerprint.fingerprint,
		precise: fingerprint.precise,
		dismissedAt: new Date().toISOString(),
	});
}

let mergePollerInterval: ReturnType<typeof setInterval> | null = null;

export function startMergeDetectionPoller(): void {
	stopMergeDetectionPoller();
	const POLL_INTERVAL = MERGE_POLL_INTERVAL_MS;

	mergePollerInterval = setInterval(async () => {
		try {
			await checkMergedBranches();
		} catch (err) {
			log.error("Merge detection poller error", { error: String(err) });
		}
	}, POLL_INTERVAL);

	log.info("Merge detection poller started", { intervalMs: POLL_INTERVAL });
}

export function stopMergeDetectionPoller(): void {
	if (!mergePollerInterval) return;
	clearInterval(mergePollerInterval);
	mergePollerInterval = null;
	log.info("Merge detection poller stopped");
}

async function checkMergedBranches(): Promise<void> {
	const pushMessage = getPushMessage();
	if (!pushMessage) return;

	const projects = await data.loadProjects();
	const { projectId: activeProjectId } = getActiveContext();
	const foreground = isAppForeground();
	const now = Date.now();
	const settings = await loadSettings();
	const suggestCompletion = settings.suggestCompletingTasksAfterMerge !== false;
	// A tick far later than the base interval means the host was suspended
	// (laptop sleep): re-spread overdue tasks instead of firing them all at once.
	const wokeFromSleep = mergeLastTickAt !== 0 && wasAsleep(now - mergeLastTickAt, MERGE_POLL_INTERVAL_MS);
	mergeLastTickAt = now;

	const liveTaskIds = new Set<string>();
	for (const project of projects) {
		const tasks = await data.loadTasks(project);
		const reviewTasks = tasks.filter((task) => (
			activitiesFor(lifecycleStateFromTask(project, task)).includes("mergeWatch")
		));

		if (reviewTasks.length === 0) continue;

		const isActiveFg = foreground && project.id === activeProjectId;
		const interval = intervalForTask(isActiveFg, ACTIVE_PROJECT_MERGE_INTERVAL_MS, BACKGROUND_PROJECT_MERGE_INTERVAL_MS);

		// Decide which tasks are due this tick; schedule (or re-spread) the rest.
		const dueTasks = reviewTasks.filter((task) => {
			liveTaskIds.add(task.id);
			const runtime = lifecycleActorRuntime(task.id);
			let scheduled = runtime.mergeNextDue;
			if (scheduled === undefined) {
				// First sight: the on-screen project checks now, everything else is
				// spread across its interval so a batch never fires on one tick.
				scheduled = isActiveFg ? now : staggeredDue(now, interval, scheduleRandom);
				runtime.mergeNextDue = scheduled;
			}
			if (wokeFromSleep) {
				runtime.mergeNextDue = staggeredDue(now, interval, scheduleRandom);
				return false;
			}
			return isDue(scheduled, now);
		});

		if (dueTasks.length === 0) continue;

		// Fetch only the base branches the due tasks actually compare against, so
		// a project with nothing due this tick triggers no network at all.
		const uniqueBaseBranches = [...new Set([
			project.defaultBaseBranch || "main",
			...dueTasks.map((t) => t.baseBranch || project.defaultBaseBranch || "main"),
		])];
		try {
			await Promise.all(uniqueBaseBranches.map((b) => git.fetchOrigin(project.path, b)));
		} catch {
			continue;
		}

		for (const task of dueTasks) {
			try {
				const branchName = await git.getCurrentBranch(task.worktreePath!);
				if (!branchName) continue;

				// PR-review tasks check out an existing branch, and deriveTaskBaseBranch
				// sets their baseBranch to that same branch. Comparing the branch against
				// origin/<itself> is trivially "merged" and produced a false "Branch
				// Merged" prompt. Fall back to the project's real base branch so we still
				// detect when the reviewed PR actually lands there; if even that is the
				// branch itself, there is no distinct base to merge into — skip.
				let baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
				if (baseBranch === branchName) {
					baseBranch = project.defaultBaseBranch || "main";
					if (baseBranch === branchName) continue;
				}
				const ref = `origin/${baseBranch}`;

				// Cheap suppression first: a prompt already reserved/dismissed for
				// this exact head must not burn merge-tree/patch-id/gh calls on
				// every 60s tick.
				const fingerprint = await getMergeCompletionFingerprint(task, branchName);
				const nowMs = Date.now();
				const noticeOnly = task.manualCompletion === true || !suggestCompletion;
				if (isPromptReserved(task.id, fingerprint.fingerprint, nowMs)) continue;
				if (!noticeOnly && shouldSuppressMergePrompt(task.mergeCompletionPrompt, fingerprint, nowMs)) continue;

				// The popup claims "no changes left" — never prompt while the
				// worktree has uncommitted changes. Skip WITHOUT reserving so a
				// later clean tick prompts normally.
				if (await git.isWorktreeDirty(task.worktreePath!)) continue;

				const unpushed = await git.getUnpushedCount(task.worktreePath!, branchName);
				let merged: boolean;
				if (unpushed === -1) {
					// origin/<branch> is gone: either never pushed, or pruned after
					// the PR merged (delete_branch_on_merge). Content strategies are
					// unsafe here (a never-pushed branch with zero commits would
					// false-positive), but a merged PR whose head equals local HEAD
					// is definitive.
					merged = await git.isBranchMergedViaGitHubPR(task.worktreePath!, project);
				} else {
					merged = await git.isContentMergedInto(task.worktreePath!, ref, project);
				}
				if (!merged) continue;

				log.info("Branch merge detected", { taskId: task.id.slice(0, 8), branch: branchName });
				await dispatchLifecycleFinding(project, task, {
					type: "mergeDetected",
					branchName,
					fingerprint: fingerprint.fingerprint,
					precise: fingerprint.precise,
					detectedAt: new Date().toISOString(),
					suggestCompletion,
				});
			} catch (err) {
				log.warn("Merge check failed for task", { taskId: task.id.slice(0, 8), error: String(err) });
			} finally {
				// Reschedule regardless of outcome (merged, dirty, suppressed, error)
				// so this task does not re-run until its next jittered slot.
				lifecycleActorRuntime(task.id).mergeNextDue = nextDueAfterRun(now, interval, scheduleRandom);
			}
		}
	}
	forEachLifecycleActorRuntime((runtime, taskId) => {
		if (!liveTaskIds.has(taskId)) delete runtime.mergeNextDue;
	});
}

export function clearMergeNotification(taskId: string): void {
	delete lifecycleActorRuntime(taskId).mergePromptReservation;
}

export function _resetMergePollerState(): void {
	forEachLifecycleActorRuntime((runtime) => {
		delete runtime.mergePromptReservation;
		delete runtime.mergeNextDue;
	});
	mergeLastTickAt = 0;
	scheduleRandom = Math.random;
}

let prPollerInterval: ReturnType<typeof setInterval> | null = null;

export function startPRDetectionPoller(): void {
	stopPRDetectionPoller();
	const POLL_INTERVAL = PR_POLL_INTERVAL_MS;

	prPollerInterval = setInterval(async () => {
		try {
			await checkOpenPRsForPromotion();
		} catch (err) {
			log.error("PR detection poller error", { error: String(err) });
		}
	}, POLL_INTERVAL);

	log.info("PR detection poller started", { intervalMs: POLL_INTERVAL });
}

export function stopPRDetectionPoller(): void {
	if (!prPollerInterval) return;
	clearInterval(prPollerInterval);
	prPollerInterval = null;
	log.info("PR detection poller stopped");
}

export function _resetPRPollerState(): void {
	forEachLifecycleActorRuntime((runtime) => {
		delete runtime.prPromoted;
		delete runtime.prSignalKey;
		delete runtime.prNextDue;
		delete runtime.prPending;
	});
	prLastTickAt = 0;
	scheduleRandom = Math.random;
}

interface GitHubPullRequestSummary {
	number?: unknown;
	isDraft?: unknown;
	autoMergeRequest?: unknown;
	url?: unknown;
	title?: unknown;
	state?: unknown;
	mergeable?: unknown;
	mergeStateStatus?: unknown;
	statusCheckRollup?: unknown;
	reviewDecision?: unknown;
}

const PR_STATUS_JSON_FIELDS = "number,isDraft,autoMergeRequest,url,statusCheckRollup,reviewDecision,mergeable,mergeStateStatus,state,title";

interface PolledPRStatus {
	found: boolean;
	ciStatus: PRCIStatus | null;
}

type FreshPRStatus = Omit<TaskPRStatusCache, "cachedAt">;

const TERMINAL_TASK_STATUSES = new Set<Task["status"]>(["completed", "cancelled"]);

export async function persistTaskPrIdentity(project: Project, task: Task, prNumber: number, prUrl: string): Promise<void> {
	if (task.prNumber === prNumber && task.prUrl === prUrl) return;
	await dispatchLifecycleEvent(project.id, task.id, {
		type: "prIdentityDiscovered",
		prNumber,
		prUrl,
	});
}

export async function persistProjectPrIdentities(project: Project, prs: PRInfo[]): Promise<void> {
	let tasks: Task[];
	try {
		tasks = await data.loadTasks(project);
	} catch (err) {
		log.warn("getProjectPRs: failed to load tasks for sticky PR persistence", { error: String(err) });
		return;
	}

	for (const pr of prs) {
		const task = tasks.find((candidate) => candidate.branchName === pr.headRefName);
		if (task) await persistTaskPrIdentity(project, task, pr.number, pr.url);
	}
}

function prPollInterval(isActiveForeground: boolean, taskId: string): number {
	return lifecycleActorRuntime(taskId).prPending
		? intervalForTask(isActiveForeground, ACTIVE_PROJECT_PENDING_PR_INTERVAL_MS, BACKGROUND_PROJECT_PENDING_PR_INTERVAL_MS)
		: intervalForTask(isActiveForeground, ACTIVE_PROJECT_PR_INTERVAL_MS, BACKGROUND_PROJECT_PR_INTERVAL_MS);
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

async function fetchUnresolvedReviewThreadCount(
	project: Project,
	worktreePath: string,
	prUrl: string,
	prNumber: number,
): Promise<number | null> {
	const repository = parseGitHubPullRequestUrl(prUrl);
	if (!repository) return null;
	const selectedHost = project.githubAuthHost?.trim().toLowerCase();
	if (selectedHost && selectedHost !== repository.host.toLowerCase()) {
		log.warn("PR review-thread lookup skipped because project and PR hosts differ", {
			projectHost: selectedHost,
			prHost: repository.host,
			pr: prNumber,
		});
		return null;
	}

	let after: string | null = null;
	let count = 0;
	try {
		for (let page = 0; page < 100; page++) {
			const args = [
				"api",
				"graphql",
				"--hostname",
				repository.host,
				"-f",
				`query=${REVIEW_THREADS_QUERY}`,
				"-F",
				`owner=${repository.owner}`,
				"-F",
				`name=${repository.repo}`,
				"-F",
				`number=${prNumber}`,
				"-F",
				`after=${after ?? "null"}`,
			];
			const result = await github.runGitHub(project, worktreePath, args, { timeoutMs: PR_DETECTION_TIMEOUT_MS });
			if (!result.ok || !result.stdout) return null;

			const payload = JSON.parse(result.stdout) as {
				data?: {
					repository?: {
						pullRequest?: {
							reviewThreads?: {
								nodes?: unknown;
								pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
							};
						} | null;
					};
				};
				errors?: unknown;
			};
			if (payload.errors) return null;
			const threads = payload.data?.repository?.pullRequest?.reviewThreads;
			if (!threads) return null;
			count += countUnresolvedReviewThreads(threads.nodes);
			if (!threads.pageInfo?.hasNextPage || !threads.pageInfo.endCursor) return count;
			after = threads.pageInfo.endCursor;
		}
	} catch (err) {
		log.warn("PR review-thread lookup failed (non-fatal)", { pr: prNumber, error: String(err) });
	}
	return null;
}

async function pollTaskPrStatus(project: Project, task: Task): Promise<PolledPRStatus | null> {
	if (!task.worktreePath) return null;
	const branchName = await git.getCurrentBranch(task.worktreePath);
	if (!branchName) return null;

	const unpushed = await git.getUnpushedCount(task.worktreePath, branchName);
	if (unpushed === -1) return null;

	const ghResult = await github.runGitHub(
		project,
		task.worktreePath,
		[
			"pr",
			"list",
			"--head",
			branchName,
			"--state",
			"open",
			"--json",
			PR_STATUS_JSON_FIELDS,
			"--limit",
			"1",
		],
		{ timeoutMs: PR_DETECTION_TIMEOUT_MS },
	);
	if (!ghResult.ok || !ghResult.stdout) return null;

	let prs: GitHubPullRequestSummary[];
	try {
		prs = JSON.parse(ghResult.stdout);
	} catch {
		return null;
	}
	let pr = Array.isArray(prs) && prs.length > 0 ? prs[0] : null;
	let isOpenPr = pr !== null;
	if (!pr && task.prNumber != null) {
		// An open-list lookup stops finding the PR after merge. Use the sticky
		// number to fetch that exact PR so its URL and terminal state remain
		// visible, even if the branch has since disappeared from GitHub.
		const knownPrResult = await github.runGitHub(
			project,
			task.worktreePath,
			["pr", "view", String(task.prNumber), "--json", PR_STATUS_JSON_FIELDS],
			{ timeoutMs: PR_DETECTION_TIMEOUT_MS },
		);
		if (knownPrResult.ok && knownPrResult.stdout) {
			try {
				const parsed = JSON.parse(knownPrResult.stdout);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					pr = parsed as GitHubPullRequestSummary;
					isOpenPr = typeof pr.state === "string" && pr.state.toUpperCase() === "OPEN";
				}
			} catch {
				return null;
			}
		}
	}
	if (!pr) return { found: false, ciStatus: null };

	const prNumber = typeof pr.number === "number" ? pr.number : task.prNumber ?? null;
	const prUrl = typeof pr.url === "string" ? pr.url : task.prUrl ?? null;
	if (prNumber === null) return null;

	const ciStatus = rollupCiStatus(pr.statusCheckRollup);
	const reviewDecision = parseReviewDecision(pr.reviewDecision);
	const reviewState = mapReviewDecision(pr.reviewDecision);
	const checks = normalizeChecks(pr.statusCheckRollup);
	const unresolvedCount = prUrl
		? await fetchUnresolvedReviewThreadCount(project, task.worktreePath, prUrl, prNumber)
		: null;
	const mergeState: PRMergeState = {
		mergeable: typeof pr.mergeable === "string" ? pr.mergeable.toUpperCase() : null,
		status: typeof pr.mergeStateStatus === "string" ? pr.mergeStateStatus.toUpperCase() : null,
		state: typeof pr.state === "string" ? pr.state.toUpperCase() : null,
	};
	const prTitle = typeof pr.title === "string" ? pr.title : null;
	const isDraft = typeof pr.isDraft === "boolean" ? pr.isDraft : null;
	const autoMergeEnabled = parseAutoMergeEnabled(pr.autoMergeRequest);

	const freshStatus: FreshPRStatus = {
		number: prNumber,
		url: prUrl ?? "",
		autoMergeEnabled,
		ciStatus,
		reviewState,
		reviewDecision,
		unresolvedCount,
		mergeState,
		checks,
		prTitle,
		isDraft,
	};
	const payload = {
		projectId: project.id,
		taskId: task.id,
		prNumber,
		prUrl,
		autoMergeEnabled,
		ciStatus,
		reviewState,
		reviewDecision,
		unresolvedCount,
		mergeState,
		checks,
		prTitle,
		isDraft,
	};

	// Raise the bell / native notification only on a *transition* to a new
	// worthy signal. Unresolved-thread changes deliberately stay passive.
	const signalKey = computeSignalKey(ciStatus, reviewState);
	const signalReason = signalKey ? reasonForSignal(ciStatus, reviewState) : undefined;
	const isOpenNonDraft = isOpenPr && isDraft === false;
	if (isOpenNonDraft && task.status === "review-by-user") {
		log.info("Open PR detected — promoting to review-by-colleague", {
			taskId: task.id.slice(0, 8),
			branch: branchName,
			pr: prNumber,
		});
	}
	await dispatchLifecycleFinding(project, task, {
		type: "prDetected",
		openNonDraft: isOpenNonDraft,
		payload,
		...(prUrl ? {
			persistence: {
				prNumber,
				prUrl,
				cache: { ...freshStatus, cachedAt: new Date().toISOString() },
			},
		} : {}),
		signalKey,
		...(signalReason ? { signalReason } : {}),
	});

	return { found: isOpenPr, ciStatus };
}


export async function checkOpenPRsForPromotion(): Promise<void> {
	if (!getPushMessage()) return;

	const projects = await data.loadProjects();
	const { projectId: activeProjectId } = getActiveContext();
	const foreground = isAppForeground();
	const now = Date.now();
	const wokeFromSleep = prLastTickAt !== 0 && wasAsleep(now - prLastTickAt, PR_POLL_INTERVAL_MS);
	prLastTickAt = now;

	const liveTaskIds = new Set<string>();
	for (const project of projects) {
		const tasks = await data.loadTasks(project);
		// Detection remains limited to review statuses, but a task with a persisted
		// PR identity stays sticky through every non-terminal status so CI/review
		// state remains visible while an agent fixes reviewer feedback.
		const candidates = tasks.filter((task) => (
			activitiesFor(lifecycleStateFromTask(project, task)).includes("prWatch")
		));

		if (candidates.length === 0) continue;

		const isActiveFg = foreground && project.id === activeProjectId;
		const dueTasks = candidates.filter((task) => {
			liveTaskIds.add(task.id);
			const interval = prPollInterval(isActiveFg, task.id);
			const runtime = lifecycleActorRuntime(task.id);
			let scheduled = runtime.prNextDue;
			if (scheduled === undefined) {
				scheduled = isActiveFg ? now : staggeredDue(now, interval, scheduleRandom);
				runtime.prNextDue = scheduled;
			}
			if (wokeFromSleep) {
				runtime.prNextDue = staggeredDue(now, interval, scheduleRandom);
				return false;
			}
			return isDue(scheduled, now);
		});

		if (dueTasks.length === 0) continue;

		for (const task of dueTasks) {
			try {
				const result = await pollTaskPrStatus(project, task);
				if (result) lifecycleActorRuntime(task.id).prPending = result.found && result.ciStatus === "pending";
			} catch (err) {
				log.warn("PR check failed for task", { taskId: task.id.slice(0, 8), error: String(err) });
			} finally {
				lifecycleActorRuntime(task.id).prNextDue = nextDueAfterRun(now, prPollInterval(isActiveFg, task.id), scheduleRandom);
			}
		}
	}
	forEachLifecycleActorRuntime((runtime, taskId) => {
		if (liveTaskIds.has(taskId)) return;
		delete runtime.prNextDue;
		delete runtime.prPending;
		delete runtime.prSignalKey;
	});
}

export async function refreshTaskPrStatus(params: { taskId: string; projectId: string }): Promise<void> {
	if (!getPushMessage()) return;
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (project.kind === "virtual" || !task.worktreePath || TERMINAL_TASK_STATUSES.has(task.status)) return;
	const result = await pollTaskPrStatus(project, task);
	const runtime = lifecycleActorRuntime(task.id);
	if (result) runtime.prPending = result.found && result.ciStatus === "pending";
	delete runtime.prNextDue;
}
