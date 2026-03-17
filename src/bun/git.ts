import type { Project, Task } from "../shared/types";
export { extractRepoName } from "../shared/types";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createLogger } from "./logger";
import { spawn } from "./spawn";
import { DEV3_HOME } from "./paths";

const log = createLogger("git");

export async function run(
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

// Validates that a string is a safe git ref (SHA, branch name, origin/xxx).
// Rejects shell metacharacters to prevent injection when used in bash -c.
const GIT_REF_RE = /^[a-zA-Z0-9_\/.@{}\-^~]+$/;
function assertSafeRef(value: string, label: string): void {
	if (!GIT_REF_RE.test(value)) {
		throw new Error(`Unsafe git ref (${label}): ${value}`);
	}
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

	// Strategy 1: symbolic-ref (works after clone when origin/HEAD is set)
	const result = await run(
		["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
		path,
	);
	if (result.ok) {
		const branch = result.stdout.replace("refs/remotes/origin/", "");
		log.info(`Default branch: ${branch}`, { path });
		return branch;
	}

	// Strategy 2: auto-set origin/HEAD from the remote (requires network)
	const setHead = await run(
		["git", "remote", "set-head", "origin", "--auto"],
		path,
	);
	if (setHead.ok) {
		const retry = await run(
			["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
			path,
		);
		if (retry.ok) {
			const branch = retry.stdout.replace("refs/remotes/origin/", "");
			log.info(`Default branch (auto-detected): ${branch}`, { path });
			return branch;
		}
	}

	// Strategy 3: check remote tracking branches
	const remoteBranches = await run(
		["git", "branch", "-r", "--format=%(refname:short)"],
		path,
	);
	if (remoteBranches.ok && remoteBranches.stdout) {
		const branches = remoteBranches.stdout.split("\n").map((b) => b.trim());
		if (branches.includes("origin/main")) {
			log.info("Default branch (remote fallback): main", { path });
			return "main";
		}
		if (branches.includes("origin/master")) {
			log.info("Default branch (remote fallback): master", { path });
			return "master";
		}
	}

	// Strategy 4: check local branches
	const mainCheck = await run(
		["git", "rev-parse", "--verify", "main"],
		path,
	);
	if (mainCheck.ok) {
		log.info("Default branch (local fallback): main", { path });
		return "main";
	}

	const masterCheck = await run(
		["git", "rev-parse", "--verify", "master"],
		path,
	);
	if (masterCheck.ok) {
		log.info("Default branch (local fallback): master", { path });
		return "master";
	}

	// Strategy 5: use whatever local branch exists
	const localBranches = await run(
		["git", "branch", "--format=%(refname:short)"],
		path,
	);
	if (localBranches.ok && localBranches.stdout.trim()) {
		const first = localBranches.stdout.trim().split("\n")[0].trim();
		if (first) {
			log.info(`Default branch (first local branch): ${first}`, { path });
			return first;
		}
	}

	// No branches at all (empty repo with no commits)
	log.warn("No branches found in repository", { path });
	throw new Error("No branches found in repository. Make at least one commit before adding the project.");
}

export function shortId(taskId: string): string {
	return taskId.slice(0, 8);
}

export function projectSlug(projectPath: string): string {
	// /Users/arsenyp/Desktop/my-repo → Users-arsenyp-Desktop-my-repo
	return projectPath.replace(/^\//, "").replaceAll("/", "-");
}

export function taskDir(project: Project, task: Task): string {
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
	existingBranch?: string,
	variantBranchName?: string,
): Promise<{ worktreePath: string; branchName: string }> {
	const wtPath = worktreePath(project, task);
	const tDir = taskDir(project, task);

	// Create the task container directory (with logs/ subfolder)
	const mkdirProc = spawn(["mkdir", "-p", `${tDir}/logs`]);
	await mkdirProc.exited;

	if (existingBranch && variantBranchName) {
		// Multi-variant mode: create a new branch from the existing branch's HEAD
		const resolvedBase = existingBranch.startsWith("origin/") ? existingBranch : existingBranch;
		log.info("Creating variant worktree from existing branch", {
			wtPath, variantBranchName, base: resolvedBase, taskId: task.id,
		});

		const result = await run(
			["git", "worktree", "add", "-b", variantBranchName, wtPath, resolvedBase],
			project.path,
		);

		if (!result.ok) {
			log.error("Failed to create variant worktree", { stderr: result.stderr, taskId: task.id });
			throw new Error(`Failed to create worktree: ${result.stderr}`);
		}

		log.info("Variant worktree created", { wtPath, branch: variantBranchName });
		return { worktreePath: wtPath, branchName: variantBranchName };
	}

	if (existingBranch) {
		// Check if this is a remote tracking ref (origin/xxx, yanive/xxx, etc.)
		const isRemoteRef = (await run(
			["git", "rev-parse", "--verify", `refs/remotes/${existingBranch}`],
			project.path,
		)).ok;

		// For remote refs, extract local branch name by stripping the remote prefix
		const resolvedBranch = isRemoteRef
			? existingBranch.slice(existingBranch.indexOf("/") + 1)
			: existingBranch;

		log.info("Creating worktree from existing branch", {
			wtPath, existingBranch, resolvedBranch, isRemoteRef, taskId: task.id,
		});

		const result = await run(
			["git", "worktree", "add", wtPath, resolvedBranch],
			project.path,
		);

		if (!result.ok) {
			const isAlreadyCheckedOut = result.stderr.includes("already checked out") || result.stderr.includes("already used by worktree");

			if (isRemoteRef && !isAlreadyCheckedOut) {
				// Remote branch without a local tracking branch yet — create one
				log.info("Retrying with tracking branch creation", { existingBranch });
				const trackResult = await run(
					["git", "worktree", "add", "--track", "-b", resolvedBranch, wtPath, existingBranch],
					project.path,
				);
				if (!trackResult.ok) {
					log.error("Failed to create worktree from existing branch", { stderr: trackResult.stderr, taskId: task.id });
					throw new Error(`Failed to create worktree: ${trackResult.stderr}`);
				}
				log.info("Worktree created from existing branch (tracking)", { wtPath, branch: resolvedBranch });
				return { worktreePath: wtPath, branchName: resolvedBranch };
			}

			if (isAlreadyCheckedOut) {
				// Branch is checked out in another worktree — create a new task branch based on it
				const taskBranch = branchName(task);
				log.info("Branch already checked out, creating task branch based on it", {
					existingBranch: resolvedBranch, taskBranch, taskId: task.id,
				});
				const fallbackResult = await run(
					["git", "worktree", "add", "-b", taskBranch, wtPath, resolvedBranch],
					project.path,
				);
				if (!fallbackResult.ok) {
					log.error("Failed to create worktree from existing branch (fallback)", { stderr: fallbackResult.stderr, taskId: task.id });
					throw new Error(`Failed to create worktree: ${fallbackResult.stderr}`);
				}
				// Set up remote tracking so `git push` targets the original remote branch
				const remoteRef = isRemoteRef ? existingBranch : `origin/${resolvedBranch}`;
				const remoteCheckResult = await run(
					["git", "rev-parse", "--verify", remoteRef],
					project.path,
				);
				if (remoteCheckResult.ok) {
					await run(
						["git", "branch", "--set-upstream-to", remoteRef],
						wtPath,
					);
					log.info("Set remote tracking branch for fallback task branch", { taskBranch, remoteRef });
				}
				log.info("Worktree created with task branch based on existing", { wtPath, branch: taskBranch, base: resolvedBranch });
				return { worktreePath: wtPath, branchName: taskBranch };
			}

			log.error("Failed to create worktree from existing branch", { stderr: result.stderr, taskId: task.id });
			throw new Error(`Failed to create worktree: ${result.stderr}`);
		}

		log.info("Worktree created from existing branch", { wtPath, branch: resolvedBranch });
		return { worktreePath: wtPath, branchName: resolvedBranch };
	}

	// Default: create a new branch
	const branch = branchName(task);
	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";

	// Fetch origin so the worktree starts from the latest remote commit,
	// not a potentially stale local branch.
	const fetched = await fetchOrigin(project.path);
	const remoteBase = `origin/${baseBranch}`;
	const refCheckResult = fetched
		? await run(["git", "rev-parse", "--verify", remoteBase], project.path)
		: { ok: false };
	const resolvedBase = refCheckResult.ok ? remoteBase : baseBranch;

	// Verify the resolved base actually exists before attempting worktree creation
	if (!refCheckResult.ok) {
		const localCheck = await run(["git", "rev-parse", "--verify", baseBranch], project.path);
		if (!localCheck.ok) {
			log.error("Base branch does not exist", { baseBranch, taskId: task.id });
			throw new Error(
				`Branch "${baseBranch}" does not exist locally or on the remote. ` +
				`Check your project's base branch setting, or make sure the branch exists.`,
			);
		}
	}

	log.info("Creating worktree", { wtPath, branch, baseBranch, resolvedBase, taskId: task.id, taskDir: tDir });

	const result = await run(
		["git", "worktree", "add", "-b", branch, wtPath, resolvedBase],
		project.path,
	);

	if (!result.ok) {
		log.error("Failed to create worktree", { stderr: result.stderr, taskId: task.id });
		throw new Error(`Failed to create worktree: ${result.stderr}`);
	}

	log.info("Worktree created", { wtPath, branch });

	return { worktreePath: wtPath, branchName: branch };
}

export interface BranchInfo {
	name: string;
	isRemote: boolean;
}

export async function listBranches(projectPath: string): Promise<BranchInfo[]> {
	const [localResult, remoteResult] = await Promise.all([
		run(["git", "branch", "--format=%(refname:short)"], projectPath),
		run(["git", "branch", "-r", "--format=%(refname:short)"], projectPath),
	]);

	const branches: BranchInfo[] = [];

	if (localResult.ok && localResult.stdout) {
		for (const name of localResult.stdout.split("\n")) {
			if (name) branches.push({ name, isRemote: false });
		}
	}

	if (remoteResult.ok && remoteResult.stdout) {
		for (const name of remoteResult.stdout.split("\n")) {
			if (name && !name.endsWith("/HEAD")) {
				branches.push({ name, isRemote: true });
			}
		}
	}

	return branches;
}

async function refExists(projectPath: string, ref: string): Promise<boolean> {
	const result = await run(["git", "rev-parse", "--verify", ref], projectPath);
	return result.ok;
}

function parseRecentCommitters(shortlogOutput: string): Set<string> {
	const emails = new Set<string>();

	for (const line of shortlogOutput.split("\n")) {
		const match = line.match(/<([^>]+)>/);
		if (!match) continue;
		emails.add(match[1].trim().toLowerCase());
	}

	return emails;
}

export async function detectDefaultCompareRef(
	projectPath: string,
	baseBranch: string,
): Promise<string> {
	const remoteResult = await run(["git", "remote"], projectPath);
	const hasOriginRemote = remoteResult.ok && remoteResult.stdout
		.split("\n")
		.map((remote) => remote.trim())
		.includes("origin");
	const remoteBaseRef = `origin/${baseBranch}`;
	const remoteBaseExists = hasOriginRemote && await refExists(projectPath, remoteBaseRef);
	let localBaseExists = await refExists(projectPath, baseBranch);
	if (baseBranch === "main" || baseBranch === "master") {
		if (remoteBaseExists) {
			if (localBaseExists) {
				await run(["git", "branch", "--set-upstream-to", remoteBaseRef, baseBranch], projectPath);
			} else {
				await run(["git", "branch", "--track", baseBranch, remoteBaseRef], projectPath);
				localBaseExists = true;
			}
		}
	}
	const historyRef = remoteBaseExists ? remoteBaseRef : baseBranch;

	const shortlogResult = await run(
		["git", "shortlog", "-sne", "--since=2 weeks ago", historyRef],
		projectPath,
	);
	const recentCommitters = shortlogResult.ok
		? parseRecentCommitters(shortlogResult.stdout)
		: new Set<string>();

	if (recentCommitters.size <= 1) {
		if (localBaseExists) return baseBranch;
		if (remoteBaseExists) return remoteBaseRef;
		return baseBranch;
	}

	if (remoteBaseExists) {
		return remoteBaseRef;
	}

	if (hasOriginRemote) {
		for (const branchName of ["main", "master"]) {
			const remoteRef = `origin/${branchName}`;
			if (await refExists(projectPath, remoteRef)) return remoteRef;
		}
	}

	if (localBaseExists) return baseBranch;
	return baseBranch;
}

export async function getCurrentBranch(worktreePath: string): Promise<string | null> {
	const result = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
	if (!result.ok || result.stdout === "HEAD") return null; // detached HEAD
	return result.stdout;
}

// Per-project fetch deduplication: reuse in-flight fetch promises and enforce
// a cooldown to prevent lock contention when multiple callers (polling, git
// operation completion, merge detection) trigger concurrent fetches.
const fetchInFlight = new Map<string, Promise<boolean>>();
const fetchLastSuccess = new Map<string, number>();
const FETCH_COOLDOWN_MS = 5_000;

export async function fetchOrigin(projectPath: string): Promise<boolean> {
	const now = Date.now();
	const lastSuccess = fetchLastSuccess.get(projectPath) ?? 0;

	// Skip if a successful fetch completed recently
	if (now - lastSuccess < FETCH_COOLDOWN_MS) {
		log.debug("fetchOrigin: skipping (cooldown)", { projectPath, msSinceLast: now - lastSuccess });
		return true;
	}

	// Reuse in-flight fetch for the same project
	const existing = fetchInFlight.get(projectPath);
	if (existing) {
		log.debug("fetchOrigin: reusing in-flight fetch", { projectPath });
		return existing;
	}

	const promise = (async () => {
		log.debug("Fetching origin", { projectPath });
		const result = await run(["git", "fetch", "origin", "--quiet"], projectPath);
		if (result.ok) {
			fetchLastSuccess.set(projectPath, Date.now());
		} else {
			log.warn("fetchOrigin failed", { projectPath, stderr: result.stderr });
		}
		return result.ok;
	})();

	fetchInFlight.set(projectPath, promise);
	try {
		return await promise;
	} finally {
		fetchInFlight.delete(projectPath);
	}
}

export async function getOriginUrl(projectPath: string): Promise<string | null> {
	const result = await run(["git", "remote", "get-url", "origin"], projectPath);
	return result.ok ? result.stdout : null;
}

/**
 * Derive a fork URL from the origin URL by replacing the owner.
 * Supports both HTTPS and SSH formats:
 *   https://github.com/h0x91b/dev-3.0.git → https://github.com/yanive/dev-3.0.git
 *   git@github.com:h0x91b/dev-3.0.git → git@github.com:yanive/dev-3.0.git
 */
export function deriveForkUrl(originUrl: string, forkOwner: string): string | null {
	// HTTPS: https://github.com/OWNER/REPO.git
	const httpsMatch = originUrl.match(/^(https?:\/\/[^/]+\/)([^/]+)(\/[^/]+)$/);
	if (httpsMatch) {
		return `${httpsMatch[1]}${forkOwner}${httpsMatch[3]}`;
	}
	// SSH: git@github.com:OWNER/REPO.git
	const sshMatch = originUrl.match(/^([^@]+@[^:]+:)([^/]+)(\/[^/]+)$/);
	if (sshMatch) {
		return `${sshMatch[1]}${forkOwner}${sshMatch[3]}`;
	}
	return null;
}

/**
 * Add a fork remote and fetch a specific branch from it.
 * Returns true if the branch was successfully fetched.
 */
export async function fetchFork(
	projectPath: string,
	forkOwner: string,
	branchName: string,
): Promise<boolean> {
	const originUrl = await getOriginUrl(projectPath);
	if (!originUrl) {
		log.warn("fetchFork: could not determine origin URL", { projectPath });
		return false;
	}

	const forkUrl = deriveForkUrl(originUrl, forkOwner);
	if (!forkUrl) {
		log.warn("fetchFork: could not derive fork URL", { originUrl, forkOwner });
		return false;
	}

	// Check if remote already exists
	const remoteCheck = await run(["git", "remote", "get-url", forkOwner], projectPath);
	if (!remoteCheck.ok) {
		// Add the remote
		log.info("Adding fork remote", { forkOwner, forkUrl });
		const addResult = await run(["git", "remote", "add", forkOwner, forkUrl], projectPath);
		if (!addResult.ok) {
			log.error("Failed to add fork remote", { stderr: addResult.stderr });
			return false;
		}
	}

	// Fetch the specific branch
	log.info("Fetching fork branch", { forkOwner, branchName });
	const fetchResult = await run(
		["git", "fetch", forkOwner, branchName, "--quiet"],
		projectPath,
	);
	if (!fetchResult.ok) {
		log.warn("fetchFork: failed to fetch branch", { forkOwner, branchName, stderr: fetchResult.stderr });
		return false;
	}

	return true;
}

/** Remove fetch cache for a specific project path (call on project deletion). */
export function removeFetchCache(projectPath: string): void {
	fetchInFlight.delete(projectPath);
	fetchLastSuccess.delete(projectPath);
}

/** Reset fetch dedup state — for tests only. */
export function _resetFetchState(): void {
	fetchInFlight.clear();
	fetchLastSuccess.clear();
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

	// Untracked files — count lines for text files only, skip binary
	const untrackedResult = await run(
		["git", "ls-files", "--others", "--exclude-standard"],
		worktreePath,
	);
	if (untrackedResult.ok && untrackedResult.stdout.trim()) {
		const files = untrackedResult.stdout.trim().split("\n");
		for (const file of files) {
			try {
				const bunFile = Bun.file(`${worktreePath}/${file}`);
				const size = bunFile.size;

				// Skip empty files and files larger than 1 MB (likely binary or generated)
				if (size === 0 || size > 1_048_576) continue;

				// Read the file once for both binary detection and line counting
				const content = await bunFile.text();

				// Detect binary: check first 8 KB for null bytes
				const checkLen = Math.min(content.length, 8192);
				let isBinary = false;
				for (let i = 0; i < checkLen; i++) {
					if (content.charCodeAt(i) === 0) { isBinary = true; break; }
				}
				if (isBinary) continue;

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

export async function getBranchDiffStats(
	worktreePath: string,
	ref: string,
): Promise<{ files: number; insertions: number; deletions: number; fileNames: string[] }> {
	const [statResult, namesResult] = await Promise.all([
		run(["git", "diff", "--shortstat", `${ref}...HEAD`], worktreePath),
		run(["git", "diff", "--name-only", `${ref}...HEAD`], worktreePath),
	]);
	if (!statResult.ok || !statResult.stdout.trim()) {
		return { files: 0, insertions: 0, deletions: 0, fileNames: [] };
	}
	// Output like: " 3 files changed, 45 insertions(+), 12 deletions(-)"
	const text = statResult.stdout.trim();
	const filesMatch = text.match(/(\d+)\s+file/);
	const insMatch = text.match(/(\d+)\s+insertion/);
	const delMatch = text.match(/(\d+)\s+deletion/);
	const fileNames = namesResult.ok && namesResult.stdout.trim()
		? namesResult.stdout.trim().split("\n")
		: [];
	return {
		files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
		insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
		deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
		fileNames,
	};
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
	//
	// IMPORTANT: We pipe git log -p directly into git patch-id via Bun
	// subprocess piping to avoid reading multi-MB patch output into JS memory.
	const mergeBaseResult = await run(["git", "merge-base", ref, "HEAD"], worktreePath);
	if (!mergeBaseResult.ok) return false;
	const mergeBase = mergeBaseResult.stdout;

	// Check if there are any task changes at all (lightweight --stat check)
	const taskStatResult = await run(["git", "diff", "--shortstat", mergeBase, "HEAD"], worktreePath);
	if (!taskStatResult.ok || !taskStatResult.stdout) return true; // no task changes

	// Validate refs before use — mergeBase is a SHA from git merge-base,
	// ref is origin/<baseBranch> from project config. Guard against injection
	// for the one bash -c call below.
	assertSafeRef(mergeBase, "mergeBase");
	assertSafeRef(ref, "ref");

	const [combinedPatchIdResult, taskPatchIdsResult, mainPatchIdsResult] = await Promise.all([
		// Combined diff as a single patch-id (for squash merge detection).
		// We prepend a fake commit header so git patch-id can parse it.
		run(
			["bash", "-c", `{ echo "commit ${"0".repeat(40)}"; echo; git diff "${mergeBase}" HEAD; } | git patch-id --stable`],
			worktreePath,
		),
		// Per-commit patch-ids from the task branch (capped to prevent unbounded memory)
		run(
			["bash", "-c", `git log -p --no-merges --max-count=500 "${mergeBase}..HEAD" | git patch-id --stable`],
			worktreePath,
		),
		// Per-commit patch-ids from the base branch (capped to prevent unbounded memory)
		run(
			["bash", "-c", `git log -p --no-merges --max-count=500 "${mergeBase}..${ref}" | git patch-id --stable`],
			worktreePath,
		),
	]);

	if (!mainPatchIdsResult.ok || !mainPatchIdsResult.stdout) return false;

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

	// Strategy 3: GitHub PR status check.
	// When both local strategies fail (main diverged before AND after the squash
	// on the same files), ask GitHub directly if a merged PR exists for this branch.
	// This is the definitive source of truth for GitHub-hosted repos.
	const branchResult = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
	if (branchResult.ok && branchResult.stdout) {
		const ghResult = await run(
			["gh", "pr", "list", "--head", branchResult.stdout, "--state", "merged", "--json", "number", "--limit", "1"],
			worktreePath,
		);
		if (ghResult.ok && ghResult.stdout) {
			try {
				const prs = JSON.parse(ghResult.stdout);
				if (Array.isArray(prs) && prs.length > 0) {
					log.info("isContentMergedInto", { ref, method: "github-pr", pr: prs[0].number, merged: true });
					return true;
				}
			} catch { /* ignore parse errors */ }
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

const MAX_DIFF_SNAPSHOTS = 50;
const MAX_DIFF_SIZE_BYTES = 1_000_000; // 1 MB

export async function saveDiffSnapshot(
	project: Project,
	task: Task,
	ref: string,
): Promise<void> {
	const dir = `${taskDir(project, task)}/diffs`;
	mkdirSync(dir, { recursive: true });

	// Pre-check: use --stat to estimate diff size before buffering the full diff.
	// The shortstat line reports total insertions+deletions; if that exceeds our
	// byte limit (assuming ~80 chars per line), skip the expensive full diff.
	const statResult = await run(
		["git", "diff", "--no-ext-diff", "--shortstat", `${ref}...HEAD`],
		task.worktreePath!,
	);
	if (!statResult.ok || !statResult.stdout.trim()) {
		log.debug("saveDiffSnapshot: no diff (shortstat empty), skipping");
		return;
	}
	const lineMatch = statResult.stdout.match(/(\d+) insertion|\d+ deletion/g);
	const estimatedLines = lineMatch
		? lineMatch.reduce((sum, m) => sum + Number(m.match(/\d+/)?.[0] ?? 0), 0)
		: 0;
	const estimatedBytes = estimatedLines * 80;
	if (estimatedBytes > MAX_DIFF_SIZE_BYTES) {
		log.info("saveDiffSnapshot: estimated diff too large, skipping", { estimatedLines, estimatedBytes });
		return;
	}

	// Get full diff (text only — skip binary content to avoid memory bloat)
	const result = await run(["git", "diff", "--no-ext-diff", `${ref}...HEAD`], task.worktreePath!);
	const diff = result.ok ? result.stdout : "";

	// Skip if empty (no changes)
	if (!diff.trim()) {
		log.debug("saveDiffSnapshot: no diff, skipping");
		return;
	}

	// Final size check (the estimate above is a heuristic — verify the actual size)
	if (Buffer.byteLength(diff, "utf-8") > MAX_DIFF_SIZE_BYTES) {
		log.info("saveDiffSnapshot: diff too large, skipping", { bytes: Buffer.byteLength(diff, "utf-8") });
		return;
	}

	// Check if identical to the latest snapshot
	const existing = readdirSync(dir).filter((f) => f.endsWith(".patch")).sort();
	if (existing.length > 0) {
		const lastFile = `${dir}/${existing[existing.length - 1]}`;
		try {
			const lastContent = readFileSync(lastFile, "utf-8");
			if (lastContent === diff) {
				log.debug("saveDiffSnapshot: unchanged, skipping");
				return;
			}
		} catch { /* file read error — proceed with saving */ }
	}

	// Save with timestamp
	const now = new Date();
	const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const filename = `${ts}.patch`;
	writeFileSync(`${dir}/${filename}`, diff);
	log.info("saveDiffSnapshot: saved", { file: filename, size: diff.length });

	// Prune old snapshots beyond the limit
	const allFiles = readdirSync(dir).filter((f) => f.endsWith(".patch")).sort();
	if (allFiles.length > MAX_DIFF_SNAPSHOTS) {
		const toRemove = allFiles.slice(0, allFiles.length - MAX_DIFF_SNAPSHOTS);
		for (const f of toRemove) {
			unlinkSync(`${dir}/${f}`);
		}
		log.info("saveDiffSnapshot: pruned old snapshots", { removed: toRemove.length });
	}
}

export async function applySparseCheckout(
	worktreePath: string,
	paths: string[],
): Promise<void> {
	log.info("Applying sparse checkout", { worktreePath, paths });
	const initResult = await run(
		["git", "sparse-checkout", "init", "--cone"],
		worktreePath,
	);
	if (!initResult.ok) {
		log.error("sparse-checkout init failed", { stderr: initResult.stderr });
		throw new Error(`Failed to init sparse checkout: ${initResult.stderr}`);
	}
	const setResult = await run(
		["git", "sparse-checkout", "set", ...paths],
		worktreePath,
	);
	if (!setResult.ok) {
		log.error("sparse-checkout set failed", { stderr: setResult.stderr });
		throw new Error(`Failed to set sparse checkout paths: ${setResult.stderr}`);
	}
	log.info("Sparse checkout applied", { worktreePath, pathCount: paths.length });
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
		// Delete branches that dev3 created. We check task.branchName (the original name
		// assigned at worktree creation) rather than the live branch name, because agents
		// may rename branches to conventional prefixes (feat/, fix/, etc.).
		// A task.branchName starting with "dev3/task-" means dev3 created it.
		const isDevBranch = task.branchName?.startsWith("dev3/task-") || branchToDelete.startsWith("dev3/");
		const isVariantBranch = task.existingBranch && branchToDelete !== task.existingBranch.replace(/^origin\//, "")
			&& branchToDelete.startsWith(task.existingBranch.replace(/^origin\//, ""));
		if (isDevBranch || isVariantBranch) {
			log.info("Deleting branch", { branch: branchToDelete });
			await run(
				["git", "branch", "-D", branchToDelete],
				project.path,
			);
		} else {
			log.info("Preserving user branch", { branch: branchToDelete });
		}
	}
}
