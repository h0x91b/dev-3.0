/**
 * Large media in the per-project pools dev3 copies into on every publish:
 * `shared-images/` (`dev3 show-image` / `show-media`), `shared-artifacts/<id>/`
 * and `uploads/`. Nothing ever removed these; `--prune-media-older-than` and the
 * daily cleanup do, for files over {@link MEDIA_PRUNE_MIN_BYTES} no open task
 * references. Stored artifact ZIPs (written before downloads built them on demand)
 * repeat their assets and go sooner, under `--prune-bundles-older-than`.
 * decisions/2026/11/12/prune-large-shared-media.md
 */

import { dirname, extname, join, sep } from "node:path";
import { allProjectWorktreesRoots } from "../../shared/project-storage";
import { SHARED_IMAGE_EXTS, SHARED_VIDEO_EXTS } from "../../shared/types/shared-media";
import { readProjects, readTasks, TERMINAL_STATUSES, type RawTask, type WorktreeScanDeps } from "./doctor-worktrees";

export const MEDIA_PRUNE_MIN_BYTES = 5 * 1024 * 1024;
/** How long large media outlives its last write before the daily cleanup takes it. */
export const MEDIA_RETENTION_DAYS = 60;
/** Stored download ZIPs: only older app versions still read them. */
export const BUNDLE_RETENTION_DAYS = 30;

/** Age per kind; null leaves that kind alone. */
export interface MediaPrunePolicy {
	mediaDays: number | null;
	bundleDays: number | null;
}
export const MEDIA_POOLS = ["shared-images", "shared-artifacts", "uploads"] as const;
export type MediaPool = (typeof MEDIA_POOLS)[number];
export type MediaKind = "image" | "video" | "bundle";

const DAY_MS = 24 * 60 * 60 * 1000;
const IMAGE_EXTS = new Set(SHARED_IMAGE_EXTS);
const VIDEO_EXTS = new Set([...SHARED_VIDEO_EXTS, "mov", "m4v", "mkv"]);

export type MediaScanDeps = Pick<WorktreeScanDeps, "dev3Home" | "now" | "readFile" | "exists" | "listDirs" | "remove" | "walkFiles">;

export interface MediaEntry {
	path: string;
	pool: MediaPool;
	kind: MediaKind;
	bytes: number;
	ageDays: number;
	/** An open task's record points at this file (or at its artifact): never pruned. */
	heldByOpenTask: boolean;
}

export interface MediaReport {
	/** Large media only — files at or over {@link MEDIA_PRUNE_MIN_BYTES}. */
	entries: MediaEntry[];
	totalBytes: number;
	pools: string[];
}

export interface MediaPruneOutcome {
	path: string;
	action: "removed" | "failed";
	freedBytes: number;
	reason?: string;
}

function mediaKind(path: string, pool: MediaPool): MediaKind | null {
	const ext = extname(path).slice(1).toLowerCase();
	if (IMAGE_EXTS.has(ext)) return "image";
	if (VIDEO_EXTS.has(ext)) return "video";
	// The download ZIP repeats every asset of the artifact a second time.
	if (ext === "zip" && pool === "shared-artifacts") return "bundle";
	return null;
}

function poolDirs(deps: MediaScanDeps): Array<{ dir: string; pool: MediaPool }> {
	const parents = new Set<string>();
	const homeRoot = `${deps.dev3Home}/worktrees`;
	if (deps.exists(homeRoot)) {
		try {
			for (const slug of deps.listDirs(homeRoot)) parents.add(join(homeRoot, slug));
		} catch {
			/* unreadable root contributes nothing */
		}
	}
	for (const project of readProjects(deps)) {
		if (project.kind === "virtual" || !project.path) continue;
		for (const root of allProjectWorktreesRoots(deps.dev3Home, project.path)) parents.add(root);
	}
	const out: Array<{ dir: string; pool: MediaPool }> = [];
	for (const parent of [...parents].sort()) {
		for (const pool of MEDIA_POOLS) {
			const dir = join(parent, pool);
			if (deps.exists(dir)) out.push({ dir, pool });
		}
	}
	return out;
}

/** Files and artifact dirs an open task still shows, plus its description for upload paths. */
function openTaskHolds(deps: MediaScanDeps): { files: Set<string>; artifactDirs: Set<string>; descriptions: string[] } {
	const files = new Set<string>();
	const artifactDirs = new Set<string>();
	const descriptions: string[] = [];
	const seen = new Set<string>();
	for (const project of readProjects(deps)) {
		for (const task of readTasks(deps, project) as RawTask[]) {
			if (!task.id || seen.has(task.id)) continue;
			seen.add(task.id);
			if (TERMINAL_STATUSES.has(task.status ?? "")) continue;
			for (const media of [...(task.sharedImages ?? []), ...(task.sharedVideos ?? []), ...(task.sharedAudio ?? [])]) {
				if (media?.storedPath) files.add(media.storedPath);
			}
			for (const artifact of task.sharedArtifacts ?? []) {
				if (artifact?.storedPath) artifactDirs.add(dirname(artifact.storedPath));
			}
			if (task.description) descriptions.push(task.description);
		}
	}
	return { files, artifactDirs, descriptions };
}

function isHeld(path: string, pool: MediaPool, holds: ReturnType<typeof openTaskHolds>): boolean {
	if (holds.files.has(path)) return true;
	if (pool === "shared-artifacts") {
		for (const dir of holds.artifactDirs) if (path.startsWith(`${dir}${sep}`) || path.startsWith(`${dir}/`)) return true;
	}
	if (pool === "uploads") return holds.descriptions.some((text) => text.includes(path));
	return false;
}

export function collectMediaReport(deps: MediaScanDeps): MediaReport {
	const holds = openTaskHolds(deps);
	const pools = poolDirs(deps);
	const entries: MediaEntry[] = [];
	for (const { dir, pool } of pools) {
		for (const file of deps.walkFiles(dir)) {
			if (file.bytes < MEDIA_PRUNE_MIN_BYTES) continue;
			const kind = mediaKind(file.path, pool);
			if (!kind) continue;
			entries.push({
				path: file.path,
				pool,
				kind,
				bytes: file.bytes,
				ageDays: Math.max(0, Math.floor((deps.now - file.changedMs) / DAY_MS)),
				heldByOpenTask: isHeld(file.path, pool, holds),
			});
		}
	}
	entries.sort((a, b) => b.bytes - a.bytes);
	return { entries, totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0), pools: pools.map((p) => p.dir) };
}

export function mediaPruneSelects(entry: MediaEntry, policy: MediaPrunePolicy): boolean {
	const days = entry.kind === "bundle" ? policy.bundleDays : policy.mediaDays;
	return days !== null && !entry.heldByOpenTask && entry.ageDays >= days;
}

export function pruneMedia(report: MediaReport, policy: MediaPrunePolicy, deps: Pick<MediaScanDeps, "remove">): MediaPruneOutcome[] {
	const outcomes: MediaPruneOutcome[] = [];
	for (const entry of report.entries) {
		if (!mediaPruneSelects(entry, policy)) continue;
		try {
			deps.remove(entry.path);
			outcomes.push({ path: entry.path, action: "removed", freedBytes: entry.bytes });
		} catch (err) {
			outcomes.push({ path: entry.path, action: "failed", freedBytes: 0, reason: (err as Error).message });
		}
	}
	return outcomes;
}
