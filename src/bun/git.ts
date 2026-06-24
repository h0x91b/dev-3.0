import type { Project, Task, TaskDiffFile, TaskDiffFileStatus, TaskDiffMode, TaskDiffResponse, TaskDiffSkippedFile, TaskDiffSummary } from "../shared/types";
export { extractRepoName } from "../shared/types";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createLogger } from "./logger";
import { reportCurrentPreparationStage } from "./preparation-runtime";
import { spawn } from "./spawn";
import { DEV3_HOME } from "./paths";
import * as github from "./github";

const log = createLogger("git");
const MAX_INLINE_DIFF_FILE_BYTES = 250_000;
const MAX_BINARY_CHECK_BYTES = 8_192;

// Rename/copy detection at git's default similarity (50%). These flags must be
// passed explicitly and kept identical between the name-status listing
// (listDiffEntries) and the per-file stat listing (getNumstat):
//   - The default must be EXPLICIT because users may disable it globally via
//     `diff.renames=false`; without the flag a rename renders as a full
//     delete + add, making it look like the whole file changed.
//   - The threshold must be git's default (50%), not a stricter value. A high
//     threshold (e.g. 90%) splits a rename-with-edits into separate delete/add
//     entries, again showing the entire file as changed instead of the few
//     lines that actually differ.
const RENAME_DETECTION_ARGS = ["--find-renames", "--find-copies"] as const;

type ParsedNameStatusEntry = {
	status: TaskDiffFileStatus;
	oldPath: string | null;
	newPath: string | null;
	displayPath: string;
};

type TextReadResult =
	| { kind: "text"; content: string; size: number }
	| { kind: "binary"; size: number }
	| { kind: "large"; size: number }
	| { kind: "missing" }
	| { kind: "absent" };

type DiffContentSource =
	| { kind: "ref"; ref: string }
	| { kind: "worktree" };

function withGitFilenameEncoding(cmd: string[]): string[] {
	if (cmd[0] !== "git") {
		return cmd;
	}
	return ["git", "-c", "core.quotepath=false", ...cmd.slice(1)];
}

const PROCESS_CLEANUP_GRACE_MS = 1_000;

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((resolve) => {
				timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}

export async function run(
	cmd: string[],
	cwd: string,
	opts?: { timeoutMs?: number; env?: Record<string, string> },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const finalCmd = withGitFilenameEncoding(cmd);
	log.debug(`exec: ${finalCmd.join(" ")}`, { cwd });
	const proc = spawn(finalCmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: opts?.env,
	});
	// Start draining stdout/stderr immediately, BEFORE awaiting exit. Otherwise a
	// command whose output exceeds the OS pipe buffer (~64KB) blocks on write with
	// nobody reading — proc.exited never resolves and we deadlock (commands without
	// a timeout would hang forever).
	const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
	const stderrPromise = new Response(proc.stderr).text().catch(() => "");

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const outcome = opts?.timeoutMs
		? await Promise.race([
			proc.exited.then((code) => ({ code, timedOut: false as const })),
			new Promise<{ code: null; timedOut: true }>((resolve) => {
				timeoutId = setTimeout(() => resolve({ code: null, timedOut: true }), opts.timeoutMs);
			}),
		])
		: { code: await proc.exited, timedOut: false as const };
	if (timeoutId) clearTimeout(timeoutId);
	if (outcome.timedOut) {
		proc.kill();
		await settleWithin(proc.exited.catch(() => null), PROCESS_CLEANUP_GRACE_MS, null);
	}
	// On timeout the killed process closes its pipes, so the readers resolve with
	// whatever partial output arrived; bound the wait just in case.
	const [stdout, stderr] = outcome.timedOut
		? await Promise.all([
			settleWithin(stdoutPromise, PROCESS_CLEANUP_GRACE_MS, ""),
			settleWithin(stderrPromise, PROCESS_CLEANUP_GRACE_MS, ""),
		])
		: await Promise.all([stdoutPromise, stderrPromise]);
	const failure = outcome.timedOut ? `timed out after ${opts?.timeoutMs}ms` : stderr.trim();
	const result = { ok: outcome.code === 0, stdout: stdout.trim(), stderr: failure };
	if (!result.ok) {
		log.warn(`Command failed (exit ${outcome.code}): ${finalCmd.join(" ")}`, {
			stderr: result.stderr,
		});
	}
	return result;
}

async function measureGitStep<T>(
	step: string,
	meta: Record<string, unknown>,
	fn: () => Promise<T>,
): Promise<T> {
	const startedAt = performance.now();
	try {
		const result = await fn();
		log.info("Git step finished", {
			step,
			durationMs: Math.round(performance.now() - startedAt),
			...meta,
		});
		return result;
	} catch (err) {
		log.warn("Git step failed", {
			step,
			durationMs: Math.round(performance.now() - startedAt),
			error: String(err),
			...meta,
		});
		throw err;
	}
}

function isProbablyBinary(bytes: Uint8Array): boolean {
	const limit = Math.min(bytes.length, MAX_BINARY_CHECK_BYTES);
	for (let i = 0; i < limit; i++) {
		if (bytes[i] === 0) {
			return true;
		}
	}
	return false;
}

function parseShortStat(text: string): TaskDiffSummary {
	const trimmed = text.trim();
	const filesMatch = trimmed.match(/(\d+)\s+file/);
	const insertionsMatch = trimmed.match(/(\d+)\s+insertion/);
	const deletionsMatch = trimmed.match(/(\d+)\s+deletion/);
	return {
		files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
		insertions: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
		deletions: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0,
	};
}

