/**
 * Copy-on-Write directory/file cloning.
 *
 * macOS cascade: clonefile(2) via FFI → cp -cR → cp -R
 * Linux cascade: cp -R --reflink=always → cp -R
 *
 * Paths run in parallel, bounded by MAX_CONCURRENT_CLONES across all tasks.
 */

import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { createLogger } from "./logger";
import { spawn } from "./spawn";

const log = createLogger("cow-clone");

export type CloneMethod = "clonefile" | "apfs-clone" | "reflink" | "copy";

export interface CloneResult {
	path: string;
	method: CloneMethod;
	durationMs: number;
	/**
	 * The source does not exist in the project root. Deliberate and not an error:
	 * a clone list is shared across machines and auto-detection is a snapshot, so
	 * a path that is simply absent is skipped. `error` is the opposite case — the
	 * source WAS there and the copy failed.
	 */
	skipped?: boolean;
	error?: string;
}

function isMacOS(): boolean {
	return process.platform === "darwin";
}

/**
 * Windows has none of `cp`/`rm`/`test`, and no copy-on-write clone we can reach
 * from here — NTFS block cloning needs a DeviceIoControl call. It gets a plain
 * recursive copy through node:fs; POSIX keeps its spawn-based cascade untouched.
 *
 * Every Windows call here is the promise form on purpose: the sync form froze the
 * main process for 26s copying node_modules (`Event loop stall detected`, observed
 * live), while POSIX pays nothing because a spawned `cp` was never on this thread.
 */
function isWindows(): boolean {
	return process.platform === "win32";
}

/** Check if a pattern contains glob characters. */
function isGlob(p: string): boolean {
	return p.includes("*") || p.includes("?") || p.includes("[");
}

/** Validate a relative path — reject traversal and absolute paths. */
function validatePath(p: string): void {
	// `C:\x` and `\\server\x` are absolute too, and neither starts with "/".
	if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) {
		throw new Error(`Absolute path not allowed: ${p}`);
	}
	// Strip glob characters for traversal check
	const cleaned = p.replace(/[*?\[\]]/g, "");
	const segments = cleaned.split(/[\\/]/);
	for (const seg of segments) {
		if (seg === "..") {
			throw new Error(`Path traversal not allowed: ${p}`);
		}
	}
}

/**
 * Expand a glob pattern relative to a root directory.
 * Returns matched paths relative to the root.
 * Only matches directories (for cloning).
 */
async function expandGlob(root: string, pattern: string): Promise<string[]> {
	try {
		const glob = new Bun.Glob(pattern);
		const matches: string[] = [];
		for await (const match of glob.scan({ cwd: root, onlyFiles: false })) {
			// Check if it's a directory or file
			const fullPath = `${root}/${match}`;
			if (await pathExists(fullPath)) {
				matches.push(match);
			}
		}
		return matches;
	} catch (err) {
		log.debug("Glob expansion failed", { pattern, error: String(err) });
		return [];
	}
}

