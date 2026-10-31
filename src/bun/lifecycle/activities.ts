import { isDeepStrictEqual } from "node:util";
import type {
	PRCIStatus,
	PRInfo,
	PRMergeState,
	Project,
	RefreshTaskPrStatusResult,
	Task,
	TaskPRStatusCache,
} from "../../shared/types";
import { resolveTaskCompareBaseBranch, taskCompletesManually } from "../../shared/types";
import { savedPrMergedFromBranch } from "../../shared/task-pull-requests";
import * as data from "../data";
import * as git from "../git";
import * as github from "../github";
import type { GitHubPullRequestSummary } from "../github-pr-status";
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
	MERGE_PROMPT_RETRY_SUPPRESS_MS,
	shouldSuppressMergePrompt,
} from "./merge-prompt";
import { getMergeCompletionFingerprint } from "./merge-fingerprint";
import {
	computeSignalKey,
	mapReviewDecision,
	normalizeChecks,
	parseAutoMergeEnabled,
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
import { hasMergeOfferHold, mergeOfferHeld, runPrWatches } from "../pr-watch-runner";
import { branchPrWatches, pinnedPrNumbers } from "../../shared/pr-watch";

// Bound PR reads so a slow GitHub connection cannot stall status updates.
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

export async function prepareMergeCompletionPrompt(params: { taskId: string; projectId: string; fingerprint?: string | null; force?: boolean }): Promise<{ shouldPrompt: boolean; fingerprint: string | null; shouldNotify?: boolean }> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const settings = await loadSettings();
	const suggestCompletion = settings.suggestCompletingTasksAfterMerge !== false;
	const fingerprint = params.fingerprint
		? { fingerprint: params.fingerprint, precise: params.fingerprint.startsWith("v1:") }
		: await getMergeCompletionFingerprint(task, task.branchName);
	// Skipped without reserving, so a later check offers normally; force is the user's own refresh.
	if (params.force !== true && mergeOfferHeld(task)) {
		return { shouldPrompt: false, fingerprint: fingerprint.fingerprint, shouldNotify: false };
	}
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
	const manualCompletion = taskCompletesManually(updated);
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
			// A local-only project has nothing to fetch from; the calls only ever failed.
			if (await git.hasOriginRemote(project.path)) {
				await Promise.all(uniqueBaseBranches.map((b) => git.fetchCompareRef(project.path, b)));
			}
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
				const ref = await git.resolveCompareRef(project.path, baseBranch);

				// Cheap suppression first: a prompt already reserved/dismissed for
				// this exact head must not burn merge-tree/patch-id/gh calls on
				// every 60s tick.
				const fingerprint = await getMergeCompletionFingerprint(task, branchName);
				const nowMs = Date.now();
				const noticeOnly = taskCompletesManually(task) || !suggestCompletion;
				if (isPromptReserved(task.id, fingerprint.fingerprint, nowMs)) continue;
				if (!noticeOnly && shouldSuppressMergePrompt(task.mergeCompletionPrompt, fingerprint, nowMs)) continue;

				// The popup claims "no changes left" — never prompt while the
				// worktree has uncommitted changes. Skip WITHOUT reserving so a
				// later clean tick prompts normally.
				if (await git.isWorktreeDirty(task.worktreePath!)) continue;

				// `unpushed === -1` means "no origin/<branch>", which only carries
				// information when there IS a remote. In a local-only repo the local
				// base is the thing to be merged into, so go straight to the content
				// check — otherwise a real local merge was never detected at all.
				const unpushed = ref.startsWith("origin/")
					? await git.getUnpushedCount(task.worktreePath!, branchName)
					: 0;
				let merged: boolean;
				if (unpushed === -1) {
					// origin/<branch> is gone: either never pushed, or pruned after
					// the PR merged (delete_branch_on_merge). The content check no
					// longer reads a branch with zero commits of its own as merged,
					// so it is safe here too and catches a purely local merge; a
					// merged PR whose head equals local HEAD stays definitive.
					// A squash merge followed by a rebase moves HEAD off
					// that oid, so also accept this task's own merged PR — but only
					// once the branch has no commits of its own left (ahead === 0),
					// otherwise post-merge work would read as merged.
					merged = await git.isContentMergedInto(task.worktreePath!, ref, project)
						|| (savedPrMergedFromBranch(task, branchName) && (await git.getBranchStatus(task.worktreePath!, ref)).ahead === 0)
						|| await git.isBranchMergedViaGitHubPR(task.worktreePath!, project)
						|| (task.prNumber != null
							&& (await git.getBranchStatus(task.worktreePath!, ref)).ahead === 0
							&& await github.isPullRequestMerged(project, task.worktreePath!, task.prNumber, branchName));
				} else {
					merged = await git.isContentMergedInto(task.worktreePath!, ref, project);
				}
				if (!merged) continue;
				// Skipped without reserving: a watching agent handles the merge first.
				if (mergeOfferHeld(task)) continue;

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

/** One task's whole poll (git reads, the bounded GitHub read, dispatch) may not hold the tick longer than this. */
export const PR_TASK_POLL_TIMEOUT_MS = 60_000;
/** A tick still running after this long is abandoned and a fresh one starts. */
export const PR_TICK_STALL_MS = 5 * 60_000;
/** How often the poller logs a heartbeat with its counters. */
export const PR_POLLER_HEARTBEAT_MS = 10 * 60_000;

/** Where a poll currently waits; named in the timeout and watchdog logs so a hang points at its await. */
export interface PollTrace { stage: string }

export interface PrTickInFlight extends PollTrace { generation: number; startedAt: number; taskId?: string }

const prTick = {
	generation: 0,
	inFlight: null as PrTickInFlight | null,
	lastHeartbeatAt: 0,
	lastCompletedAt: 0,
	lastTickMs: 0,
	ticks: 0,
	tasksPolled: 0,
	taskTimeouts: 0,
	watchdogRestarts: 0,
};
// A task whose earlier poll timed out but has not settled is not polled again on top of it.
const prTaskInFlight = new Map<string, PollTrace & { startedAt: number }>();

class PollTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new PollTimeoutError(`timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

export function startPRDetectionPoller(): void {
	stopPRDetectionPoller();
	const POLL_INTERVAL = PR_POLL_INTERVAL_MS;

	prPollerInterval = setInterval(() => void runPRDetectionTick(), POLL_INTERVAL);

	log.info("PR detection poller started", { intervalMs: POLL_INTERVAL });
}

/**
 * One timer tick: never two at once, and a tick stuck past {@link PR_TICK_STALL_MS}
 * is abandoned (it stops at its next task boundary) so detection resumes.
 */
export async function runPRDetectionTick(): Promise<void> {
	const now = Date.now();
	logPRPollerHeartbeat(now);
	const running = prTick.inFlight;
	if (running) {
		const stalledMs = now - running.startedAt;
		if (stalledMs < PR_TICK_STALL_MS) return;
		prTick.watchdogRestarts++;
		const taskStage = running.taskId ? prTaskInFlight.get(running.taskId)?.stage : undefined;
		log.error("PR detection tick stalled; starting a fresh one", {
			stalledMs, stage: running.stage,
			...(running.taskId ? { taskId: running.taskId.slice(0, 8) } : {}),
			...(taskStage ? { taskStage } : {}),
		});
	}
	const generation = ++prTick.generation;
	const tick: PrTickInFlight = { generation, startedAt: now, stage: "start" };
	prTick.inFlight = tick;
	prTick.ticks++;
	try {
		await checkOpenPRsForPromotion(tick);
	} catch (err) {
		log.error("PR detection poller error", { error: String(err) });
	} finally {
		if (prTick.inFlight === tick) {
			prTick.inFlight = null;
			prTick.lastCompletedAt = Date.now();
			prTick.lastTickMs = prTick.lastCompletedAt - now;
		}
	}
}

function logPRPollerHeartbeat(now: number): void {
	if (prTick.lastHeartbeatAt === 0) { prTick.lastHeartbeatAt = now; return; }
	if (now - prTick.lastHeartbeatAt < PR_POLLER_HEARTBEAT_MS) return;
	prTick.lastHeartbeatAt = now;
	log.info("PR detection poller heartbeat", {
		ticks: prTick.ticks,
		tasksPolled: prTick.tasksPolled,
		taskTimeouts: prTick.taskTimeouts,
		watchdogRestarts: prTick.watchdogRestarts,
		lastTickMs: prTick.lastTickMs,
		sinceLastTickMs: prTick.lastCompletedAt ? now - prTick.lastCompletedAt : null,
		tickInFlight: prTick.inFlight !== null,
		tasksStuck: prTaskInFlight.size,
	});
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
	Object.assign(prTick, {
		generation: 0, inFlight: null, lastHeartbeatAt: 0, lastCompletedAt: 0, lastTickMs: 0,
		ticks: 0, tasksPolled: 0, taskTimeouts: 0, watchdogRestarts: 0,
	});
	prTaskInFlight.clear();
	pinnedPrReadFailures.clear();
}

interface PolledPRStatus {
	checkedAt?: number;
	found: boolean;
	ciStatus: PRCIStatus | null;
	/** True when a PR's status was read and dispatched; false when GitHub reports no PR for this branch. */
	reported: boolean;
}

const NO_PR: PolledPRStatus = { found: false, ciStatus: null, reported: false };

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

function prPollInterval(isActiveForeground: boolean, task: Task): number {
	// An agent waiting on a `dev3 pr watch` is waiting while the user looks elsewhere, so the 60 s cadence holds in the background too.
	if ((task.prWatches?.length ?? 0) > 0) return ACTIVE_PROJECT_PENDING_PR_INTERVAL_MS;
	return lifecycleActorRuntime(task.id).prPending
		? intervalForTask(isActiveForeground, ACTIVE_PROJECT_PENDING_PR_INTERVAL_MS, BACKGROUND_PROJECT_PENDING_PR_INTERVAL_MS)
		: intervalForTask(isActiveForeground, ACTIVE_PROJECT_PR_INTERVAL_MS, BACKGROUND_PROJECT_PR_INTERVAL_MS);
}

/**
 * A merged PR proves only the head it merged. Commits made after it on the same
 * branch are unmerged follow-up work, so the completion offer waits — the same
 * `ahead === 0` and clean-worktree gate the merge watcher applies.
 */
async function mergedPrCoversHead(project: Project, task: Task, pr: GitHubPullRequestSummary): Promise<boolean> {
	const worktreePath = task.worktreePath!;
	if (await git.isWorktreeDirty(worktreePath)) return false;
	const headSha = await git.getHeadSha(worktreePath);
	if (headSha && typeof pr.headRefOid === "string" && pr.headRefOid === headSha) return true;
	const baseBranch = resolveTaskCompareBaseBranch(task, project);
	const projectBase = project.defaultBaseBranch || "main";
	const ref = baseBranch === projectBase ? await git.resolveCompareRef(project.path, baseBranch) : baseBranch;
	const status = await git.getBranchStatus(worktreePath, ref);
	return status != null && !status.baseUnreachable && status.ahead === 0;
}

async function pollTaskPrStatus(
	project: Project, task: Task, suggestCompletion: boolean, force = false, trace: PollTrace = { stage: "" },
): Promise<PolledPRStatus | null> {
	if (!task.worktreePath) return null;
	trace.stage = "current-branch";
	const branchName = await git.getCurrentBranch(task.worktreePath);
	if (!branchName) return NO_PR;

	trace.stage = "unpushed-count";
	const unpushed = await git.getUnpushedCount(task.worktreePath, branchName);
	// A missing remote branch means "never pushed" only when the task has no
	// sticky PR. After auto-merge, GitHub may delete the branch while the task
	// still needs the exact PR fetched by number.
	if (unpushed === -1 && task.prNumber == null) return NO_PR;
	// A forced refresh, an active pr watch or a pending merge-offer hold keeps the full read of the saved PR.
	const savedMerged = !force && branchPrWatches(task.prWatches).length === 0 && !hasMergeOfferHold(task.id)
		&& savedPrMergedFromBranch(task, branchName);

	trace.stage = "github-read";
	const result = await github.readTaskPullRequest(project, task.worktreePath, branchName, savedMerged ? null : task.prNumber, {
		force, timeoutMs: PR_DETECTION_TIMEOUT_MS,
	});
	if (!result) return null;
	const pr = result.pr;
	if (!pr) return { ...NO_PR, checkedAt: result.checkedAt };
	return { ...await reportTaskPrStatus(project, task, branchName, pr, suggestCompletion, result.checkedAt, false, trace), checkedAt: result.checkedAt };
}

/** Failed reads of one followed PR tolerated at the normal cadence before backing off. */
export const PINNED_PR_READ_FAILURES_BEFORE_BACKOFF = 3;
const PINNED_PR_BACKOFF_BASE_MS = 5 * 60_000;
const PINNED_PR_BACKOFF_MAX_MS = 6 * 60 * 60_000;
// `${taskId}#${prNumber}` -> consecutive failed reads and when the last one happened.
const pinnedPrReadFailures = new Map<string, { failures: number; at: number }>();

/** How long a followed PR is left alone after `failures` failed reads in a row; 0 = read it now. */
export function pinnedPrBackoffMs(failures: number): number {
	const over = failures - PINNED_PR_READ_FAILURES_BEFORE_BACKOFF;
	return over < 0 ? 0 : Math.min(PINNED_PR_BACKOFF_BASE_MS * 2 ** over, PINNED_PR_BACKOFF_MAX_MS);
}

/**
 * Read every PR the task follows by `--pr` and judge its pinned watches. These PRs are
 * not the task's own: nothing here touches its PR identity, badge or completion offer.
 * A PR that keeps failing to read (lost access, gone) backs off instead of costing a read a minute.
 */
async function pollPinnedPrWatches(project: Project, task: Task): Promise<void> {
	const worktree = task.worktreePath;
	if (!worktree) return;
	await Promise.all(pinnedPrNumbers(task.prWatches).map(async (prNumber) => {
		const key = `${task.id}#${prNumber}`;
		const failed = pinnedPrReadFailures.get(key);
		if (failed && Date.now() - failed.at < pinnedPrBackoffMs(failed.failures)) return;
		const result = await github.readTaskPullRequest(project, worktree, "", prNumber, { timeoutMs: PR_DETECTION_TIMEOUT_MS });
		const pr = result?.pr;
		if (!pr || pr.number !== prNumber) {
			const failures = (failed?.failures ?? 0) + 1;
			pinnedPrReadFailures.set(key, { failures, at: Date.now() });
			if (failures === PINNED_PR_READ_FAILURES_BEFORE_BACKOFF) {
				log.warn("Followed PR keeps failing to read; backing off", { taskId: task.id.slice(0, 8), pr: prNumber, nextCheckMin: pinnedPrBackoffMs(failures) / 60_000 });
			}
			return;
		}
		pinnedPrReadFailures.delete(key);
		const sample = {
			number: prNumber,
			state: typeof pr.state === "string" ? pr.state.toUpperCase() : null,
			headRefOid: typeof pr.headRefOid === "string" ? pr.headRefOid : null,
			checks: normalizeChecks(pr.statusCheckRollup),
		};
		startPrWatchRun(task.id, runPrWatches(project, task.id, sample, typeof pr.url === "string" ? pr.url : "", result.checkedAt, false, prNumber));
	}));
}

/** Watch delivery types into a pane and must never hold the poll tick, so it runs detached. */
function startPrWatchRun(taskId: string, run: Promise<void>): void {
	void run.catch((err) => {
		log.warn("PR watch evaluation failed", { taskId: taskId.slice(0, 8), error: String(err) });
	});
}

export async function reportTaskPrStatus(
	project: Project, task: Task, branchName: string, pr: GitHubPullRequestSummary,
	suggestCompletion: boolean, checkedAt: number, skipUnchanged = false, trace: PollTrace = { stage: "" },
): Promise<PolledPRStatus> {
	const matchesBranch = pr.headRefName === branchName;
	const isOpenPr = matchesBranch && pr.state === "OPEN";

	const prNumber = typeof pr.number === "number" ? pr.number : task.prNumber ?? null;
	const prUrl = typeof pr.url === "string" ? pr.url : task.prUrl ?? null;
	if (prNumber === null) throw new Error("PR status is missing its number");

	const ciStatus = rollupCiStatus(pr.statusCheckRollup);
	const reviewDecision = parseReviewDecision(pr.reviewDecision);
	const reviewState = mapReviewDecision(pr.reviewDecision);
	const checks = normalizeChecks(pr.statusCheckRollup);
	const unresolvedCount = pr.unresolvedCount;
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
		headRefName: typeof pr.headRefName === "string" ? pr.headRefName : null,
	};
	if (skipUnchanged && task.prStatusCache) {
		const { cachedAt: _, ...saved } = task.prStatusCache;
		if (isDeepStrictEqual(saved, freshStatus)) return { found: isOpenPr, ciStatus, reported: true };
	}

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
	const signalKey = matchesBranch ? computeSignalKey(ciStatus, reviewState) : null;
	const signalReason = signalKey ? reasonForSignal(ciStatus, reviewState) : undefined;
	const isOpenNonDraft = isOpenPr && isDraft === false;
	if (isOpenNonDraft && task.status === "review-by-user") {
		log.info("Open PR detected — promoting to review-by-colleague", {
			taskId: task.id.slice(0, 8),
			branch: branchName,
			pr: prNumber,
		});
	}
	trace.stage = "dispatch-pr-detected";
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
	trace.stage = "merge-covers-head";
	const mergeCoversHead = matchesBranch && mergeState.state === "MERGED" ? await mergedPrCoversHead(project, task, pr) : undefined;
	if (branchPrWatches(task.prWatches).length > 0) {
		const headRefOid = typeof pr.headRefOid === "string" ? pr.headRefOid : null;
		startPrWatchRun(task.id, runPrWatches(project, task.id, { number: prNumber, state: mergeState.state, headRefOid, checks }, prUrl ?? "", checkedAt, mergeCoversHead === true));
	}
	// Fresh read: the poll's snapshot may predate a watch added since.
	trace.stage = "merge-offer";
	if (mergeCoversHead && !mergeOfferHeld(await data.getTask(project, task.id))) {
		const fingerprint = await getMergeCompletionFingerprint(task, branchName);
		await dispatchLifecycleFinding(project, task, {
			type: "mergeDetected",
			branchName,
			fingerprint: fingerprint.fingerprint,
			precise: fingerprint.precise,
			detectedAt: new Date().toISOString(),
			suggestCompletion,
		});
	}

	return { found: isOpenPr, ciStatus, reported: true };
}


/** Does the task's own branch PR get polled (detection, badge, merge offer)? */
function ownsPrPoll(project: Project, task: Task): boolean {
	return activitiesFor(lifecycleStateFromTask(project, task)).includes("prWatch");
}

/** A live task that follows another PR with `dev3 pr watch --pr` is polled for it, PR of its own or not. */
function followsPinnedPrs(task: Task): boolean {
	return !!task.worktreePath && !TERMINAL_TASK_STATUSES.has(task.status) && pinnedPrNumbers(task.prWatches).length > 0;
}

/**
 * Poll one task under {@link PR_TASK_POLL_TIMEOUT_MS}. A timed-out poll keeps
 * running detached; until it settles the task is skipped rather than stacked.
 */
async function pollTaskWithinDeadline(project: Project, task: Task, suggestCompletion: boolean, tick?: PrTickInFlight): Promise<PolledPRStatus | null | "skipped"> {
	const stuck = prTaskInFlight.get(task.id);
	if (stuck) {
		log.warn("PR check skipped: the previous poll of this task has not finished", {
			taskId: task.id.slice(0, 8), stage: stuck.stage, pendingMs: Date.now() - stuck.startedAt,
		});
		return "skipped";
	}
	const trace = { stage: "start", startedAt: Date.now() };
	if (tick) tick.taskId = task.id;
	prTaskInFlight.set(task.id, trace);
	const pinned = pollPinnedPrWatches(project, task).catch((err) => {
		log.warn("Pinned PR watch read failed", { taskId: task.id.slice(0, 8), error: String(err) });
	});
	const own = ownsPrPoll(project, task) ? pollTaskPrStatus(project, task, suggestCompletion, false, trace) : Promise.resolve(null);
	const poll = Promise.all([own, pinned]).then(([result]) => result);
	const settle = () => { if (prTaskInFlight.get(task.id) === trace) prTaskInFlight.delete(task.id); };
	poll.then(settle, settle);
	prTick.tasksPolled++;
	try {
		return await withTimeout(poll, PR_TASK_POLL_TIMEOUT_MS);
	} catch (err) {
		if (!(err instanceof PollTimeoutError)) throw err;
		prTick.taskTimeouts++;
		log.warn("PR check timed out for task", { taskId: task.id.slice(0, 8), stage: trace.stage, timeoutMs: PR_TASK_POLL_TIMEOUT_MS });
		return null;
	}
}

export async function checkOpenPRsForPromotion(tick?: PrTickInFlight): Promise<void> {
	if (!getPushMessage()) return;
	// An abandoned tick (watchdog started a newer one) stops at the next boundary.
	const abandoned = () => tick !== undefined && tick.generation !== prTick.generation;
	const stage = (name: string) => { if (tick) tick.stage = name; };

	stage("load-projects");
	const projects = await data.loadProjects();
	stage("load-settings");
	const settings = await loadSettings();
	const suggestCompletion = settings.suggestCompletingTasksAfterMerge !== false;
	const { projectId: activeProjectId } = getActiveContext();
	const foreground = isAppForeground();
	const now = Date.now();
	const wokeFromSleep = prLastTickAt !== 0 && wasAsleep(now - prLastTickAt, PR_POLL_INTERVAL_MS);
	prLastTickAt = now;

	const liveTaskIds = new Set<string>();
	for (const project of projects) {
		if (abandoned()) return;
		stage("load-tasks");
		const tasks = await data.loadTasks(project);
		// Detection remains limited to review statuses, but a task with a persisted
		// PR identity stays sticky through every non-terminal status so CI/review
		// state remains visible while an agent fixes reviewer feedback.
		const candidates = tasks.filter((task) => ownsPrPoll(project, task) || followsPinnedPrs(task));

		if (candidates.length === 0) continue;

		const isActiveFg = foreground && project.id === activeProjectId;
		const dueTasks = candidates.filter((task) => {
			liveTaskIds.add(task.id);
			const interval = prPollInterval(isActiveFg, task);
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
			if (abandoned()) return;
			stage("poll-task");
			let checkedAt = now;
			try {
				const result = await pollTaskWithinDeadline(project, task, suggestCompletion, tick);
				if (result === "skipped") continue;
				if (result) {
					lifecycleActorRuntime(task.id).prPending = result.found && result.ciStatus === "pending";
					checkedAt = result.checkedAt ?? now;
				}
			} catch (err) {
				log.warn("PR check failed for task", { taskId: task.id.slice(0, 8), error: String(err) });
			} finally {
				// Schedule from the shared sample so a cache hit cannot defer the next fetch by another minute.
				lifecycleActorRuntime(task.id).prNextDue = checkedAt + prPollInterval(isActiveFg, task);
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

/**
 * One on-demand poll. The outcome tells the popover whether it now shows fresh
 * GitHub data, or still the last known status because GitHub did not answer.
 */
export async function refreshTaskPrStatus(params: { taskId: string; projectId: string; force?: boolean }): Promise<RefreshTaskPrStatusResult> {
	if (!getPushMessage()) return { outcome: "skipped" };
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (project.kind === "virtual" || !task.worktreePath || TERMINAL_TASK_STATUSES.has(task.status)) return { outcome: "skipped" };
	const settings = await loadSettings();
	const suggestCompletion = settings.suggestCompletingTasksAfterMerge !== false;
	const result = await pollTaskPrStatus(project, task, suggestCompletion, params.force !== false);
	const runtime = lifecycleActorRuntime(task.id);
	if (result) runtime.prPending = result.found && result.ciStatus === "pending";
	delete runtime.prNextDue;
	if (!result) return { outcome: "unavailable" };
	return { outcome: result.reported ? "updated" : "not-found" };
}
