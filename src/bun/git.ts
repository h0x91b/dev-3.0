import type { Project, Task } from "../shared/types";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

const log = createLogger("git");

async function run(
	cmd: string[],
	cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	log.debug(`exec: ${cmd.join(" ")}`, { cwd });
	const proc = Bun.spawn(cmd, {
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

function shortId(taskId: string): string {
	return taskId.slice(0, 8);
}

function projectSlug(projectPath: string): string {
	// /Users/arsenyp/Desktop/my-repo → Users-arsenyp-Desktop-my-repo
	return projectPath.replace(/^\//, "").replaceAll("/", "-");
}

function worktreePath(project: Project, task: Task): string {
	return `${DEV3_HOME}/worktrees/${projectSlug(project.path)}/${shortId(task.id)}`;
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

	log.info("Creating worktree", { wtPath, branch, baseBranch, taskId: task.id });

	// Create the worktree directory parent
	const parentDir = `${DEV3_HOME}/worktrees/${projectSlug(project.path)}`;
	const mkdirProc = Bun.spawn(["mkdir", "-p", parentDir]);
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

export async function fetchOrigin(projectPath: string): Promise<void> {
	log.debug("Fetching origin", { projectPath });
	await run(["git", "fetch", "origin", "--quiet"], projectPath);
}

export async function getBranchStatus(
	worktreePath: string,
	baseBranch: string,
): Promise<{ ahead: number; behind: number }> {
	const result = await run(
		["git", "rev-list", "--count", "--left-right", `origin/${baseBranch}...HEAD`],
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

export async function canRebaseCleanly(
	worktreePath: string,
	baseBranch: string,
): Promise<boolean> {
	const result = await run(
		["git", "merge-tree", "--write-tree", `origin/${baseBranch}`, "HEAD"],
		worktreePath,
	);
	return result.ok;
}

export async function rebaseOnBase(
	worktreePath: string,
	baseBranch: string,
): Promise<{ ok: boolean; error?: string }> {
	const result = await run(
		["git", "rebase", `origin/${baseBranch}`],
		worktreePath,
	);
	if (result.ok) {
		return { ok: true };
	}
	// Abort the failed rebase to restore clean worktree
	await run(["git", "rebase", "--abort"], worktreePath);
	return { ok: false, error: result.stderr };
}

export async function removeWorktree(
	project: Project,
	task: Task,
): Promise<void> {
	if (!task.worktreePath) return;

	log.info("Removing worktree", { path: task.worktreePath, taskId: task.id });

	await run(
		["git", "worktree", "remove", "--force", task.worktreePath],
		project.path,
	);

	if (task.branchName) {
		log.info("Deleting branch", { branch: task.branchName });
		await run(
			["git", "branch", "-D", task.branchName],
			project.path,
		);
	}
}
