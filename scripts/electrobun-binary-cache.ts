/**
 * Machine-level cache of the binaries electrobun downloads from GitHub.
 *
 * Electrobun keeps its CLI and core binaries inside `node_modules/electrobun`, so
 * a `bun install` that re-extracts the package deletes them and every fresh
 * worktree downloads them again — or cannot build at all while GitHub is down.
 * This snapshots what a successful build left behind and puts it back where it is
 * missing. Why a snapshot and not our own downloader:
 * `decisions/2026/11/08/electrobun-binary-cache.md`.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveUserHome } from "../src/shared/user-home";

/** Versions kept per artifact kind; storing a newer one drops the least recently used. */
export const KEPT_VERSIONS = 3;

const CACHE_DIR_NAME = "dev3-electrobun";
const CLI_BINARIES = ["bin/electrobun", "bin/electrobun.exe"];
/** `dist-macos-arm64` and friends — not the shared `dist/` that ships in the npm package. */
const PLATFORM_DIST = /^dist-[a-z0-9]+-[a-z0-9]+$/;
const BUN_STAMP = ".bun-version";
const STAGING_MARK = ".staging-";

export interface BinaryCacheLayout {
	/** `node_modules` of the checkout being built. */
	nodeModules: string;
	/** Shared by every checkout on the machine. */
	cacheRoot: string;
	/** `<platform>-<arch>` of this machine; binaries are never shared across hosts. */
	host: string;
}

type Warn = (message: string) => void;

export function binaryCacheRoot(env: Record<string, string | undefined>, platform: NodeJS.Platform, home: string): string {
	const override = env.DEV3_ELECTROBUN_CACHE_DIR?.trim();
	if (override) return override;
	if (platform === "darwin") return join(home, "Library", "Caches", CACHE_DIR_NAME);
	if (platform === "win32") return join(env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), CACHE_DIR_NAME);
	return join(env.XDG_CACHE_HOME?.trim() || join(home, ".cache"), CACHE_DIR_NAME);
}

export function binaryCacheLayout(
	repoRoot: string,
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): BinaryCacheLayout {
	return {
		nodeModules: join(repoRoot, "node_modules"),
		cacheRoot: binaryCacheRoot(env, platform, resolveUserHome(env)),
		host: `${platform}-${arch}`,
	};
}

/**
 * Put back whatever this checkout is missing, for exactly the versions it asks for.
 * A version the cache has never seen restores nothing, so electrobun downloads it
 * as it always did. Returns what was restored; never throws.
 */
export function restoreElectrobunBinaries(
	layout: BinaryCacheLayout,
	bunVersion: string | undefined,
	warn: Warn = console.warn,
): string[] {
	const restored: string[] = [];
	try {
		const packageDir = join(layout.nodeModules, "electrobun");
		const version = electrobunVersion(packageDir);
		if (version) {
			const entry = join(layout.cacheRoot, "electrobun", version, layout.host);
			for (const artifact of downloadedArtifacts(entry)) {
				const target = join(packageDir, artifact);
				// Present means electrobun owns it: the cache only ever fills a gap.
				if (existsSync(target)) continue;
				if (place(target, (staging) => copy(join(entry, artifact), staging))) restored.push(artifact);
			}
			if (restored.length > 0) markUsed(dirname(entry));
		}

		const wantedBun = safeVersion(bunVersion);
		if (wantedBun) {
			const cached = join(layout.cacheRoot, "bun-override", wantedBun);
			const overrides = bunOverridesDir(layout);
			for (const target of subdirectories(cached)) {
				const live = join(overrides, target);
				if (bunOverrideVersion(live) === wantedBun) continue;
				// Electrobun deletes a mismatched override itself before re-downloading it.
				rmSync(live, { recursive: true, force: true });
				if (place(live, (staging) => copy(join(cached, target), staging))) {
					restored.push(`bun ${wantedBun} (${target})`);
					markUsed(cached);
				}
			}
		}
	} catch (error) {
		warn(`[electrobun-binary-cache] restore skipped: ${describe(error)}`);
	}
	return restored;
}

