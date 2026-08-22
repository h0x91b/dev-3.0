import type { Project, Task, TaskDiffFile, TaskDiffFileStatus, TaskDiffMode, TaskDiffResponse, TaskDiffSkippedFile, TaskDiffSummary } from "../shared/types";
export { extractRepoName } from "../shared/types";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import {
	basename as basenamePath,
	dirname as dirnamePath,
	relative as relativePath,
	resolve as resolvePath,
} from "node:path";
import { createLogger } from "./logger";
import { CloneProgressParser } from "./clone-progress";
import { reportCurrentPreparationStage } from "./preparation-runtime";
import { spawn } from "./spawn";
import { DEV3_HOME } from "./paths";
import { projectStorageKey } from "../shared/project-storage-key";
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
	log.debug("Executing git command", { cwd, command: finalCmd });
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
		log.warn("Git command failed", {
			command: finalCmd,
			exitCode: outcome.code,
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
	log.debug("Executing git command with stdin", { cwd, command: finalCmd });
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

type PipeSink = {
	write(chunk: Uint8Array): number;
	flush(): Promise<number> | number;
	end(): void;
};

/**
 * Streams one git process's stdout straight into another git process's stdin,
 * with no shell involved.
 *
 * A `bash -c "git … | git …"` pipeline is unusable on Windows: PATH there
 * resolves `bash` to WSL bash, whose filesystem view mangles the native
 * worktree cwd, so the whole pipeline exits 128. See decision 178.
 *
 * Bytes are copied verbatim (patches are binary-safe) and each chunk is flushed
 * before the next read, so memory stays bounded no matter how large the patch.
 */
export async function runGitPipe(
	producerCmd: string[],
	consumerCmd: string[],
	cwd: string,
	opts?: { prefix?: Uint8Array },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const producerFinal = withGitFilenameEncoding(producerCmd);
	const consumerFinal = withGitFilenameEncoding(consumerCmd);
	log.debug("Executing git pipeline", { cwd, producer: producerFinal, consumer: consumerFinal });

	let producer: ReturnType<typeof spawn> | undefined;
	let consumer: ReturnType<typeof spawn> | undefined;
	try {
		producer = spawn(producerFinal, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		consumer = spawn(consumerFinal, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	} catch (err) {
		// One side never started — never leave the other running.
		try { producer?.kill(); } catch { /* already gone */ }
		try { consumer?.kill(); } catch { /* already gone */ }
		const stderr = `git pipeline spawn failed: ${String(err)}`;
		log.warn("Git pipeline spawn failed", { producer: producerFinal, consumer: consumerFinal, error: String(err) });
		return { ok: false, stdout: "", stderr };
	}

	// Drain every pipe before awaiting exit, or a >64KB write blocks forever.
	const consumerStdoutPromise = new Response(consumer.stdout as unknown as ReadableStream<Uint8Array>).text().catch(() => "");
	const consumerStderrPromise = new Response(consumer.stderr as unknown as ReadableStream<Uint8Array>).text().catch(() => "");
	const producerStderrPromise = new Response(producer.stderr as unknown as ReadableStream<Uint8Array>).text().catch(() => "");

	const sink = consumer.stdin as unknown as PipeSink;
	const reader = (producer.stdout as unknown as ReadableStream<Uint8Array>).getReader();
	let pipeError: string | null = null;
	try {
		if (opts?.prefix) {
			sink.write(opts.prefix);
			await sink.flush();
		}
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;
			sink.write(value);
			await sink.flush();
		}
	} catch (err) {
		// Consumer died early (broken pipe) or the producer stream errored.
		pipeError = String(err);
	} finally {
		try { reader.releaseLock(); } catch { /* already released */ }
		try { sink.end(); } catch { /* consumer already gone */ }
		if (pipeError) {
			try { producer.kill(); } catch { /* already gone */ }
		}
	}

	const [producerCode, consumerCode] = await Promise.all([
		producer.exited.catch(() => 1),
		consumer.exited.catch(() => 1),
	]);
	const [stdout, producerStderr, consumerStderr] = await Promise.all([
		consumerStdoutPromise,
		producerStderrPromise,
		consumerStderrPromise,
	]);

	const ok = producerCode === 0 && consumerCode === 0 && !pipeError;
	const stderr = [pipeError, producerStderr.trim(), consumerStderr.trim()].filter(Boolean).join("\n");
	if (!ok) {
		log.warn("Git pipeline failed", {
			producer: producerFinal,
			consumer: consumerFinal,
			producerCode,
			consumerCode,
			stderr,
		});
	}
	return { ok, stdout: stdout.trim(), stderr };
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

/**
 * Directory name for this project's data and worktrees.
 *
 * POSIX output is the frozen `/a/b/c` → `a-b-c` mapping; Windows gets a
 * sanitised key because a drive-qualified path is not a legal directory name.
 * The formula itself lives in `shared/project-storage-key.ts` so the CLI and
 * the conversation index cannot drift from it.
 */
export function projectSlug(projectPath: string): string {
	return projectStorageKey(projectPath);
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

type WorktreeRegistration = {
	path: string;
	lockedReason: string | null;
};

function parseWorktreeRegistrations(output: string): WorktreeRegistration[] {
	const registrations: WorktreeRegistration[] = [];
	let current: WorktreeRegistration | null = null;
	for (const field of output.split("\0")) {
		if (!field) {
			if (current) registrations.push(current);
			current = null;
			continue;
		}
		const separator = field.indexOf(" ");
		const name = separator < 0 ? field : field.slice(0, separator);
		const value = separator < 0 ? "" : field.slice(separator + 1);
		if (name === "worktree") {
			if (current) registrations.push(current);
			current = { path: value, lockedReason: null };
		} else if (name === "locked" && current) {
			current.lockedReason = value || "locked";
		}
	}
	if (current) registrations.push(current);
	return registrations;
}

async function listWorktreeRegistrations(projectPath: string): Promise<WorktreeRegistration[]> {
	const result = await run(["git", "worktree", "list", "--porcelain", "-z"], projectPath);
	return result.ok ? parseWorktreeRegistrations(result.stdout) : [];
}

function canonicalWorktreePath(candidate: string): string {
	let existingAncestor = resolvePath(candidate);
	const missingSegments: string[] = [];
	while (!existsSync(existingAncestor)) {
		const parent = dirnamePath(existingAncestor);
		if (parent === existingAncestor) return resolvePath(candidate);
		missingSegments.unshift(basenamePath(existingAncestor));
		existingAncestor = parent;
	}
	try {
		return resolvePath(realpathSync(existingAncestor), ...missingSegments);
	} catch {
		return resolvePath(candidate);
	}
}

function isManagedTaskWorktreePath(project: Project, candidate: string): boolean {
	const root = canonicalWorktreePath(`${DEV3_HOME}/worktrees/${projectSlug(project.path)}`);
	const relative = relativePath(root, canonicalWorktreePath(candidate));
	return /^[0-9a-f]{8}[\\/]worktree$/i.test(relative);
}

export async function recoverStaleInitializingWorktrees(
	project: Project,
	activePaths: ReadonlySet<string>,
): Promise<string[]> {
	const protectedPaths = new Set([...activePaths].map(canonicalWorktreePath));
	const recovered: string[] = [];
	for (const registration of await listWorktreeRegistrations(project.path)) {
		if (registration.lockedReason !== "initializing") continue;
		if (protectedPaths.has(canonicalWorktreePath(registration.path))) continue;
		if (!isManagedTaskWorktreePath(project, registration.path)) continue;
		const result = await run(
			["git", "worktree", "remove", "--force", "--force", registration.path],
			project.path,
		);
		if (result.ok) {
			recovered.push(registration.path);
			log.warn("Recovered stale initializing worktree", { path: registration.path });
		} else {
			log.warn("Failed to recover stale initializing worktree", {
				path: registration.path,
				error: result.stderr,
			});
		}
	}
	return recovered;
}

function branchName(task: Task): string {
	return `dev3/task-${shortId(task.id)}`;
}

async function localBranchExists(projectPath: string, branch: string): Promise<boolean> {
	return (await run(["git", "rev-parse", "--verify", `refs/heads/${branch}`], projectPath)).ok;
}

/**
 * Free the task's own worktree directory before `git worktree add`. The path is
 * derived from task.id, so dev3 owns it: a leftover means a prior failed cleanup
 * or a re-run after the task was moved back to To Do. Stderr-driven retries do
 * not work here — a failed add still creates the directory as a side effect.
 */
async function reclaimStaleWorktreeDir(project: Project, wtPath: string): Promise<void> {
	if (!existsSync(wtPath)) return;
	log.warn("Reclaiming leftover worktree directory", { wtPath, projectPath: project.path });
	await run(["git", "worktree", "remove", "--force", wtPath], project.path);
	if (existsSync(wtPath)) {
		rmSync(wtPath, { recursive: true, force: true });
	}
	await run(["git", "worktree", "prune"], project.path);
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

	// Create the task container directory (with logs/ subfolder). `mkdir -p` is
	// not a Windows binary, and this runs before any worktree exists.
	mkdirSync(`${tDir}/logs`, { recursive: true });

	if (existingBranch && variantBranchName) {
		// Multi-variant mode: create a new branch from the existing branch's HEAD
		const resolvedBase = existingBranch;
		log.info("Creating variant worktree from existing branch", {
			wtPath, variantBranchName, base: resolvedBase, taskId: task.id,
		});

		await reclaimStaleWorktreeDir(project, wtPath);
		// A leftover variant branch (re-run of a task that kept its branch) is
		// checked out instead of recreated, so its commits survive the re-run.
		const variantAddArgs = await localBranchExists(project.path, variantBranchName)
			? ["git", "worktree", "add", wtPath, variantBranchName]
			: ["git", "worktree", "add", "-b", variantBranchName, wtPath, resolvedBase];

		const result = await measureGitStep(
			"createWorktree.variant.worktreeAdd",
			{ taskId: task.id.slice(0, 8), wtPath, variantBranchName, base: resolvedBase },
			() => run(variantAddArgs, project.path),
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

		await reclaimStaleWorktreeDir(project, wtPath);

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
			// `--track -b` only helps when the local branch is still missing. With the
			// branch already on disk it fails with a misleading "a branch named X
			// already exists" that hides the real reason the first add failed.
			const localBranchMissing = isRemoteRef
				&& !(await localBranchExists(project.path, resolvedBranch));

			if (isRemoteRef && localBranchMissing && !isAlreadyCheckedOut) {
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

	// Reclaim stale leftovers from a prior failed cleanup before `git worktree
	// add`. Both the path and the `dev3/task-*` branch are derived from task.id,
	// so dev3 owns them and recreating them from the base branch is safe.
	await reclaimStaleWorktreeDir(project, wtPath);
	if (await localBranchExists(project.path, branch)) {
		log.warn("Reclaiming leftover task branch", { taskId: task.id.slice(0, 8), branch });
		await run(["git", "branch", "-D", branch], project.path);
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

export async function refExists(projectPath: string, ref: string): Promise<boolean> {
	const result = await run(["git", "rev-parse", "--verify", ref], projectPath);
	return result.ok;
}

// detectDefaultCompareRef spawns several git commands (and sets up base-branch
// tracking). It is invoked by resolveProjectConfig, which the renderer polls every
// few seconds, so the result is cached with a TTL. The in-flight promise is cached
// too, coalescing concurrent callers.
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

/**
 * Does this repo have an `origin` remote at all? A project added from a local
 * folder has none, and then every `origin/...` ref, `git push`, and `gh` call is
 * a dead end. Callers use it to make the absence explicit instead of letting a
 * missing ref look like "no changes".
 */
export async function hasOriginRemote(projectPath: string): Promise<boolean> {
	return (await listRemotes(projectPath)).includes("origin");
}

async function detectDefaultCompareRefUncached(
	projectPath: string,
	baseBranch: string,
): Promise<string> {
	const originPresent = await hasOriginRemote(projectPath);
	const remoteBaseRef = `origin/${baseBranch}`;
	const remoteBaseExists = originPresent && await refExists(projectPath, remoteBaseRef);
	const localBaseExists = await refExists(projectPath, baseBranch);
	if (baseBranch === "main" || baseBranch === "master") {
		if (remoteBaseExists) {
			if (localBaseExists) {
				await run(["git", "branch", "--set-upstream-to", remoteBaseRef, baseBranch], projectPath);
			} else {
				await run(["git", "branch", "--track", baseBranch, remoteBaseRef], projectPath);
			}
		}
	}

	// The remote ref always wins: dev3 fetches origin but never fast-forwards the
	// main clone's local base branch, so the local one goes stale and diffs lie.
	if (remoteBaseExists) return remoteBaseRef;

	if (originPresent) {
		for (const branchName of ["main", "master"]) {
			const remoteRef = `origin/${branchName}`;
			if (await refExists(projectPath, remoteRef)) return remoteRef;
		}
	}

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
	return fetchFromRemote(projectPath, "origin", branch, timeoutMs);
}

async function fetchFromRemote(
	projectPath: string,
	remote: string,
	branch?: string,
	timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<boolean> {
	await reportCurrentPreparationStage("fetching-origin");
	const now = Date.now();
	// Cache key is scoped to the specific remote+branch, or "*" for a full fetch.
	const cacheKey = branch ? `${projectPath}:${remote}/${branch}` : `${projectPath}:${remote}:*`;
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
		// A non-origin remote needs an explicit refspec, otherwise `git fetch <fork>
		// <branch>` lands in FETCH_HEAD only and refs/remotes/<fork>/<branch> —
		// the ref every comparison resolves — stays frozen at its old commit.
		const cmd = branch
			? remote === "origin"
				? ["git", "fetch", "origin", branch, "--quiet"]
				: ["git", "fetch", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`, "--quiet"]
			: ["git", "fetch", remote, "--quiet"];
		log.debug("Fetching remote", { projectPath, remote, branch });
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

/** Configured remote names, e.g. `["origin", "arditti"]`. Empty when git fails. */
export async function listRemotes(projectPath: string): Promise<string[]> {
	const result = await run(["git", "remote"], projectPath);
	if (!result.ok) return [];
	return result.stdout.split("\n").map((remote) => remote.trim()).filter(Boolean);
}

/**
 * True when `existingBranch` names a ref the local user did not author: a
 * remote-tracking branch (`origin/feature`) or a fork remote's branch
 * (`arditti/feat/x`, added by {@link fetchFork} for a cross-repo pull request).
 *
 * Answered from the remote LIST on purpose, never from `refs/remotes/<ref>`:
 * a merged pull request's branch is deleted upstream, and a ref check would then
 * quietly reclassify the task as the user's own work. Remotes outlive branches.
 */
export async function isForeignBranchRef(projectPath: string, existingBranch?: string | null): Promise<boolean> {
	const ref = existingBranch?.trim().replace(/^refs\/remotes\//, "");
	if (!ref) return false;
	const slash = ref.indexOf("/");
	if (slash <= 0) return false; // plain local branch name
	const remotes = await listRemotes(projectPath);
	// listRemotes folds git failures into []. A repo that produced a remote-qualified
	// ref cannot genuinely have zero remotes, so an empty answer means "could not
	// tell" — and an unknown provenance is treated as foreign, never as trusted.
	if (remotes.length === 0) return true;
	return remotes.includes(ref.slice(0, slash));
}

/**
 * Fetch the branch a task actually compares against. A fork-review base is
 * stored remote-qualified (`arditti/feat/x`) and resolves to
 * `refs/remotes/arditti/feat/x`, so fetching it from `origin` fails with
 * "couldn't find remote ref" and the comparison keeps using a frozen ref.
 * Route it to the remote that owns it; anything else is an origin branch.
 */
export async function fetchCompareRef(
	projectPath: string,
	branch: string,
	timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<boolean> {
	const slash = branch.indexOf("/");
	if (slash > 0) {
		const remote = branch.slice(0, slash);
		if (remote !== "origin" && (await listRemotes(projectPath)).includes(remote)) {
			return fetchFromRemote(projectPath, remote, branch.slice(slash + 1), timeoutMs);
		}
	}
	return fetchFromRemote(projectPath, "origin", branch, timeoutMs);
}

/** Is `ref` fully contained in `targetRef`? False when either ref is unresolvable. */
export async function isRefMergedInto(projectPath: string, ref: string, targetRef: string): Promise<boolean> {
	const result = await run(["git", "merge-base", "--is-ancestor", ref, targetRef], projectPath);
	return result.ok;
}

// `git pull --ff-only` intermittently dies with "fatal: Cannot fast-forward to
// multiple branches." — a transient race where a concurrent background fetch
// (see the fetchOrigin dedup machinery above) rewrites FETCH_HEAD between the
// pull's own fetch and merge steps, leaving several branches flagged for-merge.
// Re-running the pull re-fetches a clean FETCH_HEAD, so a single retry clears it.
const MULTIPLE_BRANCHES_FF_ERROR = /Cannot fast-forward to multiple branches/i;
const PULL_RETRY_DELAY_MS = 400;

export async function pullOrigin(
	projectPath: string,
	branch: string,
	opts?: { retryDelayMs?: number },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const startedAt = performance.now();
	log.info("pullOrigin", { projectPath, branch });
	let result = await run(["git", "pull", "--ff-only", "origin", branch], projectPath);
	// One (and only one) retry, scoped to the multiple-branches fast-forward race.
	if (!result.ok && MULTIPLE_BRANCHES_FF_ERROR.test(result.stderr)) {
		const delayMs = opts?.retryDelayMs ?? PULL_RETRY_DELAY_MS;
		log.warn("pullOrigin: 'cannot fast-forward to multiple branches' — retrying once", {
			projectPath,
			branch,
			delayMs,
		});
		if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
		result = await run(["git", "pull", "--ff-only", "origin", branch], projectPath);
	}
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
 * The sha a ref currently points at, or null when the ref is absent. Used to bake
 * an explicit `--force-with-lease=<branch>:<sha>` value: the bare form leases
 * against whatever remote-tracking ref is on disk, which may be stale, and a stale
 * lease silently overwrites a push nobody fetched.
 */
export async function resolveRef(repoPath: string, ref: string): Promise<string | null> {
	const result = await run(["git", "rev-parse", "--verify", `${ref}^{commit}`], repoPath);
	return result.ok && result.stdout ? result.stdout.trim() : null;
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

const PATCH_ID_CMD = ["git", "patch-id", "--stable"];
// git patch-id keys each patch by the commit line preceding it; a raw `git diff`
// has none, so we synthesise a zero SHA header.
const FAKE_COMMIT_HEADER = new TextEncoder().encode(`commit ${"0".repeat(40)}\n\n`);

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
	// IMPORTANT: We stream git log -p directly into git patch-id via runGitPipe
	// (no shell) to avoid reading multi-MB patch output into JS memory.
	const mergeBaseResult = await run(["git", "merge-base", ref, "HEAD"], worktreePath);
	if (!mergeBaseResult.ok) return false;
	const mergeBase = mergeBaseResult.stdout;

	// Check if there are any task changes at all (lightweight --stat check)
	const taskStatResult = await run(["git", "diff", "--shortstat", mergeBase, "HEAD"], worktreePath);
	if (!taskStatResult.ok || !taskStatResult.stdout) return true; // no task changes

	// Validate refs before use — mergeBase is a SHA from git merge-base, ref is
	// origin/<baseBranch> from project config. Nothing below goes through a
	// shell, but a ref starting with "-" would still be read as a git option.
	assertSafeRef(mergeBase, "mergeBase");
	assertSafeRef(ref, "ref");

	const [combinedPatchIdResult, taskPatchIdsResult, mainPatchIdsResult] = await Promise.all([
		// Combined diff as a single patch-id (for squash merge detection).
		// We prepend a fake commit header so git patch-id can parse it.
		runGitPipe(["git", "diff", mergeBase, "HEAD"], PATCH_ID_CMD, worktreePath, {
			prefix: FAKE_COMMIT_HEADER,
		}),
		// Per-commit patch-ids from the task branch (capped to prevent unbounded memory)
		runGitPipe(
			["git", "log", "-p", "--no-merges", "--max-count=500", `${mergeBase}..HEAD`],
			PATCH_ID_CMD,
			worktreePath,
		),
		// Per-commit patch-ids from the base branch (capped to prevent unbounded memory)
		runGitPipe(
			["git", "log", "-p", "--no-merges", "--max-count=500", `${mergeBase}..${ref}`],
			PATCH_ID_CMD,
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

/**
 * Full messages of the commits this branch adds on top of `baseRef`, oldest
 * first. Feeds the squash-merge commit message, so it reads `%B` (subject AND
 * body) and separates records with NUL — a commit body contains blank lines and
 * anything printable, so no textual delimiter is safe.
 *
 * An unresolvable `baseRef` yields `[]` rather than the whole history: the caller
 * then falls back to the task title, which is far better than pasting every
 * commit message in the repo into one subject.
 *
 * `--no-merges` drops "Merge branch 'main' into feature" — it describes an
 * integration step, never the work being landed.
 */
export async function listBranchCommitMessages(
	worktreePath: string,
	baseRef: string,
): Promise<string[]> {
	const mergeBase = await run(["git", "merge-base", baseRef, "HEAD"], worktreePath);
	if (!mergeBase.ok || !mergeBase.stdout) return [];
	const log = await run(
		["git", "log", "--reverse", "--no-merges", "--format=%B%x00", `${mergeBase.stdout}..HEAD`],
		worktreePath,
	);
	if (!log.ok) return [];
	return log.stdout.split("\0").map((m) => m.trim()).filter((m) => m.length > 0);
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

/**
 * Number of commits that belong to this branch — i.e. commits reachable from
 * HEAD but not from the base branch. Used to clamp `recent` mode's `HEAD~N` so
 * it never reaches into base-branch history. Purely local: prefers the already
 * on-disk `origin/<base>` remote-tracking ref (populated at worktree creation),
 * then the local base branch, and finally the full HEAD history as a floor so a
 * detached or origin-less repo still gets a sane clamp instead of erroring.
 */
async function getBranchCommitCount(
	worktreePath: string,
	compareRef: string,
	baseBranch: string,
): Promise<number> {
	for (const ref of [compareRef, baseBranch]) {
		if (!ref) continue;
		const mergeBase = await run(["git", "merge-base", ref, "HEAD"], worktreePath);
		if (!mergeBase.ok || !mergeBase.stdout) continue;
		const count = await run(
			["git", "rev-list", "--count", `${mergeBase.stdout}..HEAD`],
			worktreePath,
		);
		if (count.ok) return parseInt(count.stdout, 10) || 0;
	}
	// No usable base ref (origin-less test repo, orphaned branch): clamp to the
	// full first-parent history so `HEAD~N` can never step before the root commit.
	const total = await run(["git", "rev-list", "--count", "HEAD"], worktreePath);
	return total.ok ? parseInt(total.stdout, 10) || 0 : 0;
}

export async function getTaskDiff(
	worktreePath: string,
	mode: TaskDiffMode,
	options: {
		baseBranch: string;
		compareRef?: string;
		compareLabel?: string;
		count?: number;
	},
): Promise<TaskDiffResponse> {
	const defaultCompareRef = options.compareRef || `origin/${options.baseBranch}`;
	const defaultCompareLabel = options.compareLabel || defaultCompareRef;

	if (mode === "recent") {
		// Requested N, floored at 1, then clamped to the branch's own commit count
		// so we never diff into base-branch history. `HEAD~effective..HEAD` is a
		// direct first-parent range, so a two-dot diff is exact here (no merge-base
		// gymnastics). effective === 0 → `HEAD~0..HEAD` is naturally empty.
		const requested = Math.max(1, Math.floor(options.count ?? 1));
		const branchCommitCount = await getBranchCommitCount(worktreePath, defaultCompareRef, options.baseBranch);
		const effective = Math.min(requested, branchCommitCount);
		const oldRef = `HEAD~${effective}`;
		const entries = await listDiffEntries(worktreePath, [oldRef, "HEAD"]);
		const [summary, numstat] = await Promise.all([
			getDiffShortStat(worktreePath, [oldRef, "HEAD"]),
			getNumstat(worktreePath, [oldRef, "HEAD"]),
		]);
		const filesResult = await buildTaskDiffFiles(
			worktreePath,
			entries,
			{ kind: "ref", ref: oldRef },
			{ kind: "ref", ref: "HEAD" },
			numstat,
		);
		return {
			mode,
			compareRef: effective > 0 ? oldRef : null,
			compareLabel: oldRef,
			fallbackReason: null,
			recentCount: effective,
			summary: {
				files: entries.length,
				insertions: summary.insertions,
				deletions: summary.deletions,
			},
			...filesResult,
		};
	}

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
			recentCount: null,
			summary: {
				files: allEntries.length,
				insertions: summary.insertions,
				deletions: summary.deletions,
			},
			...filesResult,
		};
	}

	/**
	 * A compare ref that is not in the repo makes `git diff` fail, and a failed
	 * diff arrives here as an empty one — "no changes to show" for a comparison
	 * that never happened. Checked only when the diff came back empty, so the
	 * normal path pays nothing.
	 */
	const withMissingRefCheck = async (result: TaskDiffResponse): Promise<TaskDiffResponse> => {
		if (result.files.length > 0 || result.skippedFiles.length > 0 || result.summary.files > 0) return result;
		if (await refExists(worktreePath, defaultCompareRef)) return result;
		return { ...result, fallbackReason: "missing-compare-ref", summary: { files: 0, insertions: 0, deletions: 0 } };
	};

	if (mode === "unpushed") {
		const upstreamRef = await getUpstreamRef(worktreePath);
		if (upstreamRef) {
			// Compare HEAD against the merge-base with the upstream (three-dot
			// semantics), not the upstream tip directly. A two-dot
			// `upstream..HEAD` diff also surfaces commits the upstream gained
			// independently of HEAD — after a rebase, a force-push, or when the
			// upstream tracks the base branch and the base has advanced — as
			// reversed hunks, i.e. "changes that aren't mine". The merge-base
			// shows only what HEAD added. Mirrors the no-upstream fallback below.
			const mergeBaseResult = await run(
				["git", "merge-base", upstreamRef, "HEAD"],
				worktreePath,
			);
			const oldRef = mergeBaseResult.ok && mergeBaseResult.stdout
				? mergeBaseResult.stdout
				: upstreamRef;
			const entries = await listDiffEntries(worktreePath, [oldRef, "HEAD"]);
			const [summary, numstat] = await Promise.all([
				getDiffShortStat(worktreePath, [oldRef, "HEAD"]),
				getNumstat(worktreePath, [oldRef, "HEAD"]),
			]);
			const filesResult = await buildTaskDiffFiles(
				worktreePath,
				entries,
				{ kind: "ref", ref: oldRef },
				{ kind: "ref", ref: "HEAD" },
				numstat,
			);
			return {
				mode,
				compareRef: upstreamRef,
				compareLabel: upstreamRef,
				fallbackReason: null,
				recentCount: null,
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
		return withMissingRefCheck({
			mode,
			compareRef: defaultCompareRef,
			compareLabel: defaultCompareLabel,
			fallbackReason: "no-upstream",
			recentCount: null,
			summary: {
				files: branchEntries.length,
				insertions: summary.insertions,
				deletions: summary.deletions,
			},
			...filesResult,
		});
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
	return withMissingRefCheck({
		mode,
		compareRef: defaultCompareRef,
		compareLabel: defaultCompareLabel,
		fallbackReason: null,
		recentCount: null,
		summary: {
			files: branchEntries.length,
			insertions: summary.insertions,
			deletions: summary.deletions,
		},
		...filesResult,
	});
}

/** How many output lines a clone progress update carries to the UI. */
const CLONE_PROGRESS_LINES = 4;

export async function cloneRepo(
	url: string,
	targetDir: string,
	onProgress?: (lines: string[]) => void,
): Promise<{ ok: boolean; path: string; error?: string }> {
	log.info("Cloning repository", { url, targetDir });
	// `run()` buffers output until exit, so it can't surface live progress.
	// `--progress` forces git to emit progress even though stderr is a pipe
	// (it normally requires a TTY).
	const proc = spawn(["git", "clone", "--progress", url, targetDir], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const parser = new CloneProgressParser();
	const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
	const stderrPromise = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
			parser.feed(decoder.decode(chunk, { stream: true }));
			onProgress?.(parser.lines(CLONE_PROGRESS_LINES));
		}
		parser.feed(decoder.decode());
	})().catch(() => {});
	const [code] = await Promise.all([proc.exited, stderrPromise, stdoutPromise]);
	if (code !== 0) {
		// The raw stderr is `\r`-rewrite spam; report the terminal-style tail.
		const error = parser.lines(8).join("\n") || `git clone exited with code ${code}`;
		log.error("Clone failed", { url, stderr: error });
		return { ok: false, path: targetDir, error };
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

/**
 * `git worktree remove` failures that mean "git never knew about this path"
 * (metadata pruned, repo re-cloned, admin dir wiped) — not "removal refused".
 */
function isUnregisteredWorktreeError(stderr: string): boolean {
	return /is not a working tree|is not a worktree|not a valid path/i.test(stderr);
}

export async function removeWorktree(
	project: Project,
	task: Task,
): Promise<void> {
	if (!task.worktreePath) return;

	log.info("Removing worktree", { path: task.worktreePath, taskId: task.id });

	const targetPath = task.worktreePath;
	const worktreeDirPresent = existsSync(targetPath);
	const registration = (await listWorktreeRegistrations(project.path))
		.find((candidate) => canonicalWorktreePath(candidate.path) === canonicalWorktreePath(targetPath));
	const lockedInitializing = registration?.lockedReason === "initializing";

	// Read live branch name before removing — it may differ from task.branchName
	// if the agent renamed the branch (e.g. `git branch -m dev3/task-xxx dev3/fix-login`).
	// Skip if the directory is already gone; spawning git with a missing cwd would
	// throw ENOENT and leave the branch undeleted.
	const liveBranch = worktreeDirPresent ? await getCurrentBranch(targetPath) : null;
	const branchToDelete = liveBranch ?? task.branchName;

	if (worktreeDirPresent || lockedInitializing) {
		const removeArgs = lockedInitializing
			? ["git", "worktree", "remove", "--force", "--force", targetPath]
			: ["git", "worktree", "remove", "--force", targetPath];
		const removeResult = await run(
			removeArgs,
			project.path,
		);
		if (!removeResult.ok) {
			const detail = removeResult.stderr.trim() || "git worktree remove exited unsuccessfully";
			if (isUnregisteredWorktreeError(removeResult.stderr)) {
				// Git has no metadata for this path, so there is no worktree left to
				// remove — only an orphan directory. Blocking teardown here strands the
				// task forever (nothing can ever make git recognize the path again).
				log.warn("Worktree is not registered with git, treating as already removed", {
					path: targetPath,
					taskId: task.id,
					stderr: removeResult.stderr,
				});
				if (isManagedTaskWorktreePath(project, targetPath)) {
					rmSync(targetPath, { recursive: true, force: true });
				}
				await run(["git", "worktree", "prune"], project.path);
			} else {
				log.error("Failed to remove worktree", {
					path: targetPath,
					taskId: task.id,
					stderr: removeResult.stderr,
				});
				throw new Error(`Failed to remove worktree at ${targetPath}: ${detail}`);
			}
		}
	} else {
		log.info("Worktree directory already missing, pruning git metadata", {
			path: targetPath,
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
