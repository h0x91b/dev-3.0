import { chmodSync } from "node:fs";
import type { BranchStatus, DiffToolId, PRInfo } from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import * as pty from "../pty-server";
import { loadSettings } from "../settings";
import { spawn } from "../spawn";
import { BUILT_IN_DIFF_TOOLS, getPushMessage, log } from "./shared";

const gitOpPaneIds = new Map<string, string>();
const mergeNotifiedTasks = new Set<string>();
const branchStatusInFlight = new Map<string, Promise<BranchStatus>>();
const prPromotedTasks = new Set<string>();

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

function buildDiffCommand(toolId: DiffToolId, customCommand: string | undefined, localPath: string, remotePath: string): string {
	if (toolId === "custom" && customCommand) {
		return customCommand
			.replace(/\$LOCAL/g, `"${localPath}"`)
			.replace(/\$REMOTE/g, `"${remotePath}"`);
	}
	const tool = BUILT_IN_DIFF_TOOLS.find((item) => item.id === toolId);
	if (!tool) throw new Error(`Unknown diff tool: ${toolId}`);
	return `${tool.extcmd} "${localPath}" "${remotePath}"`;
}

let mergePollerInterval: ReturnType<typeof setInterval> | null = null;

export function startMergeDetectionPoller(): void {
	stopMergeDetectionPoller();
	const POLL_INTERVAL = 5 * 60_000;

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

	if (mergeNotifiedTasks.size > 0 || prPromotedTasks.size > 0) {
		const allTaskIds = new Set<string>();
		for (const project of projects) {
			const tasks = await data.loadTasks(project);
			for (const task of tasks) allTaskIds.add(task.id);
		}
		for (const id of mergeNotifiedTasks) {
			if (!allTaskIds.has(id)) mergeNotifiedTasks.delete(id);
		}
		for (const id of prPromotedTasks) {
			if (!allTaskIds.has(id)) prPromotedTasks.delete(id);
		}
	}

	for (const project of projects) {
		const tasks = await data.loadTasks(project);
		const reviewTasks = tasks.filter(
			(task) => (task.status === "review-by-user" || task.status === "review-by-colleague") && task.worktreePath && !mergeNotifiedTasks.has(task.id),
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

				const merged = await git.isContentMergedInto(task.worktreePath!, ref);
				if (!merged) continue;

				mergeNotifiedTasks.add(task.id);
				log.info("Branch merge detected", { taskId: task.id.slice(0, 8), branch: branchName });
				pushMessage("branchMerged", {
					taskId: task.id,
					projectId: project.id,
					taskTitle: task.customTitle || task.title,
					branchName,
				});
			} catch (err) {
				log.warn("Merge check failed for task", { taskId: task.id.slice(0, 8), error: String(err) });
			}
		}
	}
}

