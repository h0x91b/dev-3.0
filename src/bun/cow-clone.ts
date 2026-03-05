/**
 * Copy-on-Write directory/file cloning.
 *
 * macOS cascade: clonefile(2) via FFI → cp -cR → cp -R
 * Linux cascade: cp -R --reflink=always → cp -R
 *
 * All paths are cloned in parallel.
 */

import { createLogger } from "./logger";
import { spawn } from "./spawn";

const log = createLogger("cow-clone");

export type CloneMethod = "clonefile" | "apfs-clone" | "reflink" | "copy";

export interface CloneResult {
	path: string;
	method: CloneMethod;
	durationMs: number;
	skipped?: boolean;
	error?: string;
}

function isMacOS(): boolean {
	return process.platform === "darwin";
}

/** Validate a relative path — reject traversal and absolute paths. */
function validatePath(p: string): void {
	if (p.startsWith("/")) {
		throw new Error(`Absolute path not allowed: ${p}`);
	}
	const segments = p.split("/");
	for (const seg of segments) {
		if (seg === "..") {
			throw new Error(`Path traversal not allowed: ${p}`);
		}
	}
}

/** Remove a path (rm -rf), ignoring errors. */
async function removePath(fullPath: string): Promise<void> {
	try {
		const proc = spawn(["rm", "-rf", fullPath]);
		await proc.exited;
	} catch {
		// best-effort
	}
}

/** Ensure parent directory exists. */
async function ensureParent(fullPath: string): Promise<void> {
	const parent = fullPath.slice(0, fullPath.lastIndexOf("/"));
	if (parent) {
		const proc = spawn(["mkdir", "-p", parent]);
		await proc.exited;
	}
}

/** Check if a path exists. */
async function pathExists(fullPath: string): Promise<boolean> {
	try {
		const proc = spawn(["test", "-e", fullPath]);
		const code = await proc.exited;
		return code === 0;
	} catch {
		return false;
	}
}

/** Run a command and return exit code. */
async function run(cmd: string[]): Promise<number> {
	const proc = spawn(cmd);
	return await proc.exited;
}

/**
 * Try clonefile(2) syscall via Bun FFI.
 * Returns true on success, false on failure.
 */
async function tryClonefile(src: string, dst: string): Promise<boolean> {
	try {
		const { dlopen, FFIType } = await import("bun:ffi");
		const lib = dlopen("libSystem.B.dylib", {
			clonefile: {
				args: [FFIType.cstring, FFIType.cstring, FFIType.u32],
				returns: FFIType.i32,
			},
		});
		const srcBuf = Buffer.from(src + "\0", "utf-8");
		const dstBuf = Buffer.from(dst + "\0", "utf-8");
		const result = lib.symbols.clonefile(srcBuf, dstBuf, 0);
		lib.close();
		return result === 0;
	} catch (err) {
		log.debug("clonefile FFI failed", { error: String(err) });
		return false;
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

	// Prepare destination
	await ensureParent(dst);
	await removePath(dst);

	if (isMacOS()) {
		// 1. Try clonefile(2) — atomic whole-tree clone
		if (await tryClonefile(src, dst)) {
			const ms = Math.round(performance.now() - start);
			log.info("Cloned via clonefile(2)", { path: relativePath, ms });
			return { path: relativePath, method: "clonefile", durationMs: ms };
		}

		// 2. Try cp -cR (per-file APFS clone)
		if ((await run(["cp", "-cR", src, dst])) === 0) {
			const ms = Math.round(performance.now() - start);
			log.info("Cloned via cp -cR", { path: relativePath, ms });
			return { path: relativePath, method: "apfs-clone", durationMs: ms };
		}
		await removePath(dst);
	} else {
		// Linux: try reflink
		if ((await run(["cp", "-R", "--reflink=always", src, dst])) === 0) {
			const ms = Math.round(performance.now() - start);
			log.info("Cloned via reflink", { path: relativePath, ms });
			return { path: relativePath, method: "reflink", durationMs: ms };
		}
		await removePath(dst);
	}

	// Fallback: regular copy
	await run(["cp", "-R", src, dst]);
	const ms = Math.round(performance.now() - start);
	log.info("Copied via cp -R", { path: relativePath, ms });
	return { path: relativePath, method: "copy", durationMs: ms };
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
	"packages",

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
 * All paths are processed in parallel.
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

	const results = await Promise.all(
		paths.map((p) => cloneSingle(sourceRoot, destRoot, p)),
	);

	const totalMs = results.reduce((sum, r) => Math.max(sum, r.durationMs), 0);
	log.info("CoW clone complete", {
		totalMs,
		results: results.map((r) => `${r.path}: ${r.method} (${r.durationMs}ms${r.skipped ? ", skipped" : ""})`),
	});

	return results;
}