/**
 * Snapshot what electrobun downloaded into this checkout. Call it only after a
 * build succeeded — that run is the proof the binaries work. Returns what was
 * newly stored; never throws.
 */
export function storeElectrobunBinaries(layout: BinaryCacheLayout, warn: Warn = console.warn): string[] {
	const stored: string[] = [];
	try {
		const packageDir = join(layout.nodeModules, "electrobun");
		const version = electrobunVersion(packageDir);
		const artifacts = downloadedArtifacts(packageDir);
		// An entry is written once and never amended, so half a set would be restored forever.
		const complete = artifacts.some((a) => CLI_BINARIES.includes(a)) && artifacts.some((a) => PLATFORM_DIST.test(a));
		if (version && complete) {
			const entry = join(layout.cacheRoot, "electrobun", version, layout.host);
			const copyAll = (staging: string) => {
				for (const artifact of artifacts) copy(join(packageDir, artifact), join(staging, artifact));
			};
			if (!existsSync(entry) && place(entry, copyAll)) {
				stored.push(`electrobun ${version}`);
				pruneOldVersions(join(layout.cacheRoot, "electrobun"));
			}
		}

		const overrides = bunOverridesDir(layout);
		for (const target of subdirectories(overrides)) {
			const live = join(overrides, target);
			const liveVersion = bunOverrideVersion(live);
			if (!liveVersion) continue;
			const entry = join(layout.cacheRoot, "bun-override", liveVersion, target);
			if (!existsSync(entry) && place(entry, (staging) => copy(live, staging))) {
				stored.push(`bun ${liveVersion} (${target})`);
				pruneOldVersions(join(layout.cacheRoot, "bun-override"));
			}
		}
	} catch (error) {
		warn(`[electrobun-binary-cache] store skipped: ${describe(error)}`);
	}
	return stored;
}

function bunOverridesDir(layout: BinaryCacheLayout): string {
	return join(layout.nodeModules, ".electrobun-cache", "bun-override");
}

function electrobunVersion(packageDir: string): string | null {
	try {
		return safeVersion(JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")).version);
	} catch {
		return null;
	}
}

/** Electrobun writes the stamp last, so its presence marks a finished download. */
function bunOverrideVersion(overrideDir: string): string | null {
	try {
		return safeVersion(readFileSync(join(overrideDir, BUN_STAMP), "utf-8").trim());
	} catch {
		return null;
	}
}

/** A version becomes a directory name, so anything path-like is refused. */
function safeVersion(version: unknown): string | null {
	if (typeof version !== "string") return null;
	return /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(version) && !version.includes("..") ? version : null;
}

/** What electrobun downloads next to its package files: the CLI and each `dist-<os>-<arch>`. */
function downloadedArtifacts(dir: string): string[] {
	const cli = CLI_BINARIES.filter((artifact) => existsSync(join(dir, artifact)));
	return [...cli, ...subdirectories(dir).filter((name) => PLATFORM_DIST.test(name))];
}

function subdirectories(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.includes(STAGING_MARK))
		.map((entry) => entry.name);
}

function copy(source: string, destination: string): void {
	mkdirSync(dirname(destination), { recursive: true });
	cpSync(source, destination, { recursive: true });
}

/** Build under a sibling temp name, then rename: a reader sees the whole artifact or none of it. */
function place(target: string, fill: (staging: string) => void): boolean {
	const staging = `${target}${STAGING_MARK}${process.pid}`;
	rmSync(staging, { recursive: true, force: true });
	try {
		fill(staging);
		renameSync(staging, target);
		return true;
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		// Losing the rename to another checkout is fine: its copy holds the same bytes.
		if (existsSync(target)) return false;
		throw error;
	}
}

function markUsed(versionDir: string): void {
	const now = new Date();
	utimesSync(versionDir, now, now);
}

function pruneOldVersions(kindDir: string): void {
	const byLastUse = subdirectories(kindDir)
		.map((name) => ({ name, usedAt: statSync(join(kindDir, name)).mtimeMs }))
		.sort((a, b) => b.usedAt - a.usedAt);
	for (const { name } of byLastUse.slice(KEPT_VERSIONS)) rmSync(join(kindDir, name), { recursive: true, force: true });
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