export function clearMergeNotification(taskId: string): void {
	mergeNotifiedTasks.delete(taskId);
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

				const ghResult = await git.run(
					["gh", "pr", "list", "--head", branchName, "--state", "open", "--json", "number,isDraft", "--limit", "1"],
					task.worktreePath!,
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
	mergeNotifiedTasks.delete(taskId);
	prPromotedTasks.delete(taskId);
	branchStatusInFlight.delete(taskId);
}

async function getBranchStatusImpl(params: { taskId: string; projectId: string; compareRef?: string }): Promise<BranchStatus> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	if (!task.worktreePath) {
		return { ahead: 0, behind: 0, canRebase: false, insertions: 0, deletions: 0, unpushed: 0, mergedByContent: false, diffFiles: 0, diffInsertions: 0, diffDeletions: 0, diffFileNames: [], prNumber: null, prUrl: null };
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
			const ghResult = await git.run(
				["gh", "pr", "list", "--head", branchForPush, "--state", "open", "--json", "number,url", "--limit", "1"],
				task.worktreePath!,
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
	const mergedByContent = status.ahead > 0 ? await git.isContentMergedInto(task.worktreePath, ref) : false;

	const result = {
		...status, canRebase, ...uncommitted, unpushed, mergedByContent,
		diffFiles: branchDiff.files, diffInsertions: branchDiff.insertions, diffDeletions: branchDiff.deletions, diffFileNames: branchDiff.fileNames,
		prNumber, prUrl,
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
	const status = await git.getBranchStatus(task.worktreePath, `origin/${baseBranch}`);
	if (status.behind > 0) throw new Error("Branch is not rebased — rebase first");

	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
	const scriptPath = `/tmp/dev3-${task.id}-git-merge.sh`;
	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await killExistingGitPane(task.id, tmuxSession, socket);

	const escapedPath = project.path.replace(/'/g, "'\\''");
	const escapedTitle = task.title.replace(/'/g, "'\\''");

	const script = [
		`#!/bin/bash`,
		`cd '${escapedPath}'`,
		`echo "Squash-merging ${branchForMerge} into $(git branch --show-current)..."`,
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

	const script = [
		`#!/bin/bash`,
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

	const script = [
		`#!/bin/bash`,
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

async function showDiff(params: { taskId: string; projectId: string; compareRef?: string }): Promise<void> {
	log.info("→ showDiff", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	if (!task.worktreePath) throw new Error("Task has no worktree");

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	const ref = params.compareRef || `origin/${baseBranch}`;
	await git.fetchOrigin(project.path);

	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
	const scriptPath = `/tmp/dev3-${task.id}-git-diff.sh`;
	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await killExistingGitPane(task.id, tmuxSession, socket);

	const script = [
		`#!/bin/bash`,
		`git diff --color=always ${ref}...HEAD | less -R`,
		`EXIT_CODE=\${PIPESTATUS[0]}`,
		`if [ $EXIT_CODE -ne 0 ] && [ $EXIT_CODE -ne 141 ]; then`,
		`  printf '\\033[1;31m✗ git diff failed (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
		`  echo "Press any key to close."`,
		`  read -n 1 -s`,
		`fi`,
	].join("\n") + "\n";
	await Bun.write(scriptPath, script);

	const proc = spawn(pty.tmuxArgs(socket,
		"split-window", "-h",
		"-t", tmuxSession,
		"-c", task.worktreePath,
		"-P", "-F", "#{pane_id}",
		`bash "${scriptPath}"`,
	), { stdout: "pipe", stderr: "pipe" });
	const output = await new Response(proc.stdout).text();
	const stderrOutput = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (stderrOutput.trim()) {
		log.warn("showDiff tmux stderr", { stderr: stderrOutput.trim() });
	}
	if (exitCode !== 0) {
		throw new Error(`tmux split-window failed (exit ${exitCode}): ${stderrOutput.trim() || "unknown error"}`);
	}

	const paneId = output.trim() || null;
	if (paneId) gitOpPaneIds.set(task.id, paneId);
	log.info("← showDiff (pane opened)", { paneId });
}

async function showUncommittedDiff(params: { taskId: string; projectId: string }): Promise<void> {
	log.info("→ showUncommittedDiff", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	if (!task.worktreePath) throw new Error("Task has no worktree");

	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
	const scriptPath = `/tmp/dev3-${task.id}-git-uncommitted-diff.sh`;
	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await killExistingGitPane(task.id, tmuxSession, socket);

	const script = [
		`#!/bin/bash`,
		`{ git diff --color=always --stat && echo "" && git diff --color=always; git diff --cached --color=always --stat && echo "" && git diff --cached --color=always; } | less -R`,
		`EXIT_CODE=\${PIPESTATUS[0]}`,
		`if [ $EXIT_CODE -ne 0 ] && [ $EXIT_CODE -ne 141 ]; then`,
		`  printf '\\033[1;31m✗ git diff failed (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
		`  echo "Press any key to close."`,
		`  read -n 1 -s`,
		`fi`,
	].join("\n") + "\n";
	await Bun.write(scriptPath, script);

	const proc = spawn(pty.tmuxArgs(socket,
		"split-window", "-h",
		"-t", tmuxSession,
		"-c", task.worktreePath,
		"-P", "-F", "#{pane_id}",
		`bash "${scriptPath}"`,
	), { stdout: "pipe", stderr: "pipe" });
	const output = await new Response(proc.stdout).text();
	const stderrOutput = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (stderrOutput.trim()) {
		log.warn("showUncommittedDiff tmux stderr", { stderr: stderrOutput.trim() });
	}
	if (exitCode !== 0) {
		throw new Error(`tmux split-window failed (exit ${exitCode}): ${stderrOutput.trim() || "unknown error"}`);
	}

	const paneId = output.trim() || null;
	if (paneId) gitOpPaneIds.set(task.id, paneId);
	log.info("← showUncommittedDiff (pane opened)", { paneId });
}

async function openFileDiff(params: { taskId: string; projectId: string; relativePath: string; ref?: string }): Promise<void> {
	log.info("→ openFileDiff", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (!task.worktreePath) throw new Error("Task has no worktree");

	const settings = await loadSettings();
	const diffToolId = settings.diffTool ?? "git-terminal";
	if (diffToolId === "git-terminal") {
		throw new Error("No external diff tool configured");
	}
	if (diffToolId === "custom" && !settings.customDiffCommand) {
		throw new Error("Custom diff command is not configured");
	}

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	const ref = params.ref || `origin/${baseBranch}`;
	const safeRelPath = params.relativePath.replace(/'/g, "'\\''");
	const tmpDir = `/tmp/dev3-${task.id}-filediff`;
	const tmpFile = `${tmpDir}/${params.relativePath.replace(/\//g, "__")}`;
	const safeTmpFile = tmpFile.replace(/'/g, "'\\''");
	const remotePath = `${task.worktreePath}/${params.relativePath}`;

	const script = [
		"#!/bin/bash",
		`mkdir -p "${tmpDir}"`,
		`rm -f '${safeTmpFile}'`,
		`cd "${task.worktreePath}"`,
		`git show '${ref}:${safeRelPath}' > '${safeTmpFile}' 2>/dev/null || touch '${safeTmpFile}'`,
		`chmod 444 '${safeTmpFile}'`,
		buildDiffCommand(diffToolId, settings.customDiffCommand, tmpFile, remotePath),
	].join("\n") + "\n";

	const scriptPath = `/tmp/dev3-${task.id}-filediff.sh`;
	await Bun.write(scriptPath, script);
	chmodSync(scriptPath, 0o755);

	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await killExistingGitPane(task.id, tmuxSession, socket);

	const proc = spawn(pty.tmuxArgs(socket,
		"split-window", "-h",
		"-t", tmuxSession,
		"-c", task.worktreePath,
		"-P", "-F", "#{pane_id}",
		`bash "${scriptPath}"`,
	), { stdout: "pipe", stderr: "pipe" });
	const output = await new Response(proc.stdout).text();
	const stderrOutput = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (stderrOutput.trim()) {
		log.warn("openFileDiff tmux stderr", { stderr: stderrOutput.trim() });
	}
	if (exitCode !== 0) {
		throw new Error(`tmux split-window failed (exit ${exitCode}): ${stderrOutput.trim() || "unknown error"}`);
	}

	const paneId = output.trim() || null;
	if (paneId) gitOpPaneIds.set(task.id, paneId);
	log.info("← openFileDiff (pane opened)", { paneId, file: params.relativePath, tool: diffToolId });
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

async function getProjectCurrentBranch(params: { projectId: string }): Promise<{ branch: string | null; isBaseBranch: boolean }> {
	const project = await data.getProject(params.projectId);
	const branch = await git.getCurrentBranch(project.path);
	const isBaseBranch = !branch || branch === project.defaultBaseBranch;
	return { branch, isBaseBranch };
}

async function getProjectPRs(params: { projectId: string }): Promise<PRInfo[]> {
	log.info("→ getProjectPRs", params);
	const project = await data.getProject(params.projectId);

	try {
		const result = await git.run(
			["gh", "pr", "list", "--state", "open", "--json", "number,headRefName,url", "--limit", "100"],
			project.path,
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
	rebaseTask,
	mergeTask,
	pushTask,
	createPullRequest,
	openPullRequest,
	showDiff,
	showUncommittedDiff,
	openFileDiff,
	listBranches,
	fetchBranches,
	getProjectCurrentBranch,
	getProjectPRs,
};
