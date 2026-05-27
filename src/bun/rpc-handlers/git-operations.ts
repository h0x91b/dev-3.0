import {
	type BranchStatus,
	type MergeCompletionPromptState,
	type PRInfo,
	type Project,
	type Task,
	type TaskDiffMode,
	type TaskDiffResponse,
	MERGE_COMPLETE_ELIGIBLE_STATUSES,
} from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import * as github from "../github";
import * as pty from "../pty-server";
import { spawn } from "../spawn";
import { getPushMessage, log } from "./shared";

const gitOpPaneIds = new Map<string, string>();
const mergeNotifiedPromptKeys = new Set<string>();
const branchStatusInFlight = new Map<string, Promise<BranchStatus>>();
const prPromotedTasks = new Set<string>();
const MERGE_PROMPT_FALLBACK_SUPPRESS_MS = 60 * 60 * 1000;

interface MergeCompletionFingerprint {
	fingerprint: string;
	precise: boolean;
}

function mergePromptKey(taskId: string, fingerprint: string | null): string {
	return `${taskId}:${fingerprint || "unknown"}`;
}

function parseTime(value: string | null | undefined): number | null {
	if (!value) return null;
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : null;
}

function shouldSuppressMergePrompt(state: MergeCompletionPromptState | null | undefined, fingerprint: MergeCompletionFingerprint, nowMs: number): boolean {
	if (!state || state.fingerprint !== fingerprint.fingerprint) return false;
	if (fingerprint.precise && state.precise) return true;

	const lastPromptTime = Math.max(
		parseTime(state.promptedAt) ?? 0,
		parseTime(state.dismissedAt) ?? 0,
	);
	return lastPromptTime > 0 && nowMs - lastPromptTime < MERGE_PROMPT_FALLBACK_SUPPRESS_MS;
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

async function reserveMergeCompletionPrompt(project: Project, task: Task, fingerprint: MergeCompletionFingerprint, now = new Date()): Promise<boolean> {
	const promptKey = mergePromptKey(task.id, fingerprint.fingerprint);
	if (mergeNotifiedPromptKeys.has(promptKey)) return false;

	const nowMs = now.getTime();
	if (shouldSuppressMergePrompt(task.mergeCompletionPrompt, fingerprint, nowMs)) {
		mergeNotifiedPromptKeys.add(promptKey);
		return false;
	}

	// Reserve the slot before awaiting so concurrent callers see the key immediately
	// and cannot both pass the has() check above.
	mergeNotifiedPromptKeys.add(promptKey);
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

async function prepareMergeCompletionPrompt(params: { taskId: string; projectId: string; fingerprint?: string | null }): Promise<{ shouldPrompt: boolean; fingerprint: string | null }> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const fingerprint = params.fingerprint
		? { fingerprint: params.fingerprint, precise: params.fingerprint.startsWith("v1:") }
		: await getMergeCompletionFingerprint(task, task.branchName);
	const shouldPrompt = await reserveMergeCompletionPrompt(project, task, fingerprint);
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
	const POLL_INTERVAL = 60_000;

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

	if (mergeNotifiedPromptKeys.size > 0 || prPromotedTasks.size > 0) {
		const allTaskIds = new Set<string>();
		for (const project of projects) {
			const tasks = await data.loadTasks(project);
			for (const task of tasks) allTaskIds.add(task.id);
		}
		for (const key of mergeNotifiedPromptKeys) {
			const taskId = key.slice(0, key.indexOf(":"));
			if (!allTaskIds.has(taskId)) mergeNotifiedPromptKeys.delete(key);
		}
		for (const id of prPromotedTasks) {
			if (!allTaskIds.has(id)) prPromotedTasks.delete(id);
		}
	}

	for (const project of projects) {
		const tasks = await data.loadTasks(project);
		const reviewTasks = tasks.filter(
			(task) => MERGE_COMPLETE_ELIGIBLE_STATUSES.includes(task.status) && task.worktreePath,
		);

		if (reviewTasks.length === 0) continue;

		try {
			await git.fetchOrigin(project.path);
		} catch {
			continue;
		}

		for (const task of reviewTasks) {
			try {
				const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
				const ref = `origin/${baseBranch}`;

				const branchName = await git.getCurrentBranch(task.worktreePath!);
				if (!branchName) continue;
				const hasRemote = await git.getUnpushedCount(task.worktreePath!, branchName);
				if (hasRemote === -1) continue;

				const merged = await git.isContentMergedInto(task.worktreePath!, ref, project);
				if (!merged) continue;

				const fingerprint = await getMergeCompletionFingerprint(task, branchName);
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
			}
		}
	}
}

export function clearMergeNotification(taskId: string): void {
	for (const key of mergeNotifiedPromptKeys) {
		if (key.startsWith(`${taskId}:`)) mergeNotifiedPromptKeys.delete(key);
	}
}

export function _resetMergePollerState(): void {
	mergeNotifiedPromptKeys.clear();
}

let prPollerInterval: ReturnType<typeof setInterval> | null = null;

export function startPRDetectionPoller(): void {
	stopPRDetectionPoller();
	const POLL_INTERVAL = 5 * 60_000;

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
}

export async function checkOpenPRsForPromotion(): Promise<void> {
	const pushMessage = getPushMessage();
	if (!pushMessage) return;

	if (prPromotedTasks.size > 500) {
		log.warn("prPromotedTasks exceeded 500 entries, clearing", { size: prPromotedTasks.size });
		prPromotedTasks.clear();
	}

	const projects = await data.loadProjects();
	for (const project of projects) {
		if (project.peerReviewEnabled === false) continue;

		const tasks = await data.loadTasks(project);
		const candidates = tasks.filter(
			(task) => task.status === "review-by-user" && task.worktreePath && !prPromotedTasks.has(task.id),
		);

		if (candidates.length === 0) continue;

		for (const task of candidates) {
			try {
				const branchName = await git.getCurrentBranch(task.worktreePath!);
				if (!branchName) continue;

				const unpushed = await git.getUnpushedCount(task.worktreePath!, branchName);
				if (unpushed === -1) continue;

				const ghResult = await github.runGitHub(
					project,
					task.worktreePath!,
					["pr", "list", "--head", branchName, "--state", "open", "--json", "number,isDraft", "--limit", "1"],
				);
				if (!ghResult.ok || !ghResult.stdout) continue;

				let prs: Array<{ number: number; isDraft: boolean }>;
				try {
					prs = JSON.parse(ghResult.stdout);
				} catch {
					continue;
				}

				const hasOpenNonDraftPR = Array.isArray(prs) && prs.length > 0 && !prs[0].isDraft;
				if (!hasOpenNonDraftPR) continue;

				prPromotedTasks.add(task.id);
				log.info("Open PR detected — promoting to review-by-colleague", {
					taskId: task.id.slice(0, 8),
					branch: branchName,
					pr: prs[0].number,
				});

				const updated = await data.updateTask(project, task.id, { status: "review-by-colleague" });
				pushMessage("taskUpdated", { projectId: project.id, task: updated });
			} catch (err) {
				log.warn("PR check failed for task", { taskId: task.id.slice(0, 8), error: String(err) });
			}
		}
	}
}

export function cleanupTaskGitState(taskId: string): void {
	gitOpPaneIds.delete(taskId);
	clearMergeNotification(taskId);
	prPromotedTasks.delete(taskId);
	branchStatusInFlight.delete(taskId);
}

async function getBranchStatusImpl(params: { taskId: string; projectId: string; compareRef?: string }): Promise<BranchStatus> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	if (!task.worktreePath) {
		return { ahead: 0, behind: 0, canRebase: false, insertions: 0, deletions: 0, unpushed: 0, mergedByContent: false, diffFiles: 0, diffInsertions: 0, diffDeletions: 0, diffFileStats: [], prNumber: null, prUrl: null, mergeCompletionFingerprint: null };
	}

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	const liveBranch = await git.getCurrentBranch(task.worktreePath);
	const branchForPush = liveBranch ?? task.branchName ?? "";

	if (liveBranch && liveBranch !== task.branchName) {
		log.info("getBranchStatus: branch renamed, syncing stored name", { old: task.branchName, new: liveBranch });
		await data.updateTask(project, task.id, { branchName: liveBranch });
	}

	log.info("getBranchStatus: fetching origin", { worktreePath: task.worktreePath, baseBranch, branchName: branchForPush });
	await git.fetchOrigin(project.path);
	const ref = params.compareRef || `origin/${baseBranch}`;
	const prDetection: Promise<{ number: number; url: string } | null> = (async () => {
		try {
			const ghResult = await github.runGitHub(
				project,
				task.worktreePath!,
				["pr", "list", "--head", branchForPush, "--state", "open", "--json", "number,url", "--limit", "1"],
			);
			if (ghResult.ok && ghResult.stdout) {
				const prs = JSON.parse(ghResult.stdout);
				if (Array.isArray(prs) && prs.length > 0 && typeof prs[0].number === "number") {
					return { number: prs[0].number, url: typeof prs[0].url === "string" ? prs[0].url : "" };
				}
			}
		} catch (err) {
			log.warn("PR detection failed (non-fatal)", { error: String(err) });
		}
		return null;
	})();

	const [status, uncommitted, unpushed, branchDiff, prInfo] = await Promise.all([
		git.getBranchStatus(task.worktreePath, ref),
		git.getUncommittedChanges(task.worktreePath),
		git.getUnpushedCount(task.worktreePath, branchForPush),
		git.getBranchDiffStats(task.worktreePath, ref),
		prDetection,
	]);
	const prNumber = prInfo?.number ?? null;
	const prUrl = prInfo?.url ?? null;
	log.info("getBranchStatus: raw results", { status, uncommitted, unpushed, branchDiff, prNumber, prUrl, ref });
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
	log.info("← getBranchStatus", result);

	git.saveDiffSnapshot(project, task, ref).catch((err) => {
		log.warn("saveDiffSnapshot failed", { taskId: task.id, error: String(err) });
	});

	return result;
}

