import {
	type BranchStatus,
	type PRInfo,
	type PRMergeState,
	type PRCIStatus,
	type Project,
	type Task,
	type TaskPRStatusCache,
	type TaskDiffMode,
	type TaskDiffResponse,
	type ScheduledMessageTarget,
	MERGE_COMPLETE_ELIGIBLE_STATUSES,
} from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import * as github from "../github";
import * as pty from "../pty-server";
import { spawn } from "../spawn";
import { sendPromptToAgentPane } from "../agent-prompt";
import {
	scheduleMessage as scheduleMessageCore,
	cancelScheduledMessage as cancelScheduledMessageCore,
	sendScheduledMessageNow as sendScheduledMessageNowCore,
} from "../scheduled-message-scheduler";
import { Semaphore } from "../concurrency";
import { getActiveContext, getPushMessage, isAppForeground, log, notifyWatchedTaskEvent, pushCliAttention } from "./shared";
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
	pruneSchedule,
	staggeredDue,
	wasAsleep,
} from "./git-poll-throttle";
import {
	type MergeCompletionFingerprint,
	MERGE_PROMPT_RETRY_SUPPRESS_MS,
	shouldSuppressMergePrompt,
} from "./merge-prompt-suppression";
import { computeSignalKey, countUnresolvedReviewThreads, mapReviewDecision, normalizeChecks, parseAutoMergeEnabled, parseReviewDecision, reasonForSignal, rollupCiStatus } from "./pr-status";

/**
 * Reject git-only RPCs for virtual (Operations) tasks. They have a working dir
 * but no git repo, so any git command would fail with a cryptic "not a git
 * repository". The UI already hides these affordances for virtual tasks; this is
 * defense-in-depth for CLI/programmatic callers and yields a clear error.
 */
function assertGitTask(project: Project, task: Task): asserts task is Task & { worktreePath: string } {
	if (project.kind === "virtual") {
		throw new Error("Git operations are not available for Operations tasks");
	}
	if (!task.worktreePath) {
		throw new Error("Task has no worktree");
	}
}

const gitOpPaneIds = new Map<string, string>();
// promptKey -> reservedAt (ms). A reservation only mutes re-prompts for
// MERGE_PROMPT_RETRY_SUPPRESS_MS: if the user never answers (app restart,
// undelivered push), the prompt must come back instead of being lost forever.
const mergeNotifiedPromptKeys = new Map<string, number>();
const branchStatusInFlight = new Map<string, Promise<BranchStatus>>();
// Bound concurrent heavy branch-status runs across all tasks (see getBranchStatus).
const GIT_STATUS_MAX_CONCURRENCY = 4;
const branchStatusSemaphore = new Semaphore(GIT_STATUS_MAX_CONCURRENCY);
// Cap the PR-detection `gh` call: it holds a semaphore slot for its whole
// duration, so a hung gh on a slow network must not stall branch-status globally.
const PR_DETECTION_TIMEOUT_MS = 15_000;
const prPromotedTasks = new Set<string>();
// taskId -> last CI/review signal key we already raised attention for. Lets the
// poller fire the bell / watched-notification only on a *transition* to a new
// worthy state (e.g. CI flips to failure, a reviewer approves), not on every
// 5-minute tick while the state is unchanged. See computeSignalKey().
const prSignalState = new Map<string, string>();

// taskId -> next time each poller may run its heavy git check for that task.
// The scheduling math (intervals, jitter, wake re-spread) lives in
// git-poll-throttle.ts (dependency-free + unit-tested).
const mergeTaskNextDue = new Map<string, number>();
const prTaskNextDue = new Map<string, number>();
const prPendingState = new Map<string, boolean>();
// Wall-clock of the previous tick, per poller, to detect host sleep gaps.
let mergeLastTickAt = 0;
let prLastTickAt = 0;
// Injectable RNG so jitter is deterministic under test.
let scheduleRandom: () => number = Math.random;

export function _setScheduleRandomForTest(fn: () => number): void {
	scheduleRandom = fn;
}

function mergePromptKey(taskId: string, fingerprint: string | null): string {
	return `${taskId}:${fingerprint || "unknown"}`;
}

function isPromptKeyReserved(promptKey: string, nowMs: number): boolean {
	const reservedAt = mergeNotifiedPromptKeys.get(promptKey);
	if (reservedAt === undefined) return false;
	if (nowMs - reservedAt > MERGE_PROMPT_RETRY_SUPPRESS_MS) {
		mergeNotifiedPromptKeys.delete(promptKey);
		return false;
	}
	return true;
}

async function getMergeCompletionFingerprint(task: Pick<Task, "id" | "worktreePath" | "branchName">, branchName: string | null): Promise<MergeCompletionFingerprint> {
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

async function reserveMergeCompletionPrompt(project: Project, task: Task, fingerprint: MergeCompletionFingerprint, now = new Date(), force = false): Promise<boolean> {
	const promptKey = mergePromptKey(task.id, fingerprint.fingerprint);
	const nowMs = now.getTime();
	// A forced re-check (user clicked the git refresh button) deliberately
	// ignores the in-memory reservation and any prior dismissal: an explicit
	// click means "ask me again, regardless of what I answered before".
	if (!force) {
		if (isPromptKeyReserved(promptKey, nowMs)) return false;

		if (shouldSuppressMergePrompt(task.mergeCompletionPrompt, fingerprint, nowMs)) {
			mergeNotifiedPromptKeys.set(promptKey, nowMs);
			return false;
		}
	}

	// Reserve the slot before awaiting so concurrent callers see the key immediately
	// and cannot both pass the reservation check above.
	mergeNotifiedPromptKeys.set(promptKey, nowMs);
	await data.updateTask(project, task.id, {
		mergeCompletionPrompt: {
			fingerprint: fingerprint.fingerprint,
			promptedAt: now.toISOString(),
			dismissedAt: null,
			precise: fingerprint.precise,
		},
	});
	return true;
}

async function prepareMergeCompletionPrompt(params: { taskId: string; projectId: string; fingerprint?: string | null; force?: boolean }): Promise<{ shouldPrompt: boolean; fingerprint: string | null }> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const fingerprint = params.fingerprint
		? { fingerprint: params.fingerprint, precise: params.fingerprint.startsWith("v1:") }
		: await getMergeCompletionFingerprint(task, task.branchName);
	const shouldPrompt = await reserveMergeCompletionPrompt(project, task, fingerprint, new Date(), params.force === true);
	return { shouldPrompt, fingerprint: fingerprint.fingerprint };
}

