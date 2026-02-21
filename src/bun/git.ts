import type { Project, Task } from "../shared/types";

async function run(
	cmd: string[],
	cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
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
	return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function isGitRepo(path: string): Promise<boolean> {
	const result = await run(
		["git", "rev-parse", "--is-inside-work-tree"],
		path,
	);
	return result.ok && result.stdout === "true";
}

export async function getDefaultBranch(path: string): Promise<string> {
	const result = await run(
		["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
		path,
	);
	if (result.ok) {
		// "refs/remotes/origin/main" -> "main"
		return result.stdout.replace("refs/remotes/origin/", "");
	}
	// Fallback: check if main exists, else master
	const mainCheck = await run(
		["git", "rev-parse", "--verify", "main"],
		path,
	);
	return mainCheck.ok ? "main" : "master";
}

function shortId(taskId: string): string {
	return taskId.slice(0, 8);
}

function worktreePath(project: Project, task: Task): string {
	return `${project.path}/.dev3/worktrees/${shortId(task.id)}`;
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

	// Create the worktree directory parent
	const mkdirProc = Bun.spawn(["mkdir", "-p", `${project.path}/.dev3/worktrees`]);
	await mkdirProc.exited;

	const result = await run(
		["git", "worktree", "add", "-b", branch, wtPath, baseBranch],
		project.path,
	);

	if (!result.ok) {
		throw new Error(`Failed to create worktree: ${result.stderr}`);
	}

	// Run setup script if configured
	if (project.setupScript.trim()) {
		const setupProc = Bun.spawn(["bash", "-c", project.setupScript], {
			cwd: wtPath,
			stdout: "inherit",
			stderr: "inherit",
		});
		await setupProc.exited;
	}

	return { worktreePath: wtPath, branchName: branch };
}

export async function removeWorktree(
	project: Project,
	task: Task,
): Promise<void> {
	if (!task.worktreePath) return;

	await run(
		["git", "worktree", "remove", "--force", task.worktreePath],
		project.path,
	);

	if (task.branchName) {
		await run(
			["git", "branch", "-D", task.branchName],
			project.path,
		);
	}
}