function mapNameStatus(code: string): TaskDiffFileStatus {
	switch (code[0]) {
		case "A":
			return "added";
		case "M":
			return "modified";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		case "T":
			return "type-changed";
		default:
			return "unknown";
	}
}

function parseNameStatusZ(output: string): ParsedNameStatusEntry[] {
	if (!output) {
		return [];
	}

	const tokens = output.split("\0").filter((token) => token.length > 0);
	const entries: ParsedNameStatusEntry[] = [];

	for (let index = 0; index < tokens.length; index++) {
		const code = tokens[index];
		const status = mapNameStatus(code);
		if (status === "renamed" || status === "copied") {
			const oldPath = tokens[index + 1] ?? null;
			const newPath = tokens[index + 2] ?? null;
			if (oldPath && newPath) {
				entries.push({
					status,
					oldPath,
					newPath,
					displayPath: `${oldPath} -> ${newPath}`,
				});
			}
			index += 2;
			continue;
		}

		const path = tokens[index + 1] ?? null;
		if (!path) {
			continue;
		}

		entries.push({
			status,
			oldPath: status === "added" ? null : path,
			newPath: status === "deleted" ? null : path,
			displayPath: path,
		});
		index += 1;
	}

	return entries;
}

async function listDiffEntries(
	worktreePath: string,
	diffArgs: string[],
): Promise<ParsedNameStatusEntry[]> {
	const result = await run(
		[
			"git",
			"diff",
			"--name-status",
			"-z",
			...RENAME_DETECTION_ARGS,
			"--diff-filter=ACDMRT",
			...diffArgs,
		],
		worktreePath,
	);
	return result.ok ? parseNameStatusZ(result.stdout) : [];
}

async function listUntrackedEntries(worktreePath: string): Promise<ParsedNameStatusEntry[]> {
	const result = await run(
		["git", "ls-files", "--others", "--exclude-standard", "-z"],
		worktreePath,
	);
	if (!result.ok || !result.stdout) {
		return [];
	}

	return result.stdout
		.split("\0")
		.filter((path) => path.length > 0)
		.map((path) => ({
			status: "untracked" as const,
			oldPath: null,
			newPath: path,
			displayPath: path,
		}));
}

async function getDiffShortStat(
	worktreePath: string,
	diffArgs: string[],
): Promise<TaskDiffSummary> {
	const result = await run(
		["git", "diff", "--shortstat", ...RENAME_DETECTION_ARGS, ...diffArgs],
		worktreePath,
	);
	return result.ok && result.stdout ? parseShortStat(result.stdout) : { files: 0, insertions: 0, deletions: 0 };
}

// Runs a git command, feeding `stdin`, and returns raw stdout bytes. Used for
// the cat-file --batch protocol whose output is binary-safe (length-prefixed).
// stdin is a Blob so the test spawn mock (which only forwards Blob stdin) works.
async function runGitStdinBinary(
	cmd: string[],
	cwd: string,
	stdin: string,
): Promise<{ code: number; stdout: Uint8Array }> {
	const finalCmd = withGitFilenameEncoding(cmd);
	log.debug(`exec(stdin): ${finalCmd.join(" ")}`, { cwd });
	const proc = spawn(finalCmd, {
		cwd,
		stdin: new Blob([stdin]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdoutBuffer] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
	]);
	return { code: await proc.exited, stdout: new Uint8Array(stdoutBuffer) };
}

const BATCH_HEADER_RE = /^[0-9a-f]{40,64} blob (\d+)$/;

function indexOfNewline(bytes: Uint8Array, from: number): number {
	for (let i = from; i < bytes.length; i++) {
		if (bytes[i] === 0x0a) {
			return i;
		}
	}
	return -1;
}

// Reads many blobs at a single ref in two git invocations (cat-file
// --batch-check for sizes, then --batch for the content of under-limit blobs),
// instead of two processes per file (cat-file -s + git show). Returns a map
// keyed by the input file path.
async function readRefBlobsBatch(
	worktreePath: string,
	ref: string,
	paths: string[],
): Promise<Map<string, TextReadResult>> {
	const out = new Map<string, TextReadResult>();
	const unique = [...new Set(paths)];
	if (unique.length === 0) {
		return out;
	}

	// Phase 1: sizes + existence, without reading content.
	const checkInput = unique.map((p) => `${ref}:${p}\n`).join("");
	const check = await runGitStdinBinary(["git", "cat-file", "--batch-check"], worktreePath, checkInput);
	const checkLines = new TextDecoder().decode(check.stdout).split("\n");
	const underLimit: string[] = [];
	for (let i = 0; i < unique.length; i++) {
		const path = unique[i];
		const match = (checkLines[i] ?? "").match(BATCH_HEADER_RE);
		if (!match) {
			out.set(path, { kind: "missing" });
			continue;
		}
		const size = parseInt(match[1], 10);
		if (size > MAX_INLINE_DIFF_FILE_BYTES) {
			out.set(path, { kind: "large", size });
		} else {
			underLimit.push(path);
		}
	}
	if (underLimit.length === 0) {
		return out;
	}

	// Phase 2: content for under-limit blobs. --batch output is length-prefixed
	// ("<oid> blob <size>\n" + <size> bytes + "\n"), so we parse it positionally
	// and binary-safely against the input order.
	const batchInput = underLimit.map((p) => `${ref}:${p}\n`).join("");
	const batch = await runGitStdinBinary(["git", "cat-file", "--batch"], worktreePath, batchInput);
	const bytes = batch.stdout;
	let cursor = 0;
	for (const path of underLimit) {
		const nl = indexOfNewline(bytes, cursor);
		if (nl < 0) {
			out.set(path, { kind: "missing" });
			continue;
		}
		const header = new TextDecoder().decode(bytes.subarray(cursor, nl));
		const match = header.match(BATCH_HEADER_RE);
		if (!match) {
			// Missing object: "<input> missing" line, no content block follows.
			out.set(path, { kind: "missing" });
			cursor = nl + 1;
			continue;
		}
		const size = parseInt(match[1], 10);
		const start = nl + 1;
		const content = bytes.subarray(start, start + size);
		cursor = start + size + 1; // skip the trailing newline after content
		if (isProbablyBinary(content)) {
			out.set(path, { kind: "binary", size });
		} else {
			out.set(path, { kind: "text", content: new TextDecoder().decode(content), size });
		}
	}
	return out;
}