async function dismissMergeCompletionPrompt(params: { taskId: string; projectId: string; fingerprint: string | null }): Promise<Task> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const fingerprint = params.fingerprint
		? { fingerprint: params.fingerprint, precise: params.fingerprint.startsWith("v1:") }
		: await getMergeCompletionFingerprint(task, task.branchName);
	const now = new Date().toISOString();
	const existing = task.mergeCompletionPrompt;
	const updated = await data.updateTask(project, task.id, {
		mergeCompletionPrompt: {
			fingerprint: fingerprint.fingerprint,
			promptedAt: existing?.fingerprint === fingerprint.fingerprint ? existing.promptedAt : now,
			dismissedAt: now,
			precise: fingerprint.precise,
		},
	});
	return updated;
}

async function killExistingGitPane(taskId: string, tmuxSession: string, socket: string): Promise<void> {
	const existingPane = gitOpPaneIds.get(taskId);
	if (existingPane) {
		const kill = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", existingPane));
		await kill.exited;
		gitOpPaneIds.delete(taskId);
		log.info("Killed existing git op pane (from map)", { taskId: taskId.slice(0, 8), paneId: existingPane });
		return;
	}

	const listProc = spawn(pty.tmuxArgs(socket,
		"list-panes", "-t", tmuxSession,
		"-F", "#{pane_id} #{pane_start_command}",
	), { stdout: "pipe", stderr: "pipe" });
	const listOutput = await new Response(listProc.stdout).text();
	await listProc.exited;
	for (const line of listOutput.trim().split("\n")) {
		if (!line.includes(`dev3-${taskId}-git-`)) continue;
		const paneId = line.split(" ")[0];
		const kill = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", paneId));
		await kill.exited;
		log.info("Killed existing git op pane (from tmux scan)", { taskId: taskId.slice(0, 8), paneId });
	}
}

async function openGitOpPane(tmuxSession: string, cwd: string, scriptPath: string, socket: string): Promise<string | null> {
	const proc = spawn(pty.tmuxArgs(socket,
		"split-window", "-v", "-l", "20%",
		"-t", tmuxSession,
		"-c", cwd,
		"-P", "-F", "#{pane_id}",
		`bash "${scriptPath}"`,
	), { stdout: "pipe", stderr: "pipe" });
	const output = await new Response(proc.stdout).text();
	const stderrOutput = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (stderrOutput.trim()) {
		log.warn("openGitOpPane tmux stderr", { stderr: stderrOutput.trim() });
	}
	if (exitCode !== 0) {
		throw new Error(`tmux split-window failed (exit ${exitCode}): ${stderrOutput.trim() || "unknown error"}`);
	}

	return output.trim() || null;
}

