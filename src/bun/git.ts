import type { Project, Task } from "../shared/types";
export { extractRepoName } from "../shared/types";
import { createLogger } from "./logger";
import { spawn } from "./spawn";
import { DEV3_HOME } from "./paths";

const log = createLogger("git");

async function run(
	cmd: string[],
	cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	log.debug(`exec: ${cmd.join(" ")}`, { cwd });
	const proc = spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	const result = { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
	if (!result.ok) {
		log.warn(`Command failed (exit ${code}): ${cmd.join(" ")}`, {
			stderr: result.stderr,
		});
	}
	return result;
}

async function runWithInput(
	cmd: string[],
	cwd: string,
	input: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	log.debug(`exec (stdin): ${cmd.join(" ")}`, { cwd });
	const proc = spawn(cmd, {
		cwd,
		stdin: new Blob([input]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function isGitRepo(path: string): Promise<boolean> {
	log.info("Checking if git repo", { path });
	const result = await run(
		["git", "rev-parse", "--is-inside-work-tree"],
		path,
	);
	const isRepo = result.ok && result.stdout === "true";
	log.info(`isGitRepo=${isRepo}`, { path });
	return isRepo;
}

export async function getDefaultBranch(path: string): Promise<string> {
	log.info("Detecting default branch", { path });
	const result = await run(
		["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
		path,
	);
	if (result.ok) {
		const branch = result.stdout.replace("refs/remotes/origin/", "");
		log.info(`Default branch: ${branch}`, { path });
		return branch;
	}
	// Fallback: check if main exists, else master
	const mainCheck = await run(
		["git", "rev-parse", "--verify", "main"],
		path,
	);
	const branch = mainCheck.ok ? "main" : "master";
	log.info(`Default branch (fallback): ${branch}`, { path });
	return branch;
}

export function shortId(taskId: string): string {
	return taskId.slice(0, 8);
}

export function projectSlug(projectPath: string): string {
	// /Users/arsenyp/Desktop/my-repo → Users-arsenyp-Desktop-my-repo
	return projectPath.replace(/^\//, "").replaceAll("/", "-");
}

function taskDir(project: Project, task: Task): string {
	return `${DEV3_HOME}/worktrees/${projectSlug(project.path)}/${shortId(task.id)}`;
}

function worktreePath(project: Project, task: Task): string {
	return `${taskDir(project, task)}/worktree`;
}

function branchName(task: Task): string {
	return `dev3/task-${shortId(task.id)}`;
}

export async function createWorktree(
	project: Project,
	task: Task,
): Promise<{ worktreePath: string; branchName: string }> {
	const wtPath = worktreePath(project, task);
	const branch = branchName(task);
	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";

	const tDir = taskDir(project, task);

	log.info("Creating worktree", { wtPath, branch, baseBranch, taskId: task.id, taskDir: tDir });

	// Create the task container directory (with logs/ subfolder)
	const mkdirProc = spawn(["mkdir", "-p", `${tDir}/logs`]);
	await mkdirProc.exited;

	const result = await run(
		["git", "worktree", "add", "-b", branch, wtPath, baseBranch],
		project.path,
	);

	if (!result.ok) {
		log.error("Failed to create worktree", { stderr: result.stderr, taskId: task.id });
		throw new Error(`Failed to create worktree: ${result.stderr}`);
	}

	log.info("Worktree created", { wtPath, branch });

	return { worktreePath: wtPath, branchName: branch };
}

export async function getCurrentBranch(worktreePath: string): Promise<string | null> {
	const result = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
	if (!result.ok || result.stdout === "HEAD") return null; // detached HEAD
	return result.stdout;
}

export async function fetchOrigin(projectPath: string): Promise<void> {
	log.debug("Fetching origin", { projectPath });
	await run(["git", "fetch", "origin", "--quiet"], projectPath);
}

export async function getBranchStatus(
	worktreePath: string,
	baseBranch: string,
): Promise<{ ahead: number; behind: number }> {
	const result = await run(
		["git", "rev-list", "--count", "--left-right", `${baseBranch}...HEAD`],
		worktreePath,
	);
	if (!result.ok) {
		log.warn("getBranchStatus failed", { stderr: result.stderr });
		return { ahead: 0, behind: 0 };
	}
	// Output is "behind\tahead" (left = remote, right = local)
	const parts = result.stdout.split("\t");
	return {
		behind: parseInt(parts[0], 10) || 0,
		ahead: parseInt(parts[1], 10) || 0,
	};
}

export async function getUncommittedChanges(
	worktreePath: string,
): Promise<{ insertions: number; deletions: number }> {
	// Tracked file changes (staged + unstaged)
	const trackedResult = await run(
		["git", "diff", "--numstat", "HEAD"],
		worktreePath,
	);

	let insertions = 0;
	let deletions = 0;

	if (trackedResult.ok && trackedResult.stdout.trim()) {
		for (const line of trackedResult.stdout.trim().split("\n")) {
			const [ins, del] = line.split("\t");
			// Binary files show "-" instead of numbers
			if (ins !== "-") insertions += parseInt(ins, 10) || 0;
			if (del !== "-") deletions += parseInt(del, 10) || 0;
		}
	}

	// Untracked files — every line counts as an insertion
	const untrackedResult = await run(
		["git", "ls-files", "--others", "--exclude-standard"],
		worktreePath,
	);
	if (untrackedResult.ok && untrackedResult.stdout.trim()) {
		const files = untrackedResult.stdout.trim().split("\n");
		for (const file of files) {
			try {
				const content = await Bun.file(`${worktreePath}/${file}`).text();
				const lines = content.split("\n");
				// Don't count trailing empty line from final newline
				insertions += content.endsWith("\n") ? lines.length - 1 : lines.length;
			} catch {
				// File might have been deleted between listing and reading
			}
		}
	}

	return { insertions, deletions };
}

export async function isContentMergedInto(
	worktreePath: string,
	ref: string,
): Promise<boolean> {
	// Strategy 1: merge-tree comparison.
	// Compute a hypothetical merge of ref and HEAD. If the resulting tree
	// matches ref's tree, all of HEAD's changes are already incorporated —
	// regardless of how they got there (squash, rebase, cherry-pick, etc.).
	// This handles cases where main diverged BEFORE the squash merge with
	// overlapping changes to the same files (which breaks patch-id matching).
	const [mergeTreeResult, refTreeResult] = await Promise.all([
		run(["git", "merge-tree", "--write-tree", ref, "HEAD"], worktreePath),
		run(["git", "rev-parse", `${ref}^{tree}`], worktreePath),
	]);

	if (mergeTreeResult.ok && refTreeResult.ok && mergeTreeResult.stdout === refTreeResult.stdout) {
		log.info("isContentMergedInto", { ref, method: "merge-tree", merged: true });
		return true;
	}

	// Strategy 2: patch-id comparison (fallback).
	// merge-tree can report conflicts when main has additional changes to the
	// same files AFTER the squash merge (add/add conflicts). In that case,
	// fall back to patch-id matching which handles post-merge divergence well.
	const mergeBaseResult = await run(["git", "merge-base", ref, "HEAD"], worktreePath);
	if (!mergeBaseResult.ok) return false;
	const mergeBase = mergeBaseResult.stdout;

	const [taskDiffResult, taskLogResult, mainLogResult] = await Promise.all([
		run(["git", "diff", mergeBase, "HEAD"], worktreePath),
		run(["git", "log", "-p", "--no-merges", `${mergeBase}..HEAD`], worktreePath),
		run(["git", "log", "-p", "--no-merges", `${mergeBase}..${ref}`], worktreePath),
	]);

	if (!taskDiffResult.ok || !taskDiffResult.stdout) return true; // no task changes
	if (!mainLogResult.ok || !mainLogResult.stdout) return false;

	const fakeCommitDiff = `commit ${"0".repeat(40)}\n\n${taskDiffResult.stdout}`;
	const [combinedPatchIdResult, taskPatchIdsResult, mainPatchIdsResult] = await Promise.all([
		runWithInput(["git", "patch-id", "--stable"], worktreePath, fakeCommitDiff),
		runWithInput(["git", "patch-id", "--stable"], worktreePath, taskLogResult.stdout ?? ""),
		runWithInput(["git", "patch-id", "--stable"], worktreePath, mainLogResult.stdout),
	]);

	const mainPatchIds = new Set(
		mainPatchIdsResult.stdout
			.split("\n")
			.map((line) => line.split(" ")[0])
			.filter(Boolean),
	);

	const combinedPatchId = combinedPatchIdResult.stdout.split(" ")[0];
	const squashMerged = Boolean(combinedPatchId) && mainPatchIds.has(combinedPatchId);

	const taskIndividualPatchIds = taskPatchIdsResult.stdout
		.split("\n")
		.map((line) => line.split(" ")[0])
		.filter(Boolean);
	const rebaseMerged =
		taskIndividualPatchIds.length > 0 && taskIndividualPatchIds.every((id) => mainPatchIds.has(id));

	if (squashMerged || rebaseMerged) {
		log.info("isContentMergedInto", { ref, mergeBase, method: "patch-id", squashMerged, rebaseMerged, merged: true });
		return true;
	}

	// Strategy 3: new-files existence check.
	// When main diverged both BEFORE the squash (breaking patch-id) AND AFTER
	// with changes to the same files (breaking merge-tree), check if all files
	// CREATED by the task exist on ref. If the task introduced new files (e.g.
	// changelog, decision records) and they all exist on ref, the task content
	// was merged — ref just evolved further on the same modified files.
	const newFilesResult = await run(
		["git", "diff", "--diff-filter=A", "--name-only", mergeBase, "HEAD"],
		worktreePath,
	);

	if (newFilesResult.ok && newFilesResult.stdout) {
		const newFiles = newFilesResult.stdout.split("\n").filter(Boolean);
		if (newFiles.length > 0) {
			const checks = await Promise.all(
				newFiles.map((f) => run(["git", "cat-file", "-e", `${ref}:${f}`], worktreePath)),
			);
			const allExist = checks.every((c) => c.ok);
			if (allExist) {
				log.info("isContentMergedInto", { ref, mergeBase, method: "new-files", fileCount: newFiles.length, merged: true });
				return true;
			}
		}
	}

	log.info("isContentMergedInto", { ref, mergeBase, merged: false });
	return false;
}

export async function canRebaseCleanly(
	worktreePath: string,
	baseBranch: string,
): Promise<boolean> {
	const result = await run(
		["git", "merge-tree", "--write-tree", `${baseBranch}`, "HEAD"],
		worktreePath,
	);
	return result.ok;
}

export async function getUnpushedCount(
	worktreePath: string,
	branchName: string,
): Promise<number> {
	if (!branchName) return 0;

	// Check if the remote tracking branch exists
	const ref = await run(
		["git", "rev-parse", "--verify", `origin/${branchName}`],
		worktreePath,
	);
	if (!ref.ok) return -1; // sentinel: branch was never pushed

	// Count commits in HEAD but not in origin/<branchName>
	const result = await run(
		["git", "rev-list", "--count", `origin/${branchName}..HEAD`],
		worktreePath,
	);
	if (!result.ok) return 0;
	return parseInt(result.stdout, 10) || 0;
}

export async function cloneRepo(
	url: string,
	targetDir: string,
): Promise<{ ok: boolean; path: string; error?: string }> {
	log.info("Cloning repository", { url, targetDir });
	const result = await run(["git", "clone", url, targetDir], process.cwd());
	if (!result.ok) {
		log.error("Clone failed", { url, stderr: result.stderr });
		return { ok: false, path: targetDir, error: result.stderr };
	}
	log.info("Repository cloned successfully", { url, targetDir });
	return { ok: true, path: targetDir };
}

export async function removeWorktree(
	project: Project,
	task: Task,
): Promise<void> {
	if (!task.worktreePath) return;

	log.info("Removing worktree", { path: task.worktreePath, taskId: task.id });

	// Read live branch name before removing — it may differ from task.branchName
	// if the agent renamed the branch (e.g. `git branch -m dev3/task-xxx dev3/fix-login`).
	const liveBranch = await getCurrentBranch(task.worktreePath);
	const branchToDelete = liveBranch ?? task.branchName;

	await run(
		["git", "worktree", "remove", "--force", task.worktreePath],
		project.path,
	);

	if (branchToDelete) {
		log.info("Deleting branch", { branch: branchToDelete });
		await run(
			["git", "branch", "-D", branchToDelete],
			project.path,
		);
	}
}