async function readWorktreeTextFile(
	worktreePath: string,
	filePath: string,
): Promise<TextReadResult> {
	try {
		const file = Bun.file(`${worktreePath}/${filePath}`);
		const fileSize = file.size;
		if (fileSize > MAX_INLINE_DIFF_FILE_BYTES) {
			return { kind: "large", size: fileSize };
		}
		const content = await file.text();
		const textSize = Buffer.byteLength(content, "utf-8");
		if (textSize > MAX_INLINE_DIFF_FILE_BYTES) {
			return { kind: "large", size: textSize };
		}
		if (content.includes("\0")) {
			return { kind: "binary", size: textSize };
		}
		return { kind: "text", content, size: textSize };
	} catch {
		return { kind: "missing" };
	}
}

function readSize(result: TextReadResult): number | null {
	switch (result.kind) {
		case "text":
		case "binary":
		case "large":
			return result.size;
		case "absent":
		case "missing":
			return null;
	}
}

function readTextContent(result: TextReadResult): string {
	return result.kind === "text" ? result.content : "";
}

function countLines(content: string): number {
	if (content === "") {
		return 0;
	}
	const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
	return normalized.split("\n").length;
}

type DiffStat = { insertions: number; deletions: number };

// Per-file added/removed line counts for the whole diff in one `git diff
// --numstat -z` call. Keyed by the file's new path (or old path for deletes),
// which matches how name-status entries are keyed. Renames use the -z layout
// "add\tdel\t\0<old>\0<new>"; binary files report "-\t-".
async function getNumstat(
	worktreePath: string,
	diffArgs: string[],
): Promise<Map<string, DiffStat>> {
	const stats = new Map<string, DiffStat>();
	const result = await run(
		[
			"git",
			"diff",
			"--numstat",
			"-z",
			...RENAME_DETECTION_ARGS,
			"--diff-filter=ACDMRT",
			...diffArgs,
		],
		worktreePath,
	);
	if (!result.ok || !result.stdout) {
		return stats;
	}

	const tokens = result.stdout.split("\0");
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (!token) {
			i += 1;
			continue;
		}
		const parts = token.split("\t");
		if (parts.length < 3) {
			i += 1;
			continue;
		}
		const insertions = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
		const deletions = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
		const path = parts.slice(2).join("\t");
		if (path === "") {
			// Rename/copy: empty path field, the following two tokens are old/new.
			const newPath = tokens[i + 2];
			if (newPath) {
				stats.set(newPath, { insertions, deletions });
			}
			i += 3;
		} else {
			stats.set(path, { insertions, deletions });
			i += 1;
		}
	}
	return stats;
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) {
				return;
			}
			results[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

const WORKTREE_READ_CONCURRENCY = 24;

// Resolves the content of every entry's two sides with a constant number of git
// processes: ref sides are batched through cat-file (one pair of processes per
// distinct ref), worktree sides are read from disk concurrently. Hunks are no
// longer computed here — the renderer derives them from old/new content via
// @git-diff-view's generateDiffFile, saving one `git diff` process per file.
async function buildTaskDiffFiles(
	worktreePath: string,
	entries: ParsedNameStatusEntry[],
	oldSource: DiffContentSource,
	newSource: DiffContentSource,
	stats: Map<string, DiffStat>,
): Promise<Pick<TaskDiffResponse, "files" | "skippedFiles">> {
	const files: TaskDiffFile[] = [];
	const skippedFiles: TaskDiffSkippedFile[] = [];

	const refReads = new Map<string, Map<string, TextReadResult>>();
	async function batchRef(ref: string, paths: (string | null)[]): Promise<void> {
		if (refReads.has(ref)) {
			return;
		}
		const wanted = paths.filter((p): p is string => p !== null);
		refReads.set(ref, await readRefBlobsBatch(worktreePath, ref, wanted));
	}

	if (oldSource.kind === "ref") {
		await batchRef(oldSource.ref, entries.map((e) => e.oldPath));
	}
	if (newSource.kind === "ref") {
		await batchRef(newSource.ref, entries.map((e) => e.newPath));
	}

	const worktreeReads = new Map<string, TextReadResult>();
	if (oldSource.kind === "worktree" || newSource.kind === "worktree") {
		const wtPaths = new Set<string>();
		for (const entry of entries) {
			if (oldSource.kind === "worktree" && entry.oldPath) wtPaths.add(entry.oldPath);
			if (newSource.kind === "worktree" && entry.newPath) wtPaths.add(entry.newPath);
		}
		const unique = [...wtPaths];
		const read = await mapWithConcurrency(unique, WORKTREE_READ_CONCURRENCY, (p) =>
			readWorktreeTextFile(worktreePath, p),
		);
		unique.forEach((p, idx) => worktreeReads.set(p, read[idx]));
	}

	function resolve(source: DiffContentSource, filePath: string | null): TextReadResult {
		if (!filePath) {
			return { kind: "absent" };
		}
		if (source.kind === "ref") {
			return refReads.get(source.ref)?.get(filePath) ?? { kind: "missing" };
		}
		return worktreeReads.get(filePath) ?? { kind: "missing" };
	}

	for (const entry of entries) {
		const oldContent = resolve(oldSource, entry.oldPath);
		const newContent = resolve(newSource, entry.newPath);

		const isBinary = oldContent.kind === "binary" || newContent.kind === "binary";
		const isLarge = oldContent.kind === "large" || newContent.kind === "large";

		if (isBinary || isLarge) {
			skippedFiles.push({
				id: entry.oldPath ?? entry.newPath ?? entry.displayPath,
				status: entry.status,
				reason: isBinary ? "binary" : "too-large",
				displayPath: entry.displayPath,
				oldPath: entry.oldPath,
				newPath: entry.newPath,
				oldSize: readSize(oldContent),
				newSize: readSize(newContent),
			});
			continue;
		}

		const newText = readTextContent(newContent);
		const statKey = entry.newPath ?? entry.oldPath ?? entry.displayPath;
		// Untracked files are absent from `git diff` numstat — every line is new.
		const stat = stats.get(statKey)
			?? (entry.status === "untracked"
				? { insertions: countLines(newText), deletions: 0 }
				: { insertions: 0, deletions: 0 });

		files.push({
			id: entry.oldPath ?? entry.newPath ?? entry.displayPath,
			status: entry.status,
			displayPath: entry.displayPath,
			oldPath: entry.oldPath,
			newPath: entry.newPath,
			oldContent: readTextContent(oldContent),
			newContent: newText,
			hunks: null,
			insertions: stat.insertions,
			deletions: stat.deletions,
		});
	}

	return { files, skippedFiles };
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

/**
 * Managed working dir for a task in a virtual ("Operations") project. Nests
 * directly under the project's synthetic `path` (`~/.dev3.0/ops/<slug>`), so it
 * does NOT re-apply projectSlug (that would double-munge). Used as the agent +
 * shell cwd when the operation has no user-chosen fixed folder.
 */
export function virtualWorkDir(project: Project, task: Task): string {
	return `${project.path}/${shortId(task.id)}/work`;
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
	await reportCurrentPreparationStage("creating-worktree");
	const startedAt = performance.now();
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

		const result = await measureGitStep(
			"createWorktree.variant.worktreeAdd",
			{ taskId: task.id.slice(0, 8), wtPath, variantBranchName, base: resolvedBase },
			() => run(
				["git", "worktree", "add", "-b", variantBranchName, wtPath, resolvedBase],
				project.path,
			),
		);

		if (!result.ok) {
			log.error("Failed to create variant worktree", { stderr: result.stderr, taskId: task.id });
			throw new Error(`Failed to create worktree: ${result.stderr}`);
		}

		log.info("Variant worktree created", {
			wtPath,
			branch: variantBranchName,
			durationMs: Math.round(performance.now() - startedAt),
		});
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

		const result = await measureGitStep(
			"createWorktree.existing.worktreeAdd",
			{ taskId: task.id.slice(0, 8), wtPath, resolvedBranch, isRemoteRef },
			() => run(
				["git", "worktree", "add", wtPath, resolvedBranch],
				project.path,
			),
		);

		if (!result.ok) {
			const isAlreadyCheckedOut = result.stderr.includes("already checked out") || result.stderr.includes("already used by worktree");

			if (isRemoteRef && !isAlreadyCheckedOut) {
				// Remote branch without a local tracking branch yet — create one
				log.info("Retrying with tracking branch creation", { existingBranch });
				const trackResult = await measureGitStep(
					"createWorktree.existing.trackRemoteBranch",
					{ taskId: task.id.slice(0, 8), wtPath, resolvedBranch, existingBranch },
					() => run(
						["git", "worktree", "add", "--track", "-b", resolvedBranch, wtPath, existingBranch],
						project.path,
					),
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
				const fallbackResult = await measureGitStep(
					"createWorktree.existing.fallbackBranch",
					{ taskId: task.id.slice(0, 8), wtPath, taskBranch, resolvedBranch },
					() => run(
						["git", "worktree", "add", "-b", taskBranch, wtPath, resolvedBranch],
						project.path,
					),
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
				log.info("Worktree created with task branch based on existing", {
					wtPath,
					branch: taskBranch,
					base: resolvedBranch,
					durationMs: Math.round(performance.now() - startedAt),
				});
				return { worktreePath: wtPath, branchName: taskBranch };
			}

			log.error("Failed to create worktree from existing branch", { stderr: result.stderr, taskId: task.id });
			throw new Error(`Failed to create worktree: ${result.stderr}`);
		}

		log.info("Worktree created from existing branch", {
			wtPath,
			branch: resolvedBranch,
			durationMs: Math.round(performance.now() - startedAt),
		});
		return { worktreePath: wtPath, branchName: resolvedBranch };
	}

	// Default: create a new branch
	const branch = branchName(task);
	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";

	// Fetch origin so the worktree starts from the latest remote commit,
	// not a potentially stale local branch.
	const fetched = await measureGitStep(
		"createWorktree.fetchOrigin",
		{ taskId: task.id.slice(0, 8), projectPath: project.path },
		() => fetchOrigin(project.path, baseBranch),
	);
	const remoteBase = `origin/${baseBranch}`;
	const refCheckResult = fetched
		? await run(["git", "rev-parse", "--verify", remoteBase], project.path)
		: { ok: false };
	const resolvedBase = refCheckResult.ok ? remoteBase : baseBranch;

	// Verify the resolved base actually exists before attempting worktree creation
	if (!refCheckResult.ok) {
		const localCheck = await run(["git", "rev-parse", "--verify", baseBranch], project.path);
		if (!localCheck.ok) {
			// An empty repository (no commits at all) needs a different fix —
			// create an initial commit — than a repo that simply lacks the
			// configured base branch (fix the base-branch setting). The generic
			// "branch does not exist" message misleads in the empty-repo case.
			const hasAnyCommit = (await run(["git", "rev-parse", "--verify", "HEAD"], project.path)).ok;
			if (!hasAnyCommit) {
				log.error("Repository has no commits", { baseBranch, taskId: task.id });
				throw new Error(
					`Repository has no commits yet, so there is no "${baseBranch}" branch to start from. ` +
					`Create an initial commit in the repository before starting a task.`,
				);
			}
			log.error("Base branch does not exist", { baseBranch, taskId: task.id });
			throw new Error(
				`Branch "${baseBranch}" does not exist locally or on the remote. ` +
				`Check your project's base branch setting, or make sure the branch exists.`,
			);
		}
	}

	log.info("Creating worktree", { wtPath, branch, baseBranch, resolvedBase, taskId: task.id, taskDir: tDir });

	// Proactively reclaim stale leftovers from a prior failed cleanup before
	// invoking `git worktree add`. Stderr-driven retries don't work here: the
	// first attempt creates the worktree directory as a side effect even when
	// it fails on the branch check, so a second attempt then trips on
	// "directory already exists". The branch and the worktree path are both
	// owned by dev3 (derived from task.id), so reclaiming them is safe.
	const dirExistsBeforeAdd = existsSync(wtPath);
	const branchExistsBeforeAdd = (await run(
		["git", "rev-parse", "--verify", `refs/heads/${branch}`],
		project.path,
	)).ok;

	if (dirExistsBeforeAdd || branchExistsBeforeAdd) {
		log.warn("Found stale leftovers from prior failed cleanup, reclaiming", {
			taskId: task.id.slice(0, 8),
			wtPath,
			branch,
			dirExists: dirExistsBeforeAdd,
			branchExists: branchExistsBeforeAdd,
		});

		if (dirExistsBeforeAdd) {
			// Try `git worktree remove` first (handles the case where the path
			// is still registered as a worktree); fall back to plain rmSync if
			// the directory remains.
			await run(["git", "worktree", "remove", "--force", wtPath], project.path);
			if (existsSync(wtPath)) {
				rmSync(wtPath, { recursive: true, force: true });
			}
			await run(["git", "worktree", "prune"], project.path);
		}

		if (branchExistsBeforeAdd) {
			await run(["git", "branch", "-D", branch], project.path);
		}
	}

	const result = await measureGitStep(
		"createWorktree.default.worktreeAdd",
		{ taskId: task.id.slice(0, 8), wtPath, branch, resolvedBase },
		() => run(
			["git", "worktree", "add", "-b", branch, wtPath, resolvedBase],
			project.path,
		),
	);

	if (!result.ok) {
		log.error("Failed to create worktree", { stderr: result.stderr, taskId: task.id });
		throw new Error(`Failed to create worktree: ${result.stderr}`);
	}

	log.info("Worktree created", {
		wtPath,
		branch,
		durationMs: Math.round(performance.now() - startedAt),
	});

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

// detectDefaultCompareRef runs `git shortlog` over two weeks of history — expensive
// on large repos. It is invoked by resolveProjectConfig, which the renderer polls
// every few seconds, so the result is cached with a TTL. The in-flight promise is
// cached too, coalescing concurrent callers.
const compareRefCache = new Map<string, { at: number; promise: Promise<string> }>();
const COMPARE_REF_CACHE_TTL_MS = 10 * 60_000;

/** Test-only: clear the detectDefaultCompareRef cache. */
export function _resetCompareRefCache(): void {
	compareRefCache.clear();
}

export async function detectDefaultCompareRef(
	projectPath: string,
	baseBranch: string,
): Promise<string> {
	const key = `${projectPath}\0${baseBranch}`;
	const cached = compareRefCache.get(key);
	if (cached && Date.now() - cached.at < COMPARE_REF_CACHE_TTL_MS) {
		return cached.promise;
	}
	const promise = detectDefaultCompareRefUncached(projectPath, baseBranch);
	compareRefCache.set(key, { at: Date.now(), promise });
	promise.catch(() => compareRefCache.delete(key));
	return promise;
}

async function detectDefaultCompareRefUncached(
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

export async function getHeadSha(worktreePath: string): Promise<string | null> {
	const result = await run(["git", "rev-parse", "HEAD"], worktreePath);
	if (!result.ok) return null;
	return result.stdout.trim() || null;
}

export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
	const result = await run(["git", "status", "--porcelain"], worktreePath);
	if (!result.ok) return false;
	return result.stdout.trim().length > 0;
}

// Per-project fetch deduplication: reuse in-flight fetch promises and enforce
// a cooldown to prevent lock contention when multiple callers (polling, git
// operation completion, merge detection) trigger concurrent fetches.
//
// fetchProjectQueue serializes the actual git subprocess per repo so that
// concurrent fetches for *different* branches don't race on .git/packed-refs.lock.
// Same-branch callers are coalesced by fetchInFlight before reaching the queue.
const fetchInFlight = new Map<string, Promise<boolean>>();
const fetchLastSuccess = new Map<string, number>();
const fetchProjectQueue = new Map<string, Promise<void>>();
const FETCH_COOLDOWN_MS = 5_000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

// Failed fetches (dead remote, no network, auth issues) get an exponential
// backoff so background pollers don't retry them on every tick. Without this,
// a repo with an unreachable origin was re-fetched every poller cycle forever.
const fetchLastFailure = new Map<string, { at: number; failures: number }>();
const FETCH_FAILURE_BACKOFF_BASE_MS = 2 * 60_000;
const FETCH_FAILURE_BACKOFF_MAX_MS = 30 * 60_000;

function fetchFailureBackoffMs(failures: number): number {
	return Math.min(FETCH_FAILURE_BACKOFF_BASE_MS * 2 ** (failures - 1), FETCH_FAILURE_BACKOFF_MAX_MS);
}

function isInFailureBackoff(cacheKey: string, now: number): boolean {
	const failure = fetchLastFailure.get(cacheKey);
	if (!failure) return false;
	return now - failure.at < fetchFailureBackoffMs(failure.failures);
}

export async function fetchOrigin(
	projectPath: string,
	branch?: string,
	timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<boolean> {
	await reportCurrentPreparationStage("fetching-origin");
	const now = Date.now();
	// Cache key is scoped to the specific branch when provided, or "*" for a full fetch.
	const cacheKey = branch ? `${projectPath}:${branch}` : `${projectPath}:*`;
	const lastSuccess = fetchLastSuccess.get(cacheKey) ?? 0;

	// Skip if a successful fetch completed recently
	if (now - lastSuccess < FETCH_COOLDOWN_MS) {
		log.debug("fetchOrigin: skipping (cooldown)", { projectPath, branch, msSinceLast: now - lastSuccess });
		return true;
	}

	// Skip if recent fetches for this key keep failing (exponential backoff)
	if (isInFailureBackoff(cacheKey, now)) {
		log.debug("fetchOrigin: skipping (failure backoff)", {
			projectPath,
			branch,
			failures: fetchLastFailure.get(cacheKey)?.failures,
		});
		return false;
	}

	// Reuse in-flight fetch for the same project+branch
	const existing = fetchInFlight.get(cacheKey);
	if (existing) {
		log.debug("fetchOrigin: reusing in-flight fetch", { projectPath, branch });
		return existing;
	}

	// Chain behind any concurrent fetch on this repo. All setup below is synchronous
	// so the queue tail is correctly sequenced even when two callers enter back-to-back.
	const prevInQueue = fetchProjectQueue.get(projectPath) ?? Promise.resolve();

	const promise: Promise<boolean> = prevInQueue.catch(() => {}).then(async () => {
		// Re-check cooldown: a preceding branch fetch may have taken long enough that we
		// now fall within the window, or another caller for this branch got here first.
		if (Date.now() - (fetchLastSuccess.get(cacheKey) ?? 0) < FETCH_COOLDOWN_MS) {
			log.debug("fetchOrigin: skipping (cooldown after queue wait)", { projectPath, branch });
			return true;
		}
		if (isInFailureBackoff(cacheKey, Date.now())) {
			log.debug("fetchOrigin: skipping (failure backoff after queue wait)", { projectPath, branch });
			return false;
		}

		const startedAt = performance.now();
		const cmd = branch
			? ["git", "fetch", "origin", branch, "--quiet"]
			: ["git", "fetch", "origin", "--quiet"];
		log.debug("Fetching origin", { projectPath, branch });
		const result = await run(cmd, projectPath, {
			timeoutMs,
			env: {
				GIT_TERMINAL_PROMPT: "0",
				GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
			},
		});
		if (result.ok) {
			fetchLastSuccess.set(cacheKey, Date.now());
			fetchLastFailure.delete(cacheKey);
			log.debug("fetchOrigin finished", {
				projectPath,
				branch,
				durationMs: Math.round(performance.now() - startedAt),
			});
		} else {
			const failures = (fetchLastFailure.get(cacheKey)?.failures ?? 0) + 1;
			fetchLastFailure.set(cacheKey, { at: Date.now(), failures });
			log.warn("fetchOrigin failed", {
				projectPath,
				branch,
				stderr: result.stderr,
				failures,
				nextRetryInMs: fetchFailureBackoffMs(failures),
				durationMs: Math.round(performance.now() - startedAt),
			});
		}
		return result.ok;
	});

	// Become the new queue tail. Errors are swallowed so subsequent fetches always run.
	fetchProjectQueue.set(projectPath, promise.then(() => {}).catch(() => {}));
	fetchInFlight.set(cacheKey, promise);
	try {
		return await promise;
	} finally {
		fetchInFlight.delete(cacheKey);
	}
}

export async function pullOrigin(
	projectPath: string,
	branch: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const startedAt = performance.now();
	log.info("pullOrigin", { projectPath, branch });
	const result = await run(["git", "pull", "--ff-only", "origin", branch], projectPath);
	log.info("pullOrigin finished", {
		projectPath,
		branch,
		ok: result.ok,
		durationMs: Math.round(performance.now() - startedAt),
	});
	if (result.ok) {
		// A successful pull effectively refreshes the remote tracking branch too —
		// keep the fetch cache honest so immediate callers don't re-fetch.
		fetchLastSuccess.set(`${projectPath}:${branch}`, Date.now());
	}
	return result;
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
	const remoteTrackingRef = `refs/remotes/${forkOwner}/${branchName}`;
	const fetchRefspec = `+refs/heads/${branchName}:${remoteTrackingRef}`;
	log.info("Fetching fork branch", { forkOwner, branchName, remoteTrackingRef });
	const fetchResult = await run(
		["git", "fetch", forkOwner, fetchRefspec, "--quiet"],
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
	for (const key of fetchInFlight.keys()) {
		if (key.startsWith(projectPath + ":")) fetchInFlight.delete(key);
	}
	for (const key of fetchLastSuccess.keys()) {
		if (key.startsWith(projectPath + ":")) fetchLastSuccess.delete(key);
	}
	for (const key of fetchLastFailure.keys()) {
		if (key.startsWith(projectPath + ":")) fetchLastFailure.delete(key);
	}
	fetchProjectQueue.delete(projectPath);
}

/** Reset fetch dedup state — for tests only. */
export function _resetFetchState(): void {
	fetchInFlight.clear();
	fetchLastSuccess.clear();
	fetchLastFailure.clear();
	fetchProjectQueue.clear();
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
		["git", "diff", "--numstat", ...RENAME_DETECTION_ARGS, "HEAD"],
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
): Promise<{ files: number; insertions: number; deletions: number; fileStats: Array<{ path: string; insertions: number; deletions: number }> }> {
	const result = await run(["git", "diff", "--numstat", ...RENAME_DETECTION_ARGS, `${ref}...HEAD`], worktreePath);
	if (!result.ok || !result.stdout.trim()) {
		return { files: 0, insertions: 0, deletions: 0, fileStats: [] };
	}
	// numstat lines: "<added>\t<removed>\t<path>" — added/removed are "-" for binary.
	// Renames render as "added\tremoved\told => new" or with {old => new} brace syntax.
	const fileStats: Array<{ path: string; insertions: number; deletions: number }> = [];
	let totalInsertions = 0;
	let totalDeletions = 0;
	for (const line of result.stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split("\t");
		if (parts.length < 3) continue;
		const added = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
		const removed = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
		if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;
		// For renamed files, prefer the new path. Strip "{old => new}" arrow notation.
		let path = parts.slice(2).join("\t");
		const arrowMatch = path.match(/^(.*)\{(.+?) => (.+?)\}(.*)$/);
		if (arrowMatch) {
			path = `${arrowMatch[1]}${arrowMatch[3]}${arrowMatch[4]}`;
		} else if (path.includes(" => ")) {
			const [, after] = path.split(" => ");
			if (after) path = after;
		}
		fileStats.push({ path, insertions: added, deletions: removed });
		totalInsertions += added;
		totalDeletions += removed;
	}
	return {
		files: fileStats.length,
		insertions: totalInsertions,
		deletions: totalDeletions,
		fileStats,
	};
}

export async function isContentMergedInto(
	worktreePath: string,
	ref: string,
	project?: Pick<Project, "githubAuthHost" | "githubAuthLogin">,
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
	if (await isBranchMergedViaGitHubPR(worktreePath, project)) {
		return true;
	}

	log.info("isContentMergedInto", { ref, mergeBase, merged: false });
	return false;
}

// CRITICAL: a merged PR matching the head branch *name* is NOT enough. Branch
// names get reused — a previously merged PR can coexist with brand-new unmerged
// work pushed to the same branch, or an open PR for the same head. This bites
// PR-review tasks especially. We only trust the merged-PR signal when the PR's
// merged head commit (headRefOid) equals the current local HEAD; in every
// GitHub merge method (merge/squash/rebase) the head ref tip is left untouched,
// so a genuine merge always satisfies this, while stale/reused-name PRs do not.
export async function isBranchMergedViaGitHubPR(
	worktreePath: string,
	project?: Pick<Project, "githubAuthHost" | "githubAuthLogin">,
): Promise<boolean> {
	const [branchResult, headShaResult] = await Promise.all([
		run(["git", "rev-parse", "--abbrev-ref", "HEAD"], worktreePath),
		run(["git", "rev-parse", "HEAD"], worktreePath),
	]);
	if (!branchResult.ok || !branchResult.stdout || !headShaResult.ok || !headShaResult.stdout) {
		return false;
	}
	// Detached HEAD has no branch name to match PRs against.
	if (branchResult.stdout === "HEAD") return false;

	const headSha = headShaResult.stdout.trim();
	try {
		const ghResult = project
			? await github.runGitHub(
				project,
				worktreePath,
				["pr", "list", "--head", branchResult.stdout, "--state", "merged", "--json", "number,headRefOid", "--limit", "1"],
			)
			: await run(
				["gh", "pr", "list", "--head", branchResult.stdout, "--state", "merged", "--json", "number,headRefOid", "--limit", "1"],
				worktreePath,
			);
		if (ghResult.ok && ghResult.stdout) {
			try {
				const prs = JSON.parse(ghResult.stdout);
				if (Array.isArray(prs) && prs.length > 0) {
					const pr = prs[0];
					if (pr?.headRefOid && pr.headRefOid === headSha) {
						log.info("isBranchMergedViaGitHubPR", { method: "github-pr", pr: pr.number, merged: true });
						return true;
					}
					log.info("isBranchMergedViaGitHubPR", {
						method: "github-pr",
						pr: pr?.number,
						headRefOid: pr?.headRefOid,
						headSha,
						merged: false,
						reason: "merged PR head does not match current HEAD",
					});
				}
			} catch { /* ignore parse errors */ }
		}
	} catch {
		// Ignore gh lookup/auth failures and report not-merged.
	}
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

export async function getBehindOriginCount(
	worktreePath: string,
	branchName: string,
): Promise<number> {
	if (!branchName) return 0;

	const ref = await run(
		["git", "rev-parse", "--verify", `origin/${branchName}`],
		worktreePath,
	);
	if (!ref.ok) return 0;

	// Count commits in origin/<branchName> but not in HEAD
	const result = await run(
		["git", "rev-list", "--count", `HEAD..origin/${branchName}`],
		worktreePath,
	);
	if (!result.ok) return 0;
	return parseInt(result.stdout, 10) || 0;
}

export async function getUpstreamRef(
	worktreePath: string,
): Promise<string | null> {
	const result = await run(
		["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
		worktreePath,
	);
	return result.ok && result.stdout ? result.stdout : null;
}

export async function getTaskDiff(
	worktreePath: string,
	mode: TaskDiffMode,
	options: {
		baseBranch: string;
		compareRef?: string;
		compareLabel?: string;
	},
): Promise<TaskDiffResponse> {
	const defaultCompareRef = options.compareRef || `origin/${options.baseBranch}`;
	const defaultCompareLabel = options.compareLabel || defaultCompareRef;

	if (mode === "uncommitted") {
		const [entries, untrackedEntries, summary, numstat] = await Promise.all([
			listDiffEntries(worktreePath, ["HEAD"]),
			listUntrackedEntries(worktreePath),
			getUncommittedChanges(worktreePath),
			getNumstat(worktreePath, ["HEAD"]),
		]);
		const allEntries = [...entries, ...untrackedEntries];
		const filesResult = await buildTaskDiffFiles(
			worktreePath,
			allEntries,
			{ kind: "ref", ref: "HEAD" },
			{ kind: "worktree" },
			numstat,
		);
		return {
			mode,
			compareRef: null,
			compareLabel: "Working tree",
			fallbackReason: null,
			summary: {
				files: allEntries.length,
				insertions: summary.insertions,
				deletions: summary.deletions,
			},
			...filesResult,
		};
	}

	if (mode === "unpushed") {
		const upstreamRef = await getUpstreamRef(worktreePath);
		if (upstreamRef) {
			const entries = await listDiffEntries(worktreePath, [upstreamRef, "HEAD"]);
			const [summary, numstat] = await Promise.all([
				getDiffShortStat(worktreePath, [upstreamRef, "HEAD"]),
				getNumstat(worktreePath, [upstreamRef, "HEAD"]),
			]);
			const filesResult = await buildTaskDiffFiles(
				worktreePath,
				entries,
				{ kind: "ref", ref: upstreamRef },
				{ kind: "ref", ref: "HEAD" },
				numstat,
			);
			return {
				mode,
				compareRef: upstreamRef,
				compareLabel: upstreamRef,
				fallbackReason: null,
				summary: {
					...summary,
					files: entries.length,
				},
				...filesResult,
			};
		}

		const branchEntries = await listDiffEntries(worktreePath, [`${defaultCompareRef}...HEAD`]);
		const [summary, numstat] = await Promise.all([
			getBranchDiffStats(worktreePath, defaultCompareRef),
			getNumstat(worktreePath, [`${defaultCompareRef}...HEAD`]),
		]);
		const filesResult = await buildTaskDiffFiles(
			worktreePath,
			branchEntries,
			{ kind: "ref", ref: defaultCompareRef },
			{ kind: "ref", ref: "HEAD" },
			numstat,
		);
		return {
			mode,
			compareRef: defaultCompareRef,
			compareLabel: defaultCompareLabel,
			fallbackReason: "no-upstream",
			summary: {
				files: branchEntries.length,
				insertions: summary.insertions,
				deletions: summary.deletions,
			},
			...filesResult,
		};
	}

	const branchEntries = await listDiffEntries(worktreePath, [`${defaultCompareRef}...HEAD`]);
	const [summary, numstat] = await Promise.all([
		getBranchDiffStats(worktreePath, defaultCompareRef),
		getNumstat(worktreePath, [`${defaultCompareRef}...HEAD`]),
	]);
	const filesResult = await buildTaskDiffFiles(
		worktreePath,
		branchEntries,
		{ kind: "ref", ref: defaultCompareRef },
		{ kind: "ref", ref: "HEAD" },
		numstat,
	);
	return {
		mode,
		compareRef: defaultCompareRef,
		compareLabel: defaultCompareLabel,
		fallbackReason: null,
		summary: {
			files: branchEntries.length,
			insertions: summary.insertions,
			deletions: summary.deletions,
		},
		...filesResult,
	};
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

	const worktreeDirPresent = existsSync(task.worktreePath);

	// Read live branch name before removing — it may differ from task.branchName
	// if the agent renamed the branch (e.g. `git branch -m dev3/task-xxx dev3/fix-login`).
	// Skip if the directory is already gone; spawning git with a missing cwd would
	// throw ENOENT and leave the branch undeleted.
	const liveBranch = worktreeDirPresent ? await getCurrentBranch(task.worktreePath) : null;
	const branchToDelete = liveBranch ?? task.branchName;

	if (worktreeDirPresent) {
		await run(
			["git", "worktree", "remove", "--force", task.worktreePath],
			project.path,
		);
	} else {
		log.info("Worktree directory already missing, pruning git metadata", {
			path: task.worktreePath,
			taskId: task.id,
		});
		await run(["git", "worktree", "prune"], project.path);
	}

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
