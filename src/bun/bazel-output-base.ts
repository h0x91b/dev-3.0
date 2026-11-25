import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { chmod, readdir, readFile, rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createLogger } from "./logger";
import { getPidCwd, isPidAlive, terminatePidsVerified } from "./process-reaper";

const log = createLogger("bazel-output-base");

/** A Bazel output base and the workspace path its README names. */
export interface BazelOutputBase {
	path: string;
	workspace: string;
}

/** The worktree's output base, via its `bazel-out` symlink or Bazel's md5-of-path naming; null unless its README names this worktree. */
export function findBazelOutputBase(worktreePath: string, outputUserRoots?: string[]): BazelOutputBase | null {
	let names: Set<string>;
	let roots: string[];
	try {
		names = new Set([worktreePath, realpathSync(worktreePath)]);
		roots = outputUserRoots ?? defaultOutputUserRoots();
	} catch {
		return null;
	}
	// bazel-out exists only after a build; a task that only ran query or fetch still has an output base.
	const candidates = [
		outputBaseFromBazelOut(worktreePath),
		...roots.flatMap((root) => [...names].map((name) => join(root, createHash("md5").update(name).digest("hex")))),
	];
	for (const path of candidates) {
		const workspace = path && readmeWorkspace(path);
		if (workspace && names.has(workspace)) return { path, workspace };
	}
	return null;
}

function defaultOutputUserRoots(): string[] {
	const user = `_bazel_${userInfo().username}`;
	return [join("/private/var/tmp", user), join(homedir(), "Library/Caches/bazel", user), join(homedir(), ".cache/bazel", user)];
}

function outputBaseFromBazelOut(worktreePath: string): string | null {
	try {
		const link = join(worktreePath, "bazel-out");
		if (!lstatSync(link).isSymbolicLink()) return null;
		const target = resolve(worktreePath, readlinkSync(link));
		// <output_base>/execroot/<workspace name>/bazel-out
		const execroot = dirname(dirname(target));
		return basename(target) === "bazel-out" && basename(execroot) === "execroot" ? dirname(execroot) : null;
	} catch {
		return null;
	}
}

function readmeWorkspace(outputBase: string): string | null {
	try {
		return readFileSync(join(outputBase, "README"), "utf8").split("\n", 1)[0].replace(/^WORKSPACE: /, "");
	} catch {
		return null;
	}
}

/** Stops the Bazel server still serving the output base, then deletes it. Never throws. */
export async function removeBazelOutputBase(base: BazelOutputBase): Promise<void> {
	try {
		await stopBazelServer(base);
		await makeDirsWritable(base.path);
		await rm(base.path, { recursive: true, force: true });
		log.info("Removed Bazel output base", { path: base.path, workspace: base.workspace });
	} catch (err) {
		log.warn("Could not remove Bazel output base", { path: base.path, error: String(err) });
	}
}

async function stopBazelServer(base: BazelOutputBase): Promise<void> {
	let pid: number;
	try {
		pid = parseInt(await readFile(join(base.path, "server", "server.pid.txt"), "utf8"), 10);
	} catch {
		return;
	}
	if (!pid || !isPidAlive(pid)) return;
	// A stale pid file may name a reused pid; the server always runs from its workspace.
	if (await getPidCwd(pid) !== base.workspace) return;
	await terminatePidsVerified([pid]);
}

/** Bazel leaves read-only directories behind, and their entries cannot be unlinked. */
async function makeDirsWritable(dir: string): Promise<void> {
	await chmod(dir, 0o700);
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) await makeDirsWritable(join(dir, entry.name));
	}
}