function monitorGitPane(paneId: string | null, taskId: string, projectId: string, operation: string, socket: string): void {
	if (!paneId) return;
	const tmuxSession = `dev3-${taskId.slice(0, 8)}`;
	const exitFilePath = `/tmp/dev3-${taskId}-git-${operation}.sh.exit`;

	let interval: ReturnType<typeof setInterval> | undefined;
	let safetyTimeout: ReturnType<typeof setTimeout> | undefined;

	function cleanup() {
		if (interval !== undefined) clearInterval(interval);
		if (safetyTimeout !== undefined) clearTimeout(safetyTimeout);
		interval = undefined;
		safetyTimeout = undefined;
	}

	try {
		interval = setInterval(async () => {
			try {
				const listProc = spawn(pty.tmuxArgs(socket,
					"list-panes", "-t", tmuxSession, "-F", "#{pane_id}",
				), { stdout: "pipe", stderr: "pipe" });
				const output = await new Response(listProc.stdout).text();
				await listProc.exited;

				const paneStillExists = output.trim().split("\n").includes(paneId);

				if (!paneStillExists) {
					cleanup();
					gitOpPaneIds.delete(taskId);

					let ok = false;
					try {
						const exitCodeStr = await Bun.file(exitFilePath).text();
						ok = exitCodeStr.trim() === "0";
					} catch {}

					log.info("Git op pane closed", { taskId: taskId.slice(0, 8), operation, ok });
					getPushMessage()?.("gitOpCompleted", { taskId, projectId, operation, ok });
				}
			} catch {
				cleanup();
			}
		}, 1000);

		safetyTimeout = setTimeout(() => cleanup(), 10 * 60 * 1000);
	} catch {
		cleanup();
	}
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
	// A tick far later than the base interval means the host was suspended
	// (laptop sleep): re-spread overdue tasks instead of firing them all at once.
	const wokeFromSleep = mergeLastTickAt !== 0 && wasAsleep(now - mergeLastTickAt, MERGE_POLL_INTERVAL_MS);
	mergeLastTickAt = now;

	if (mergeNotifiedPromptKeys.size > 0 || prPromotedTasks.size > 0) {
		// Merge detection itself is git-only (below), but the orphan-state reap must
		// see EVERY live task id — including virtual ones — or a deleted virtual
		// task's stale key would linger in these maps forever (slow memory leak).
		const allTaskIds = new Set<string>();
		for (const project of [...projects, ...await data.loadVirtualProjects()]) {
			const tasks = await data.loadTasks(project);
			for (const task of tasks) allTaskIds.add(task.id);
		}
		for (const key of [...mergeNotifiedPromptKeys.keys()]) {
			const taskId = key.slice(0, key.indexOf(":"));
			if (!allTaskIds.has(taskId)) mergeNotifiedPromptKeys.delete(key);
		}
		for (const id of prPromotedTasks) {
			if (!allTaskIds.has(id)) prPromotedTasks.delete(id);
		}
	}

	const liveTaskIds = new Set<string>();
	for (const project of projects) {
		const tasks = await data.loadTasks(project);
		const reviewTasks = tasks.filter(
			(task) => MERGE_COMPLETE_ELIGIBLE_STATUSES.includes(task.status) && task.worktreePath,
		);

		if (reviewTasks.length === 0) continue;

		const isActiveFg = foreground && project.id === activeProjectId;
		const interval = intervalForTask(isActiveFg, ACTIVE_PROJECT_MERGE_INTERVAL_MS, BACKGROUND_PROJECT_MERGE_INTERVAL_MS);

		// Decide which tasks are due this tick; schedule (or re-spread) the rest.
		const dueTasks = reviewTasks.filter((task) => {
			liveTaskIds.add(task.id);
			let scheduled = mergeTaskNextDue.get(task.id);
			if (scheduled === undefined) {
				// First sight: the on-screen project checks now, everything else is
				// spread across its interval so a batch never fires on one tick.
				scheduled = isActiveFg ? now : staggeredDue(now, interval, scheduleRandom);
				mergeTaskNextDue.set(task.id, scheduled);
			}
			if (wokeFromSleep) {
				mergeTaskNextDue.set(task.id, staggeredDue(now, interval, scheduleRandom));
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
				const promptKey = mergePromptKey(task.id, fingerprint.fingerprint);
				const nowMs = Date.now();
				if (isPromptKeyReserved(promptKey, nowMs)) continue;
				if (shouldSuppressMergePrompt(task.mergeCompletionPrompt, fingerprint, nowMs)) continue;

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

				const shouldPrompt = await reserveMergeCompletionPrompt(project, task, fingerprint);
				if (!shouldPrompt) continue;

				log.info("Branch merge detected", { taskId: task.id.slice(0, 8), branch: branchName });
				pushMessage("branchMerged", {
					taskId: task.id,
					projectId: project.id,
					taskTitle: task.customTitle || task.title,
					branchName,
					fingerprint: fingerprint.fingerprint,
				});
			} catch (err) {
				log.warn("Merge check failed for task", { taskId: task.id.slice(0, 8), error: String(err) });
			} finally {
				// Reschedule regardless of outcome (merged, dirty, suppressed, error)
				// so this task does not re-run until its next jittered slot.
				mergeTaskNextDue.set(task.id, nextDueAfterRun(now, interval, scheduleRandom));
			}
		}
	}
	pruneSchedule(mergeTaskNextDue, liveTaskIds);
}

export function clearMergeNotification(taskId: string): void {
	for (const key of [...mergeNotifiedPromptKeys.keys()]) {
		if (key.startsWith(`${taskId}:`)) mergeNotifiedPromptKeys.delete(key);
	}
}

export function _resetMergePollerState(): void {
	mergeNotifiedPromptKeys.clear();
	mergeTaskNextDue.clear();
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
	prPromotedTasks.clear();
	prSignalState.clear();
	prTaskNextDue.clear();
	prPendingState.clear();
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

const REVIEW_STATUS_CANDIDATES = new Set<Task["status"]>(["review-by-user", "review-by-colleague"]);
const TERMINAL_TASK_STATUSES = new Set<Task["status"]>(["completed", "cancelled"]);

function isStickyPRTask(task: Task): boolean {
	return task.prNumber != null && !TERMINAL_TASK_STATUSES.has(task.status);
}

async function persistTaskPrIdentity(project: Project, task: Task, prNumber: number, prUrl: string): Promise<void> {
	if (task.prNumber === prNumber && task.prUrl === prUrl) return;
	const updated = await data.updateTask(project, task.id, { prNumber, prUrl });
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
}

function sameFreshPRStatus(cache: TaskPRStatusCache | null | undefined, next: FreshPRStatus): boolean {
	return !!cache
		&& cache.number === next.number
		&& cache.url === next.url
		&& cache.autoMergeEnabled === next.autoMergeEnabled
		&& cache.ciStatus === next.ciStatus
		&& cache.reviewState === next.reviewState
		&& cache.reviewDecision === next.reviewDecision
		&& cache.unresolvedCount === next.unresolvedCount
		&& JSON.stringify(cache.mergeState) === JSON.stringify(next.mergeState)
		&& JSON.stringify(cache.checks) === JSON.stringify(next.checks)
		&& cache.prTitle === next.prTitle
		&& cache.isDraft === next.isDraft;
}

/**
 * Keep the last successful rich PR response on the task so a later board load
 * can render it before GitHub answers. Cache persistence is best-effort: a
 * stale cache must never prevent the fresh response from reaching the UI.
 */
async function persistTaskPrStatusCache(project: Project, task: Task, next: FreshPRStatus): Promise<void> {
	if (task.prNumber === next.number && task.prUrl === next.url && sameFreshPRStatus(task.prStatusCache, next)) return;
	try {
		await data.updateTask(project, task.id, {
			prNumber: next.number,
			prUrl: next.url,
			prStatusCache: { ...next, cachedAt: new Date().toISOString() },
		});
	} catch (error) {
		log.warn("PR status cache persistence failed (non-fatal)", { taskId: task.id.slice(0, 8), error: String(error) });
	}
}

async function persistProjectPrIdentities(project: Project, prs: PRInfo[]): Promise<void> {
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
	return prPendingState.get(taskId)
		? intervalForTask(isActiveForeground, ACTIVE_PROJECT_PENDING_PR_INTERVAL_MS, BACKGROUND_PROJECT_PENDING_PR_INTERVAL_MS)
		: intervalForTask(isActiveForeground, ACTIVE_PROJECT_PR_INTERVAL_MS, BACKGROUND_PROJECT_PR_INTERVAL_MS);
}

function parseGitHubPullRequestUrl(url: string): { host: string; owner: string; repo: string } | null {
	try {
		const parsed = new URL(url);
		const parts = parsed.pathname.split("/").filter(Boolean);
		const pullIndex = parts.indexOf("pull");
		if (pullIndex < 2) return null;
		const owner = parts[pullIndex - 2];
		const repo = parts[pullIndex - 1]?.replace(/\.git$/, "");
		return owner && repo && parsed.hostname ? { host: parsed.hostname, owner, repo } : null;
	} catch {
		return null;
	}
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

async function pollTaskPrStatus(project: Project, task: Task, pushMessage: NonNullable<ReturnType<typeof getPushMessage>>): Promise<PolledPRStatus | null> {
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

	if (prUrl) {
		await persistTaskPrStatusCache(project, task, {
			number: prNumber,
			url: prUrl,
			autoMergeEnabled,
			ciStatus,
			reviewState,
			reviewDecision,
			unresolvedCount,
			mergeState,
			checks,
			prTitle,
			isDraft,
		});
	}

	pushMessage("taskPrStatus", {
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
	});

	// Raise the bell / native notification only on a *transition* to a new
	// worthy signal. Unresolved-thread changes deliberately stay passive.
	const signalKey = computeSignalKey(ciStatus, reviewState);
	if (signalKey && prSignalState.get(task.id) !== signalKey) {
		prSignalState.set(task.id, signalKey);
		const reason = reasonForSignal(ciStatus, reviewState);
		pushCliAttention({ taskId: task.id, reason });
		notifyWatchedTaskEvent(task, reason, project.name);
	} else if (!signalKey) {
		prSignalState.delete(task.id);
	}

	const isOpenNonDraft = isOpenPr && isDraft === false;
	if (task.status === "review-by-user" && isOpenNonDraft && !prPromotedTasks.has(task.id)) {
		prPromotedTasks.add(task.id);
		log.info("Open PR detected — promoting to review-by-colleague", {
			taskId: task.id.slice(0, 8),
			branch: branchName,
			pr: prNumber,
		});
		const updated = await data.updateTask(project, task.id, { status: "review-by-colleague" });
		pushMessage("taskUpdated", { projectId: project.id, task: updated });
	}

	return { found: isOpenPr, ciStatus };
}


export async function checkOpenPRsForPromotion(): Promise<void> {
	const pushMessage = getPushMessage();
	if (!pushMessage) return;

	if (prPromotedTasks.size > 500) {
		log.warn("prPromotedTasks exceeded 500 entries, clearing", { size: prPromotedTasks.size });
		prPromotedTasks.clear();
	}

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
		const candidates = tasks.filter(
			(task) =>
				!!task.worktreePath &&
				(isStickyPRTask(task) || (project.peerReviewEnabled !== false && REVIEW_STATUS_CANDIDATES.has(task.status))),
		);

		if (candidates.length === 0) continue;

		const isActiveFg = foreground && project.id === activeProjectId;
		const dueTasks = candidates.filter((task) => {
			liveTaskIds.add(task.id);
			const interval = prPollInterval(isActiveFg, task.id);
			let scheduled = prTaskNextDue.get(task.id);
			if (scheduled === undefined) {
				scheduled = isActiveFg ? now : staggeredDue(now, interval, scheduleRandom);
				prTaskNextDue.set(task.id, scheduled);
			}
			if (wokeFromSleep) {
				prTaskNextDue.set(task.id, staggeredDue(now, interval, scheduleRandom));
				return false;
			}
			return isDue(scheduled, now);
		});

		if (dueTasks.length === 0) continue;

		for (const task of dueTasks) {
			try {
				const result = await pollTaskPrStatus(project, task, pushMessage);
				if (result) prPendingState.set(task.id, result.found && result.ciStatus === "pending");
			} catch (err) {
				log.warn("PR check failed for task", { taskId: task.id.slice(0, 8), error: String(err) });
			} finally {
				prTaskNextDue.set(task.id, nextDueAfterRun(now, prPollInterval(isActiveFg, task.id), scheduleRandom));
			}
		}
	}
	pruneSchedule(prTaskNextDue, liveTaskIds);
	pruneSchedule(prPendingState, liveTaskIds);
	// Drop signal state for tasks no longer being polled so a re-entry to a
	// review status re-raises the signal fresh.
	for (const id of prSignalState.keys()) {
		if (!liveTaskIds.has(id)) prSignalState.delete(id);
	}
}

async function refreshTaskPrStatus(params: { taskId: string; projectId: string }): Promise<void> {
	const pushMessage = getPushMessage();
	if (!pushMessage) return;
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (project.kind === "virtual" || !task.worktreePath || TERMINAL_TASK_STATUSES.has(task.status)) return;
	const result = await pollTaskPrStatus(project, task, pushMessage);
	if (result) prPendingState.set(task.id, result.found && result.ciStatus === "pending");
	prTaskNextDue.delete(task.id);
}

export function cleanupTaskGitState(taskId: string): void {
	gitOpPaneIds.delete(taskId);
	clearMergeNotification(taskId);
	prPromotedTasks.delete(taskId);
	prSignalState.delete(taskId);
	prPendingState.delete(taskId);
	prTaskNextDue.delete(taskId);
	branchStatusInFlight.delete(taskId);
}

async function getBranchStatusImpl(params: { taskId: string; projectId: string; compareRef?: string }): Promise<BranchStatus> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	// Virtual (Operations) tasks have a working dir but no git repo. The renderer
	// polls this every 15s for any active task with a worktreePath, so return an
	// inert status instead of spawning a doomed `git` in a non-repo directory.
	if (project.kind === "virtual" || !task.worktreePath) {
		return { ahead: 0, behind: 0, canRebase: false, insertions: 0, deletions: 0, unpushed: 0, mergedByContent: false, diffFiles: 0, diffInsertions: 0, diffDeletions: 0, diffFileStats: [], prNumber: null, prUrl: null, mergeCompletionFingerprint: null };
	}

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	const liveBranch = await git.getCurrentBranch(task.worktreePath);
	const branchForPush = liveBranch ?? task.branchName ?? "";

	if (liveBranch && liveBranch !== task.branchName) {
		log.info("getBranchStatus: branch renamed, syncing stored name", { old: task.branchName, new: liveBranch });
		const updated = await data.updateTask(project, task.id, { branchName: liveBranch });
		// Persisting alone leaves the renderer's in-memory task with the stale
		// branch name (it only refreshes on a taskUpdated push), so the header,
		// task cards, and detail modal keep showing the old branch until reload.
		// Broadcast the update so every open surface re-renders with the new name.
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	}

	log.debug("getBranchStatus: fetching origin", { worktreePath: task.worktreePath, baseBranch, branchName: branchForPush });
	await git.fetchOrigin(project.path, baseBranch);
	const ref = params.compareRef || `origin/${baseBranch}`;
	const compareRefBranch = params.compareRef?.startsWith("origin/") ? params.compareRef.slice("origin/".length) : null;
	if (compareRefBranch && compareRefBranch !== baseBranch) {
		await git.fetchOrigin(project.path, compareRefBranch);
	}
	// Also refresh origin/<task-branch> so getUnpushedCount reflects out-of-band remote pushes.
	if (branchForPush && branchForPush !== baseBranch && branchForPush !== compareRefBranch) {
		await git.fetchOrigin(project.path, branchForPush);
	}
	const prDetection: Promise<{ number: number; url: string } | null> = (async () => {
		try {
			const ghResult = await github.runGitHub(
				project,
				task.worktreePath!,
				["pr", "list", "--head", branchForPush, "--state", "open", "--json", "number,url", "--limit", "1"],
				{ timeoutMs: PR_DETECTION_TIMEOUT_MS },
			);
			if (ghResult.ok && ghResult.stdout) {
				const prs = JSON.parse(ghResult.stdout);
				if (Array.isArray(prs) && prs.length > 0 && typeof prs[0].number === "number") {
					const pr = { number: prs[0].number, url: typeof prs[0].url === "string" ? prs[0].url : "" };
					if (pr.url) await persistTaskPrIdentity(project, task, pr.number, pr.url);
					return pr;
				}
			}
		} catch (err) {
			log.warn("PR detection failed (non-fatal)", { error: String(err) });
		}
		return null;
	})();

	const [status, uncommitted, unpushed, branchDiff, detectedPr] = await Promise.all([
		git.getBranchStatus(task.worktreePath, ref),
		git.getUncommittedChanges(task.worktreePath),
		git.getUnpushedCount(task.worktreePath, branchForPush),
		git.getBranchDiffStats(task.worktreePath, ref),
		prDetection,
	]);
	const prInfo = detectedPr ?? (task.prNumber != null && task.prUrl
		? { number: task.prNumber, url: task.prUrl }
		: null);
	const prNumber = prInfo?.number ?? null;
	const prUrl = prInfo?.url ?? null;
	log.debug("getBranchStatus: raw results", { status, uncommitted, unpushed, branchDiff, prNumber, prUrl, ref });
	const canRebase = status.behind > 0 ? await git.canRebaseCleanly(task.worktreePath, ref) : false;
	const mergedByContent = status.ahead > 0 ? await git.isContentMergedInto(task.worktreePath, ref, project) === true : false;
	const mergeCompletionFingerprint = mergedByContent
		? (await getMergeCompletionFingerprint(task, branchForPush)).fingerprint
		: null;

	const result = {
		...status, canRebase, ...uncommitted, unpushed, mergedByContent,
		diffFiles: branchDiff.files, diffInsertions: branchDiff.insertions, diffDeletions: branchDiff.deletions, diffFileStats: branchDiff.fileStats,
		prNumber, prUrl,
		mergeCompletionFingerprint,
	};
	log.debug("← getBranchStatus", result);

	git.saveDiffSnapshot(project, task, ref).catch((err) => {
		log.warn("saveDiffSnapshot failed", { taskId: task.id, error: String(err) });
	});

	return result;
}

async function getBranchStatus(params: { taskId: string; projectId: string; compareRef?: string }) {
	log.debug("→ getBranchStatus", params);
	const dedupKey = `${params.taskId}:${params.compareRef ?? ""}`;
	const existing = branchStatusInFlight.get(dedupKey);
	if (existing) {
		log.debug("getBranchStatus: reusing in-flight request", { taskId: params.taskId });
		return existing;
	}

	// Cap cross-task concurrency: each impl run spawns `git fetch` + `gh` + many
	// local git commands. A wave of panels polling at once (e.g. on wake) would
	// otherwise fork dozens of git processes simultaneously and choke the machine.
	const promise = branchStatusSemaphore.run(() => getBranchStatusImpl(params));
	branchStatusInFlight.set(dedupKey, promise);
	try {
		return await promise;
	} finally {
		branchStatusInFlight.delete(dedupKey);
	}
}

async function getTaskDiff(params: {
	taskId: string;
	projectId: string;
	mode: TaskDiffMode;
	compareRef?: string;
	compareLabel?: string;
	count?: number;
}): Promise<TaskDiffResponse> {
	log.info("→ getTaskDiff", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	// `uncommitted` needs no remote ref; `recent` is purely local — it diffs
	// `HEAD~N..HEAD` and clamps against the already on-disk `origin/<base>`
	// merge-base — so neither pays for a network fetch.
	if (params.mode !== "uncommitted" && params.mode !== "recent") {
		await git.fetchOrigin(project.path, baseBranch);
		const compareRefBranch = params.compareRef?.startsWith("origin/") ? params.compareRef.slice("origin/".length) : null;
		if (compareRefBranch && compareRefBranch !== baseBranch) {
			await git.fetchOrigin(project.path, compareRefBranch);
		}
	}

	const result = await git.getTaskDiff(task.worktreePath, params.mode, {
		baseBranch,
		compareRef: params.compareRef,
		compareLabel: params.compareLabel,
		count: params.count,
	});
	const skippedBinary = result.skippedFiles.filter((f) => f.reason === "binary").length;
	const skippedLarge = result.skippedFiles.filter((f) => f.reason === "too-large").length;
	log.info("← getTaskDiff", {
		mode: result.mode,
		files: result.files.length,
		binary: skippedBinary,
		large: skippedLarge,
		fallbackReason: result.fallbackReason,
	});
	return result;
}

async function rebaseTask(params: { taskId: string; projectId: string; compareRef?: string }): Promise<void> {
	log.info("→ rebaseTask", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	const rebaseTarget = params.compareRef || `origin/${baseBranch}`;
	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
	const scriptPath = `/tmp/dev3-${task.id}-git-rebase.sh`;
	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await killExistingGitPane(task.id, tmuxSession, socket);

	// Fetch the ref we will actually rebase onto, not just baseBranch.
	// rebaseTarget may be a custom compareRef (e.g. origin/develop) that differs from baseBranch.
	const fetchBranch = rebaseTarget.startsWith("origin/")
		? rebaseTarget.slice("origin/".length)
		: baseBranch;

	const script = [
		`#!/bin/bash`,
		`echo "Fetching origin..."`,
		`git fetch origin ${fetchBranch} --quiet`,
		`echo "Rebasing on ${rebaseTarget}..."`,
		`set -x`,
		`git rebase ${rebaseTarget}`,
		`EXIT_CODE=$?`,
		`set +x`,
		`echo $EXIT_CODE > "${scriptPath}.exit"`,
		`echo ""`,
		`if [ $EXIT_CODE -eq 0 ]; then`,
		`  printf '\\033[1;32m✓ Rebase complete\\033[0m\\n'`,
		`  sleep 5`,
		`else`,
		`  printf '\\033[1;31m✗ Rebase failed (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
		`  echo "Resolve conflicts in the main terminal, then: git rebase --continue"`,
		`  echo "Or abort with: git rebase --abort"`,
		`  echo ""`,
		`  echo "Press any key to close this pane."`,
		`  read -n 1 -s`,
		`fi`,
	].join("\n") + "\n";
	await Bun.write(scriptPath, script);

	const paneId = await openGitOpPane(tmuxSession, task.worktreePath, scriptPath, socket);
	if (paneId) gitOpPaneIds.set(task.id, paneId);
	monitorGitPane(paneId, task.id, params.projectId, "rebase", socket);

	log.info("← rebaseTask (pane opened)", { paneId });
}

async function mergeTask(params: { taskId: string; projectId: string }): Promise<void> {
	log.info("→ mergeTask", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);

	const liveBranch = await git.getCurrentBranch(task.worktreePath);
	const branchForMerge = liveBranch ?? task.branchName;
	if (!branchForMerge) throw new Error("Task has no branch");

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	await git.fetchOrigin(project.path, baseBranch);
	// For task-specific base branches (not the project default), compare against the local branch —
	// consistent with what the UI displays. For the project default, check against the remote.
	const projectBaseBranch = project.defaultBaseBranch || "main";
	const rebaseCheckRef = baseBranch !== projectBaseBranch ? baseBranch : `origin/${baseBranch}`;
	const status = await git.getBranchStatus(task.worktreePath, rebaseCheckRef);
	if (status.behind > 0) throw new Error("Branch is not rebased — rebase first");

	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
	const scriptPath = `/tmp/dev3-${task.id}-git-merge.sh`;
	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await killExistingGitPane(task.id, tmuxSession, socket);

	const escapedPath = project.path.replace(/'/g, "'\\''");
	const escapedBaseBranch = baseBranch.replace(/'/g, "'\\''");
	const escapedRemoteBaseBranch = `origin/${baseBranch}`.replace(/'/g, "'\\''");
	const escapedTitle = task.title.replace(/'/g, "'\\''");

	const script = [
		`#!/bin/bash`,
		`cd '${escapedPath}'`,
		`TARGET_BRANCH='${escapedBaseBranch}'`,
		`TARGET_REMOTE='${escapedRemoteBaseBranch}'`,
		`CURRENT_BRANCH=$(git branch --show-current)`,
		`if [ "$CURRENT_BRANCH" != "$TARGET_BRANCH" ]; then`,
		`  echo "Switching project branch to ${baseBranch}..."`,
		`  if git rev-parse --verify "$TARGET_BRANCH" >/dev/null 2>&1; then`,
		`    set -x`,
		`    git checkout "$TARGET_BRANCH"`,
		`    CHECKOUT_CODE=$?`,
		`    set +x`,
		`  elif git rev-parse --verify "$TARGET_REMOTE" >/dev/null 2>&1; then`,
		`    set -x`,
		`    git checkout --track -b "$TARGET_BRANCH" "$TARGET_REMOTE"`,
		`    CHECKOUT_CODE=$?`,
		`    set +x`,
		`  else`,
		`    echo "Base branch ${baseBranch} does not exist locally or on origin."`,
		`    CHECKOUT_CODE=1`,
		`  fi`,
		`  if [ $CHECKOUT_CODE -ne 0 ]; then`,
		`    echo $CHECKOUT_CODE > "${scriptPath}.exit"`,
		`    echo ""`,
		`    printf '\\033[1;31m✗ Checkout failed (exit %s)\\033[0m\\n' "$CHECKOUT_CODE"`,
		`    echo "Press any key to close."`,
		`    read -n 1 -s`,
		`    exit $CHECKOUT_CODE`,
		`  fi`,
		`fi`,
		`echo "Squash-merging ${branchForMerge} into $TARGET_BRANCH..."`,
		`set -x`,
		`git merge --squash ${branchForMerge}`,
		`MERGE_CODE=$?`,
		`set +x`,
		`if [ $MERGE_CODE -ne 0 ]; then`,
		`  echo $MERGE_CODE > "${scriptPath}.exit"`,
		`  echo ""`,
		`  printf '\\033[1;31m✗ Merge failed (exit %s)\\033[0m\\n' "$MERGE_CODE"`,
		`  echo "Press any key to close."`,
		`  read -n 1 -s`,
		`  exit $MERGE_CODE`,
		`fi`,
		`set -x`,
		`git commit -m '${escapedTitle}'`,
		`EXIT_CODE=$?`,
		`set +x`,
		`echo $EXIT_CODE > "${scriptPath}.exit"`,
		`echo ""`,
		`if [ $EXIT_CODE -eq 0 ]; then`,
		`  printf '\\033[1;32m✓ Merge complete\\033[0m\\n'`,
		`  sleep 5`,
		`else`,
		`  printf '\\033[1;31m✗ Commit failed (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
		`  echo "Press any key to close."`,
		`  read -n 1 -s`,
		`fi`,
	].join("\n") + "\n";
	await Bun.write(scriptPath, script);

	const paneId = await openGitOpPane(tmuxSession, project.path, scriptPath, socket);
	if (paneId) gitOpPaneIds.set(task.id, paneId);
	monitorGitPane(paneId, task.id, params.projectId, "merge", socket);

	log.info("← mergeTask (pane opened)", { paneId });
}

async function pushTask(params: { taskId: string; projectId: string }): Promise<void> {
	log.info("→ pushTask", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);

	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
	const scriptPath = `/tmp/dev3-${task.id}-git-push.sh`;
	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await killExistingGitPane(task.id, tmuxSession, socket);

	const script = [
		`#!/bin/bash`,
		`set -x`,
		`git push origin HEAD`,
		`EXIT_CODE=$?`,
		`set +x`,
		`echo $EXIT_CODE > "${scriptPath}.exit"`,
		`echo ""`,
		`if [ $EXIT_CODE -eq 0 ]; then`,
		`  printf '\\033[1;32m✓ Push complete\\033[0m\\n'`,
		`  sleep 2`,
		`else`,
		`  printf '\\033[1;31m✗ Push failed (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
		`  echo "Press any key to close."`,
		`  read -n 1 -s`,
		`fi`,
	].join("\n") + "\n";
	await Bun.write(scriptPath, script);

	const paneId = await openGitOpPane(tmuxSession, task.worktreePath, scriptPath, socket);
	if (paneId) gitOpPaneIds.set(task.id, paneId);
	monitorGitPane(paneId, task.id, params.projectId, "push", socket);

	log.info("← pushTask (pane opened)", { paneId });
}

const CREATE_PR_AGENT_PROMPT =
	"Please push this branch and open a pull request for it using the gh CLI (first run git push, then gh pr create). Choose an appropriate title and description based on the work in this conversation.";

const CREATE_PR_AUTO_MERGE_AGENT_PROMPT =
	"Please push this branch and open a pull request for it using the gh CLI (first run git push, then gh pr create). Choose an appropriate title and description based on the work in this conversation. Finally, enable auto-merge on the PR with gh pr merge --auto so it merges automatically once checks pass.";

function rebaseConflictAgentPrompt(rebaseTarget: string): string {
	return `This branch cannot be rebased automatically onto ${rebaseTarget} because of merge conflicts. Please rebase it and resolve the conflicts: run \`git fetch origin\`, then \`git rebase ${rebaseTarget}\`, resolve each conflict carefully preserving the intent of both sides, \`git add\` the resolved files, and \`git rebase --continue\` until the rebase finishes. If it becomes unsafe, abort with \`git rebase --abort\` and explain what happened.`;
}

async function createPullRequest(params: { taskId: string; projectId: string; autoMerge?: boolean }): Promise<void> {
	log.info("→ createPullRequest", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);

	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;

	const prompt = params.autoMerge ? CREATE_PR_AUTO_MERGE_AGENT_PROMPT : CREATE_PR_AGENT_PROMPT;
	const handedOff = await sendPromptToAgentPane(tmuxSession, socket, prompt, task.sessionState?.panes);
	if (!handedOff) {
		log.info("← createPullRequest skipped — no active pane", { taskId: task.id.slice(0, 8) });
		return;
	}

	log.info("← createPullRequest (prompt sent to agent)", { taskId: task.id.slice(0, 8) });
}

/**
 * Rebase-conflict handoff: when `git rebase` cannot apply cleanly (canRebase is
 * false), the UI routes the Rebase button here instead of opening a doomed
 * auto-rebase pane. We ask the agent in the task terminal to perform the rebase
 * and resolve the conflicts. Returns whether the prompt actually reached an
 * agent pane so the UI can confirm the handoff (or warn that no terminal exists).
 */
async function rebaseTaskViaAgent(params: { taskId: string; projectId: string; compareRef?: string }): Promise<{ handedOff: boolean }> {
	log.info("→ rebaseTaskViaAgent", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	const rebaseTarget = params.compareRef || `origin/${baseBranch}`;
	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;

	const handedOff = await sendPromptToAgentPane(tmuxSession, socket, rebaseConflictAgentPrompt(rebaseTarget), task.sessionState?.panes);
	log.info("← rebaseTaskViaAgent", { taskId: task.id.slice(0, 8), handedOff });
	return { handedOff };
}

async function openPullRequest(params: { taskId: string; projectId: string }): Promise<void> {
	log.info("→ openPullRequest", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);

	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
	const scriptPath = `/tmp/dev3-${task.id}-git-openPR.sh`;
	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await killExistingGitPane(task.id, tmuxSession, socket);
	const githubEnvExports = await github.getGitHubShellExports(project);

	const script = [
		`#!/bin/bash`,
		...githubEnvExports,
		`set -x`,
		`gh pr view --web 2>&1`,
		`EXIT_CODE=$?`,
		`set +x`,
		`echo $EXIT_CODE > "${scriptPath}.exit"`,
		`echo ""`,
		`if [ $EXIT_CODE -eq 0 ]; then`,
		`  printf '\\033[1;32m✓ PR opened in browser\\033[0m\\n'`,
		`  sleep 5`,
		`else`,
		`  printf '\\033[1;31m✗ Failed to open PR (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
		`  echo "Press any key to close."`,
		`  read -n 1 -s`,
		`fi`,
	].join("\n") + "\n";
	await Bun.write(scriptPath, script);

	const paneId = await openGitOpPane(tmuxSession, task.worktreePath, scriptPath, socket);
	if (paneId) gitOpPaneIds.set(task.id, paneId);
	monitorGitPane(paneId, task.id, params.projectId, "openPR", socket);

	log.info("← openPullRequest (pane opened)", { paneId });
}

async function listBranches(params: { projectId: string }): Promise<Array<{ name: string; isRemote: boolean }>> {
	const project = await data.getProject(params.projectId);
	return git.listBranches(project.path);
}

async function fetchBranches(params: { projectId: string; forkRef?: string }): Promise<Array<{ name: string; isRemote: boolean }>> {
	const project = await data.getProject(params.projectId);
	if (params.forkRef) {
		const colonIdx = params.forkRef.indexOf(":");
		if (colonIdx > 0) {
			const forkOwner = params.forkRef.slice(0, colonIdx);
			const branchName = params.forkRef.slice(colonIdx + 1);
			if (forkOwner && branchName) {
				await git.fetchFork(project.path, forkOwner, branchName);
			}
		}
	} else {
		await git.fetchOrigin(project.path);
	}
	return git.listBranches(project.path);
}

const PULLABLE_BRANCHES = new Set(["main", "master"]);

// Background fetch pacing for the pull-button "behind origin" indicator.
// The renderer polls every ~15s; refreshing remote refs that often would
// reintroduce the network churn removed in PR #648, so fetch at most once
// per interval and let the cheap local rev-list pick up the result later.
const BEHIND_FETCH_INTERVAL_MS = 3 * 60_000;
const behindFetchLastAttempt = new Map<string, number>();

function maybeRefreshOriginRef(projectPath: string, branch: string): void {
	const now = Date.now();
	const last = behindFetchLastAttempt.get(projectPath) ?? 0;
	if (now - last < BEHIND_FETCH_INTERVAL_MS) return;
	behindFetchLastAttempt.set(projectPath, now);
	// Fire-and-forget: the next poll reads the updated origin/<branch> ref.
	void git.fetchOrigin(projectPath, branch).catch((err) => {
		log.debug("behind-indicator fetch failed (non-fatal)", { projectPath, branch, error: String(err) });
	});
}

async function getProjectCurrentBranch(params: { projectId: string }): Promise<{ branch: string | null; isBaseBranch: boolean; isDirty: boolean; behindOrigin: number }> {
	const project = await data.getProject(params.projectId);
	const [branch, isDirty] = await Promise.all([
		git.getCurrentBranch(project.path),
		git.isWorktreeDirty(project.path),
	]);
	const isBaseBranch = !branch || branch === project.defaultBaseBranch;

	let behindOrigin = 0;
	if (branch && PULLABLE_BRANCHES.has(branch)) {
		maybeRefreshOriginRef(project.path, branch);
		behindOrigin = await git.getBehindOriginCount(project.path, branch);
	}
	return { branch, isBaseBranch, isDirty, behindOrigin };
}

async function pullProjectMain(params: { projectId: string }): Promise<{
	ok: boolean;
	branch: string | null;
	output: string;
	error: string;
}> {
	log.info("→ pullProjectMain", params);
	const project = await data.getProject(params.projectId);
	const branch = await git.getCurrentBranch(project.path);

	if (!branch) {
		const error = "Detached HEAD — switch to a branch first";
		log.warn("pullProjectMain: detached HEAD", { projectId: params.projectId });
		return { ok: false, branch: null, output: "", error };
	}
	if (!PULLABLE_BRANCHES.has(branch)) {
		const error = `Refusing to pull on branch '${branch}' — only main or master is allowed from this button`;
		log.warn("pullProjectMain: branch not pullable", { projectId: params.projectId, branch });
		return { ok: false, branch, output: "", error };
	}

	const result = await git.pullOrigin(project.path, branch);
	log.info("← pullProjectMain", { branch, ok: result.ok });
	return {
		ok: result.ok,
		branch,
		output: result.stdout,
		error: result.stderr,
	};
}

async function getProjectPRs(params: { projectId: string }): Promise<PRInfo[]> {
	log.info("→ getProjectPRs", params);
	const project = await data.getProject(params.projectId);

	try {
		const result = await github.runGitHub(
			project,
			project.path,
			["pr", "list", "--state", "open", "--json", "number,headRefName,url", "--limit", "100"],
		);
		if (result.ok && result.stdout) {
			const prs = JSON.parse(result.stdout);
			if (Array.isArray(prs)) {
				const infos: PRInfo[] = [];
				for (const pr of prs) {
					if (typeof pr.number === "number" && typeof pr.headRefName === "string" && typeof pr.url === "string") {
						infos.push({ number: pr.number, url: pr.url, headRefName: pr.headRefName });
					}
				}
				await persistProjectPrIdentities(project, infos);
				log.info("← getProjectPRs", { count: infos.length });
				return infos;
			}
		}
	} catch (err) {
		log.warn("getProjectPRs failed (non-fatal)", { error: String(err) });
	}

	return [];
}

interface ResolvePrUrlResult {
	ok: boolean;
	branch: string | null;
	number: number | null;
	title: string | null;
	isFork: boolean;
	error: string | null;
}

// Resolve a GitHub pull-request URL to a locally-fetched branch ref, ready to be
// used as a task's `existingBranch`. Same-repo PRs resolve to `origin/<head>`;
// cross-repo (fork) PRs are fetched via the fork-remote machinery and resolve to
// `<forkOwner>/<head>` — the exact ref shapes the branch selector already accepts.
async function resolvePrUrl(params: { projectId: string; url: string }): Promise<ResolvePrUrlResult> {
	const url = params.url.trim();
	log.info("→ resolvePrUrl", { projectId: params.projectId, url });
	const project = await data.getProject(params.projectId);

	try {
		const result = await github.runGitHub(
			project,
			project.path,
			["pr", "view", url, "--json", "number,title,headRefName,headRepositoryOwner,isCrossRepository"],
			{ timeoutMs: 20_000 },
		);
		if (!result.ok || !result.stdout) {
			const error = result.stderr.trim() || "Failed to resolve pull request";
			log.warn("resolvePrUrl: gh pr view failed", { url, error });
			return { ok: false, branch: null, number: null, title: null, isFork: false, error };
		}

		const pr = JSON.parse(result.stdout) as {
			number?: number;
			title?: string;
			headRefName?: string;
			headRepositoryOwner?: { login?: string } | null;
			isCrossRepository?: boolean;
		};
		const headRefName = typeof pr.headRefName === "string" ? pr.headRefName : "";
		const number = typeof pr.number === "number" ? pr.number : null;
		const title = typeof pr.title === "string" ? pr.title : null;
		if (!headRefName) {
			return { ok: false, branch: null, number, title, isFork: false, error: "Pull request has no head branch" };
		}

		const forkOwner = pr.isCrossRepository ? pr.headRepositoryOwner?.login : undefined;
		if (forkOwner) {
			const fetched = await git.fetchFork(project.path, forkOwner, headRefName);
			if (!fetched) {
				log.warn("resolvePrUrl: fork fetch failed", { url, forkOwner, headRefName });
				return { ok: false, branch: null, number, title, isFork: true, error: `Could not fetch ${headRefName} from fork ${forkOwner}` };
			}
			log.info("← resolvePrUrl (fork)", { number, branch: `${forkOwner}/${headRefName}` });
			return { ok: true, branch: `${forkOwner}/${headRefName}`, number, title, isFork: true, error: null };
		}

		await git.fetchOrigin(project.path, headRefName);
		log.info("← resolvePrUrl (origin)", { number, branch: `origin/${headRefName}` });
		return { ok: true, branch: `origin/${headRefName}`, number, title, isFork: false, error: null };
	} catch (err) {
		log.warn("resolvePrUrl failed", { url, error: String(err) });
		return { ok: false, branch: null, number: null, title: null, isFork: false, error: String(err) };
	}
}

/**
 * "Send later" — queue a scheduled message on a task's live agent. Thin RPC
 * wrapper over the scheduler core (validation + cap + broadcast live there).
 */
async function scheduleMessage(params: {
	taskId: string;
	projectId: string;
	at: string;
	text: string;
	target: ScheduledMessageTarget;
}): Promise<Task> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	return scheduleMessageCore(project, task, { text: params.text, at: params.at, target: params.target });
}

/** Cancel one pending scheduled message (chip → "Cancel"). */
async function cancelScheduledMessage(params: { taskId: string; projectId: string; messageId: string }): Promise<Task> {
	const project = await data.getProject(params.projectId);
	return cancelScheduledMessageCore(project, params.taskId, params.messageId);
}

/** Deliver a pending scheduled message immediately and remove it (chip → "Send now"). */
async function sendScheduledMessageNow(params: { taskId: string; projectId: string; messageId: string }): Promise<Task> {
	const project = await data.getProject(params.projectId);
	return sendScheduledMessageNowCore(project, params.taskId, params.messageId);
}

export const gitOperationHandlers = {
	getBranchStatus,
	refreshTaskPrStatus,
	getTaskDiff,
	prepareMergeCompletionPrompt,
	dismissMergeCompletionPrompt,
	rebaseTask,
	rebaseTaskViaAgent,
	mergeTask,
	pushTask,
	createPullRequest,
	openPullRequest,
	listBranches,
	fetchBranches,
	resolvePrUrl,
	getProjectCurrentBranch,
	getProjectPRs,
	pullProjectMain,
	scheduleMessage,
	cancelScheduledMessage,
	sendScheduledMessageNow,
};