/** Remove a path (rm -rf), ignoring errors. */
async function removePath(fullPath: string): Promise<void> {
	if (isWindows()) {
		try {
			await rm(fullPath, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		return;
	}
	try {
		const proc = spawn(["rm", "-rf", fullPath]);
		await proc.exited;
	} catch {
		// best-effort
	}
}

/** Ensure parent directory exists. */
async function ensureParent(fullPath: string): Promise<void> {
	if (isWindows()) {
		const parent = dirname(fullPath);
		if (parent && parent !== fullPath) await mkdir(parent, { recursive: true });
		return;
	}
	const parent = fullPath.slice(0, fullPath.lastIndexOf("/"));
	if (parent) {
		const proc = spawn(["mkdir", "-p", parent]);
		await proc.exited;
	}
}

/** Check if a path exists. */
async function pathExists(fullPath: string): Promise<boolean> {
	if (isWindows()) return existsSync(fullPath);
	try {
		const proc = spawn(["test", "-e", fullPath]);
		const code = await proc.exited;
		return code === 0;
	} catch {
		return false;
	}
}

interface RunOutcome {
	code: number;
	stderr: string;
}

/** Drain a piped stderr before awaiting exit — a full pipe would deadlock the child. */
async function readStderr(proc: { stderr?: unknown }): Promise<string> {
	const stream = proc.stderr;
	if (!stream || typeof stream === "number") return "";
	try {
		return (await new Response(stream as ReadableStream).text()).trim();
	} catch {
		return "";
	}
}

/** Run a command and return its exit code plus whatever it wrote to stderr. */
async function run(cmd: string[]): Promise<RunOutcome> {
	const proc = spawn(cmd, { stderr: "pipe" });
	const stderr = await readStderr(proc);
	return { code: await proc.exited, stderr };
}

/** One line for a log field and for the task banner — never an empty string. */
function describeFailure(cmd: string, outcome: RunOutcome): string {
	const detail = outcome.stderr.split("\n").filter(Boolean).slice(-1)[0];
	return detail ? `${detail} (${cmd} exited ${outcome.code})` : `${cmd} exited ${outcome.code}`;
}

export interface ClonefileJob {
	src: string;
	dst: string;
}

export type ClonefileReply = { ok: true } | { ok: false; error: string };

let clonefileWorkerPath: string | null = null;
let warnedMissingWorker = false;

/**
 * Point clonefile(2) at the bundled worker. The syscall clones a whole tree in one
 * blocking call, so on the host thread it froze every RPC and terminal for as long
 * as the tree took. Unset or missing, the cascade starts at `cp -cR` instead.
 */
export function configureClonefileWorker(path: string | null): void {
	clonefileWorkerPath = path;
	warnedMissingWorker = false;
}

/**
 * Resolves only on the worker's `exit`, never on its message alone: a fallback that
 * starts while the thread may still be inside clonefile would write into the same
 * destination. No timeout for the same reason — a syscall cannot be interrupted.
 */
function runClonefileWorker(path: string, job: ClonefileJob): Promise<ClonefileReply> {
	return new Promise((resolve) => {
		let reply: ClonefileReply | null = null;
		let worker: Worker;
		try {
			worker = new Worker(path, { workerData: job });
		} catch (error) {
			resolve({ ok: false, error: `clonefile worker did not start: ${String(error)}` });
			return;
		}
		worker.on("message", (message: ClonefileReply) => {
			reply ??= message;
		});
		worker.on("error", (error) => {
			reply ??= { ok: false, error: `clonefile worker failed: ${String(error)}` };
		});
		worker.on("exit", (code) => {
			resolve(reply ?? { ok: false, error: `clonefile worker exited with code ${code}` });
		});
	});
}

/** clonefile(2) off the host thread; false means "fall through to cp -cR". */
async function tryClonefile(src: string, dst: string): Promise<boolean> {
	const path = clonefileWorkerPath;
	if (!path || !existsSync(path)) {
		if (path && !warnedMissingWorker) {
			warnedMissingWorker = true;
			log.warn("clonefile worker missing; cloning with cp -cR", { path });
		}
		return false;
	}
	const reply = await runClonefileWorker(path, { src, dst });
	if (!reply.ok) log.debug("clonefile failed, falling back", { error: reply.error });
	return reply.ok;
}

/**
 * Clone work across every preparing task shares these slots: several monorepo
 * tasks started together would otherwise all hit the same disk at once.
 */
export const MAX_CONCURRENT_CLONES = 2;
let activeClones = 0;
const cloneQueue: Array<() => void> = [];

async function withCloneSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (activeClones >= MAX_CONCURRENT_CLONES) {
		await new Promise<void>((resolve) => cloneQueue.push(resolve));
	} else {
		activeClones++;
	}
	try {
		return await fn();
	} finally {
		const next = cloneQueue.shift();
		if (next) next();
		else activeClones--;
	}
}

/** Clone a single path using the cascade strategy. */
async function cloneSingle(
	sourceRoot: string,
	destRoot: string,
	relativePath: string,
): Promise<CloneResult> {
	const start = performance.now();
	const src = `${sourceRoot}/${relativePath}`;
	const dst = `${destRoot}/${relativePath}`;

	// Check source exists
	if (!(await pathExists(src))) {
		log.info("Source not found, skipping", { path: relativePath, src });
		return {
			path: relativePath,
			method: "copy",
			durationMs: Math.round(performance.now() - start),
			skipped: true,
		};
	}

	return withCloneSlot(() => copyIntoPlace(src, dst, relativePath, start));
}

async function copyIntoPlace(src: string, dst: string, relativePath: string, start: number): Promise<CloneResult> {
	// Prepare destination
	await ensureParent(dst);
	await removePath(dst);

	if (isWindows()) {
		try {
			await cp(src, dst, { recursive: true, force: true });
		} catch (err) {
			return failed(relativePath, start, String(err), { src, dst });
		}
		const ms = Math.round(performance.now() - start);
		log.info("Copied via node:fs cp", { path: relativePath, ms });
		return { path: relativePath, method: "copy", durationMs: ms };
	}

	if (isMacOS()) {
		// 1. Try clonefile(2) — atomic whole-tree clone, in a worker thread
		if (await tryClonefile(src, dst)) {
			const ms = Math.round(performance.now() - start);
			log.info("Cloned via clonefile(2)", { path: relativePath, ms });
			return { path: relativePath, method: "clonefile", durationMs: ms };
		}
		await removePath(dst);

		// 2. Try cp -cR (per-file APFS clone)
		const apfs = await run(["cp", "-cR", src, dst]);
		if (apfs.code === 0) {
			const ms = Math.round(performance.now() - start);
			log.info("Cloned via cp -cR", { path: relativePath, ms });
			return { path: relativePath, method: "apfs-clone", durationMs: ms };
		}
		log.debug("cp -cR failed, falling back", { path: relativePath, reason: describeFailure("cp -cR", apfs) });
		await removePath(dst);
	} else {
		// Linux: try reflink. A filesystem without reflink support fails every
		// time, so this stays at debug — only the last fallback is an error.
		const reflink = await run(["cp", "-R", "--reflink=always", src, dst]);
		if (reflink.code === 0) {
			const ms = Math.round(performance.now() - start);
			log.info("Cloned via reflink", { path: relativePath, ms });
			return { path: relativePath, method: "reflink", durationMs: ms };
		}
		log.debug("reflink failed, falling back", { path: relativePath, reason: describeFailure("cp -R --reflink=always", reflink) });
		await removePath(dst);
	}

	// Last fallback. Nothing catches a failure after this, so its exit code is the
	// only thing standing between a missing path and a worktree that claims to have it.
	const copy = await run(["cp", "-R", src, dst]);
	if (copy.code !== 0) {
		return failed(relativePath, start, describeFailure("cp -R", copy), { src, dst });
	}
	const ms = Math.round(performance.now() - start);
	log.info("Copied via cp -R", { path: relativePath, ms });
	return { path: relativePath, method: "copy", durationMs: ms };
}

/** A copy that did not happen: logged loudly, and carried back to the caller. */
function failed(
	relativePath: string,
	start: number,
	error: string,
	where: { src: string; dst: string },
): CloneResult {
	log.error("Clone path copy failed — it is missing from the worktree", {
		path: relativePath,
		...where,
		error,
	});
	return {
		path: relativePath,
		method: "copy",
		durationMs: Math.round(performance.now() - start),
		error,
	};
}

/**
 * Well-known paths that are typically gitignored but needed in worktrees.
 * Covers most popular ecosystems. Only paths that actually exist in the
 * project root will be auto-detected.
 */
export const WELL_KNOWN_CLONE_PATHS = [
	// JavaScript / TypeScript (npm, yarn, pnpm, bun)
	"node_modules",
	".yarn/cache",
	".pnp.cjs",
	".pnp.loader.mjs",

	// Python
	".venv",
	"venv",
	".tox",
	"__pycache__",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",

	// Ruby
	"vendor/bundle",
	".bundle",

	// Go
	"vendor",

	// Rust
	"target",

	// Java / Kotlin / Gradle / Maven
	".gradle",
	"build",
	".m2/repository",

	// C / C++
	"build",
	"cmake-build-debug",
	"cmake-build-release",

	// .NET / C#
	"bin",
	"obj",

	// PHP (Composer)
	"vendor",

	// Elixir
	"_build",
	"deps",

	// Dart / Flutter
	".dart_tool",
	".pub-cache",

	// iOS / macOS
	"Pods",
	".build",

	// Environment & secrets
	// A root .npmrc usually carries a private registry or a token, so it is
	// gitignored — without it a worktree installs against the public registry.
	".npmrc",
	".env",
	".env.local",
	".env.development.local",
	".env.production.local",

	// Build outputs
	"dist",
	"out",
	".next",
	".nuxt",
	".output",
	".svelte-kit",
	".parcel-cache",
	".turbo",
	".cache",

	// IDE / tooling caches
	".eslintcache",
	".stylelintcache",
	".prettiercache",
];

/**
 * Scan a project directory and return the subset of WELL_KNOWN_CLONE_PATHS
 * that actually exist. Used to auto-populate clonePaths when adding a project.
 */
export async function detectClonePaths(projectPath: string): Promise<string[]> {
	// Deduplicate the well-known list (some entries appear for multiple ecosystems)
	const unique = [...new Set(WELL_KNOWN_CLONE_PATHS)];

	const checks = await Promise.all(
		unique.map(async (p) => {
			const exists = await pathExists(`${projectPath}/${p}`);
			return { path: p, exists };
		}),
	);

	const detected = checks.filter((c) => c.exists).map((c) => c.path);
	log.info("Auto-detected clone paths", { projectPath, detected });
	return detected;
}

/**
 * Clone multiple paths from sourceRoot to destRoot using CoW when available.
 * Paths are processed in parallel, bounded by MAX_CONCURRENT_CLONES.
 */
export async function clonePaths(
	sourceRoot: string,
	destRoot: string,
	paths: string[],
): Promise<CloneResult[]> {
	if (paths.length === 0) return [];

	log.info("Starting CoW clone", {
		sourceRoot,
		destRoot,
		paths,
		platform: process.platform,
	});

	// Validate all paths first
	for (const p of paths) {
		validatePath(p);
	}

	// Expand glob patterns into concrete paths
	const expandedPaths: string[] = [];
	for (const p of paths) {
		if (isGlob(p)) {
			const matches = await expandGlob(sourceRoot, p);
			expandedPaths.push(...matches);
		} else {
			expandedPaths.push(p);
		}
	}

	// Deduplicate expanded paths
	const uniquePaths = [...new Set(expandedPaths)];

	const results = await Promise.all(
		uniquePaths.map((p) => cloneSingle(sourceRoot, destRoot, p)),
	);

	const totalMs = results.reduce((sum, r) => Math.max(sum, r.durationMs), 0);
	const failures = results.filter((r) => r.error);
	log.info("CoW clone complete", {
		totalMs,
		failed: failures.length,
		results: results.map((r) => {
			if (r.error) return `${r.path}: FAILED (${r.error})`;
			return `${r.path}: ${r.method} (${r.durationMs}ms${r.skipped ? ", skipped" : ""})`;
		}),
	});
	if (failures.length > 0) {
		log.error("CoW clone finished with missing paths", {
			destRoot,
			failed: failures.map((r) => `${r.path}: ${r.error}`),
		});
	}

	return results;
}
