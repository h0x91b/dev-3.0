/**
 * Copy-on-write cloning of directories and files into worktrees.
 *
 * Clone cascade by platform:
 *   macOS: clonefile() syscall (FFI) → cp -cR (per-file APFS clone) → cp -R
 *   Linux: cp -R --reflink=always (btrfs/xfs) → cp -R
 *   Other: cp -R
 *
 * clonefile(2) clones an entire directory tree atomically in one syscall,
 * ~10x faster than cp -cR which walks the tree file-by-file.
 */

import { createLogger } from "./logger";
import { spawn } from "./spawn";

const log = createLogger("clone");

const IS_MACOS = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

// ---- Bun FFI: macOS clonefile() ----

export type ClonefileFn = (src: string, dst: string) => boolean;
let clonefileFn: ClonefileFn | null = null;

if (IS_MACOS) {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { dlopen, FFIType } = require("bun:ffi");
		const lib = dlopen("libc.dylib", {
			clonefile: {
				args: [FFIType.cstring, FFIType.cstring, FFIType.u32],
				returns: FFIType.i32,
			},
		});
		clonefileFn = (src: string, dst: string): boolean => {
			return lib.symbols.clonefile(src, dst, 0) === 0;
		};
		log.info("clonefile() FFI loaded successfully");
	} catch (err) {
		log.warn("Failed to load clonefile() FFI, will use cp -cR fallback", {
			error: String(err),
		});
	}
}

/** Test-only: override the clonefile function for testing the FFI path. */
export function _setClonefileFn(fn: ClonefileFn | null): void {
	clonefileFn = fn;
}

// ---- Path validation ----

export function validateClonePath(p: string): string | null {
	if (p.startsWith("/")) return "absolute paths not allowed";
	if (p.includes("..")) return 'paths containing ".." not allowed';
	return null;
}

function sanitizePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of paths) {
		const p = raw.trim();
		if (!p) continue;
		const err = validateClonePath(p);
		if (err) {
			log.warn(`Skipping invalid clone path "${p}": ${err}`);
			continue;
		}
		if (seen.has(p)) continue;
		seen.add(p);
		result.push(p);
	}
	return result;
}

// ---- Single-path clone ----

export type CloneMethod = "clonefile" | "apfs-cp" | "reflink" | "copy";

export interface CloneResult {
	path: string;
	ok: boolean;
	method: CloneMethod;
	durationMs: number;
	error?: string;
	skipped?: boolean;
}

async function pathExists(fullPath: string): Promise<boolean> {
	try {
		const proc = spawn(["test", "-e", fullPath], { stdout: "pipe", stderr: "pipe" });
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

async function ensureParentDir(path: string): Promise<void> {
	const parent = path.slice(0, path.lastIndexOf("/"));
	if (parent) {
		const proc = spawn(["mkdir", "-p", parent]);
		await proc.exited;
	}
}

async function runCp(args: string[]): Promise<{ ok: boolean; stderr: string }> {
	const proc = spawn(["cp", ...args], { stdout: "pipe", stderr: "pipe" });
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	return { ok: code === 0, stderr: stderr.trim() };
}

async function cleanupDst(dst: string): Promise<void> {
	try {
		const proc = spawn(["rm", "-rf", dst], { stdout: "pipe", stderr: "pipe" });
		await proc.exited;
	} catch {
		// ignore cleanup errors
	}
}

export async function cloneSingle(
	srcRoot: string,
	dstRoot: string,
	relPath: string,
): Promise<CloneResult> {
	const src = `${srcRoot}/${relPath}`;
	const dst = `${dstRoot}/${relPath}`;
	const start = performance.now();

	// Check source exists
	if (!(await pathExists(src))) {
		return {
			path: relPath,
			ok: true,
			method: "copy",
			durationMs: performance.now() - start,
			skipped: true,
		};
	}

	await ensureParentDir(dst);

	// macOS cascade: clonefile() → cp -cR → cp -R
	if (IS_MACOS) {
		// 1. Try clonefile() syscall (atomic whole-tree clone)
		if (clonefileFn) {
			try {
				if (clonefileFn(src, dst)) {
					return {
						path: relPath,
						ok: true,
						method: "clonefile",
						durationMs: performance.now() - start,
					};
				}
			} catch (err) {
				log.debug(`clonefile() threw for ${relPath}`, { error: String(err) });
			}
			await cleanupDst(dst);
		}

		// 2. Try cp -cR (per-file APFS clone)
		const cow = await runCp(["-cR", src, dst]);
		if (cow.ok) {
			return {
				path: relPath,
				ok: true,
				method: "apfs-cp",
				durationMs: performance.now() - start,
			};
		}
		log.debug(`cp -cR failed for ${relPath}`, { stderr: cow.stderr });
		await cleanupDst(dst);
	}

	// Linux cascade: reflink → cp -R
	if (IS_LINUX) {
		const ref = await runCp(["-R", "--reflink=always", src, dst]);
		if (ref.ok) {
			return {
				path: relPath,
				ok: true,
				method: "reflink",
				durationMs: performance.now() - start,
			};
		}
		log.debug(`reflink failed for ${relPath}`, { stderr: ref.stderr });
		await cleanupDst(dst);
	}

	// Fallback: regular copy
	const reg = await runCp(["-R", src, dst]);
	return {
		path: relPath,
		ok: reg.ok,
		method: "copy",
		durationMs: performance.now() - start,
		error: reg.ok ? undefined : reg.stderr,
	};
}

// ---- Main entry point ----

export async function clonePathsToWorktree(
	projectPath: string,
	worktreePath: string,
	clonePaths: string[],
): Promise<CloneResult[]> {
	const paths = sanitizePaths(clonePaths);
	if (paths.length === 0) return [];

	log.info("Cloning paths to worktree", {
		count: paths.length,
		paths,
		from: projectPath,
		to: worktreePath,
	});

	const start = performance.now();

	// Clone all paths in parallel
	const settled = await Promise.allSettled(
		paths.map((p) => cloneSingle(projectPath, worktreePath, p)),
	);

	const results: CloneResult[] = [];
	const errors: string[] = [];

	for (const s of settled) {
		if (s.status === "fulfilled") {
			results.push(s.value);
			if (!s.value.ok) {
				errors.push(`${s.value.path}: ${s.value.error || "unknown error"}`);
			}
		} else {
			const errMsg = String(s.reason);
			errors.push(`unexpected: ${errMsg}`);
			results.push({
				path: "unknown",
				ok: false,
				method: "copy",
				durationMs: 0,
				error: errMsg,
			});
		}
	}

	const totalMs = Math.round(performance.now() - start);
	const cloned = results.filter((r) => r.ok && !r.skipped);
	const skipped = results.filter((r) => r.skipped);

	log.info(`Clone complete in ${totalMs}ms`, {
		cloned: cloned.length,
		skipped: skipped.length,
		errors: errors.length,
		details: cloned.map((r) => `${r.path} (${r.method}, ${Math.round(r.durationMs)}ms)`),
	});

	if (errors.length > 0) {
		log.warn("Some clone paths failed", { errors });
	}

	return results;
}