async function getBranchStatus(params: { taskId: string; projectId: string; compareRef?: string }) {
	log.info("→ getBranchStatus", params);
	const dedupKey = `${params.taskId}:${params.compareRef ?? ""}`;
	const existing = branchStatusInFlight.get(dedupKey);
	if (existing) {
		log.debug("getBranchStatus: reusing in-flight request", { taskId: params.taskId });
		return existing;
	}

	const promise = getBranchStatusImpl(params);
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
}): Promise<TaskDiffResponse> {
	log.info("→ getTaskDiff", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	if (!task.worktreePath) {
		throw new Error("Task has no worktree");
	}

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	if (params.mode !== "uncommitted") {
		await git.fetchOrigin(project.path);
	}

	const result = await git.getTaskDiff(task.worktreePath, params.mode, {
		baseBranch,
		compareRef: params.compareRef,
		compareLabel: params.compareLabel,
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

	if (!task.worktreePath) throw new Error("Task has no worktree");

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	const rebaseTarget = params.compareRef || `origin/${baseBranch}`;
	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
	const scriptPath = `/tmp/dev3-${task.id}-git-rebase.sh`;
	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await killExistingGitPane(task.id, tmuxSession, socket);

	const script = [
		`#!/bin/bash`,
		`echo "Fetching origin..."`,
		`git fetch origin --quiet`,
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

	if (!task.worktreePath) throw new Error("Task has no worktree");

	const liveBranch = await git.getCurrentBranch(task.worktreePath);
	const branchForMerge = liveBranch ?? task.branchName;
	if (!branchForMerge) throw new Error("Task has no branch");

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	await git.fetchOrigin(project.path);
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

	if (!task.worktreePath) throw new Error("Task has no worktree");

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

async function createPullRequest(params: { taskId: string; projectId: string }): Promise<void> {
	log.info("→ createPullRequest", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	if (!task.worktreePath) throw new Error("Task has no worktree");

	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
	const scriptPath = `/tmp/dev3-${task.id}-git-createPR.sh`;
	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await killExistingGitPane(task.id, tmuxSession, socket);

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	const githubEnvExports = await github.getGitHubShellExports(project);

	const script = [
		`#!/bin/bash`,
		...githubEnvExports,
		`set -x`,
		`gh pr create --base "${baseBranch}" --fill --web 2>&1`,
		`EXIT_CODE=$?`,
		`set +x`,
		`if [ $EXIT_CODE -ne 0 ]; then`,
		`  echo ""`,
		`  printf '\\033[1;33m⚠ PR may already exist — trying to open it...\\033[0m\\n'`,
		`  set -x`,
		`  gh pr view --web 2>&1`,
		`  EXIT_CODE=$?`,
		`  set +x`,
		`fi`,
		`echo $EXIT_CODE > "${scriptPath}.exit"`,
		`echo ""`,
		`if [ $EXIT_CODE -eq 0 ]; then`,
		`  printf '\\033[1;32m✓ PR opened in browser\\033[0m\\n'`,
		`  sleep 5`,
		`else`,
		`  printf '\\033[1;31m✗ Failed to create or open PR (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
		`  echo "Press any key to close."`,
		`  read -n 1 -s`,
		`fi`,
	].join("\n") + "\n";
	await Bun.write(scriptPath, script);

	const paneId = await openGitOpPane(tmuxSession, task.worktreePath, scriptPath, socket);
	if (paneId) gitOpPaneIds.set(task.id, paneId);
	monitorGitPane(paneId, task.id, params.projectId, "createPR", socket);

	log.info("← createPullRequest (pane opened)", { paneId });
}

async function openPullRequest(params: { taskId: string; projectId: string }): Promise<void> {
	log.info("→ openPullRequest", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	if (!task.worktreePath) throw new Error("Task has no worktree");

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

async function getProjectCurrentBranch(params: { projectId: string }): Promise<{ branch: string | null; isBaseBranch: boolean; isDirty: boolean }> {
	const project = await data.getProject(params.projectId);
	const [branch, isDirty] = await Promise.all([
		git.getCurrentBranch(project.path),
		git.isWorktreeDirty(project.path),
	]);
	const isBaseBranch = !branch || branch === project.defaultBaseBranch;
	return { branch, isBaseBranch, isDirty };
}

const PULLABLE_BRANCHES = new Set(["main", "master"]);

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
				log.info("← getProjectPRs", { count: infos.length });
				return infos;
			}
		}
	} catch (err) {
		log.warn("getProjectPRs failed (non-fatal)", { error: String(err) });
	}

	return [];
}

export const gitOperationHandlers = {
	getBranchStatus,
	getTaskDiff,
	prepareMergeCompletionPrompt,
	dismissMergeCompletionPrompt,
	rebaseTask,
	mergeTask,
	pushTask,
	createPullRequest,
	openPullRequest,
	listBranches,
	fetchBranches,
	getProjectCurrentBranch,
	getProjectPRs,
	pullProjectMain,
};
