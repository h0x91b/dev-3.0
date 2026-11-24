import { existsSync } from "node:fs";
import type { Project, SharedImage, Task } from "../shared/types";
import { dueSharedMediaIds, isDeletableSharedMedia } from "../shared/types";
import { deleteSharedMedia, SharedMediaDeleteError, type SharedMediaDeletePorts } from "./shared-media-delete";

/**
 * The daily retention pass over closed tasks' show-media clips: tiers by rank since
 * the close, 60 days by show time, pins and open tasks never. Runs on the host
 * before the cleanup worker, so every removal leaves a tombstone, not a dead record.
 * decisions/2026/11/24/shared-media-retention-tiers.md
 */

export interface SharedMediaRetentionDeps extends Omit<SharedMediaDeletePorts, "now" | "guard"> {
	loadProjects(): Promise<Project[]>;
	loadTasks(project: Project): Promise<Task[]>;
	now(): number;
	onTaskUpdated?: (project: Project, task: Task) => void;
	exists?: (path: string) => boolean;
}

export interface SharedMediaRetentionResult {
	removed: number;
	freedBytes: number;
	/** Refused by the delete's own checks (shared file, outside this project's pool): left alone, not an error. */
	skipped: number;
	/** The unlink itself failed. */
	failed: number;
}

const CLOSED = new Set(["completed", "cancelled"]);

/**
 * The snapshot that picked the ids can be stale by the time the lock is held: the
 * task may have been reopened, or a clip pinned. Re-decide on the locked task.
 */
function stillDue(now: number) {
	return (current: Task, mediaIds: string[]): string[] => {
		if (!CLOSED.has(current.status)) return [];
		const due = new Set(dueSharedMediaIds(current, now));
		return mediaIds.filter((id) => due.has(id));
	};
}

type Outcome = { task: Task; removed: number; freedBytes: number; skipped: number; failed: number };

/** One delete call per clip after a batch refusal, so one refused record cannot shield the rest. */
async function deleteDue(project: Project, task: Task, ids: string[], deps: SharedMediaRetentionDeps, now: number): Promise<Outcome> {
	try {
		const { task: updated, summary } = await deleteSharedMedia(project, task.id, ids, { ...deps, now: () => now, guard: stillDue(now) });
		return { task: updated, removed: summary.count, freedBytes: summary.freeableBytes, skipped: 0, failed: summary.failed.length };
	} catch (err) {
		if (!(err instanceof SharedMediaDeleteError)) return { task, removed: 0, freedBytes: 0, skipped: 0, failed: ids.length };
		if (ids.length === 1) return { task, removed: 0, freedBytes: 0, skipped: 1, failed: 0 };
	}
	const total: Outcome = { task, removed: 0, freedBytes: 0, skipped: 0, failed: 0 };
	for (const id of ids) {
		const one = await deleteDue(project, total.task, [id], deps, now);
		total.task = one.task;
		total.removed += one.removed;
		total.freedBytes += one.freedBytes;
		total.skipped += one.skipped;
		total.failed += one.failed;
	}
	return total;
}

export async function runSharedMediaRetention(deps: SharedMediaRetentionDeps): Promise<SharedMediaRetentionResult> {
	const result: SharedMediaRetentionResult = { removed: 0, freedBytes: 0, skipped: 0, failed: 0 };
	const now = deps.now();
	for (const project of await deps.loadProjects()) {
		for (const task of await deps.loadTasks(project)) {
			if (!CLOSED.has(task.status)) continue;
			const due = dueSharedMediaIds(task, now);
			if (due.length === 0) continue;
			const outcome = await deleteDue(project, task, due, deps, now);
			result.removed += outcome.removed;
			result.freedBytes += outcome.freedBytes;
			result.skipped += outcome.skipped;
			result.failed += outcome.failed;
			if (outcome.removed > 0) deps.onTaskUpdated?.(project, outcome.task);
		}
	}
	return result;
}

/**
 * After the file prune: a clip whose stored file the worker reports it unlinked
 * becomes a tombstone, so the viewer says "Removed to free space". A file that is
 * merely missing (unmounted volume, moved repo) is left alone.
 */
export async function tombstonePrunedClips(deps: SharedMediaRetentionDeps, prunedPaths: readonly string[]): Promise<number> {
	if (prunedPaths.length === 0) return 0;
	const pruned = new Set(prunedPaths);
	const exists = deps.exists ?? existsSync;
	const now = deps.now();
	const isPruned = (item: SharedImage) => isDeletableSharedMedia(item) && pruned.has(item.storedPath) && !exists(item.storedPath);
	let count = 0;
	for (const project of await deps.loadProjects()) {
		for (const task of await deps.loadTasks(project)) {
			if (![...(task.sharedVideos ?? []), ...(task.sharedAudio ?? [])].some(isPruned)) continue;
			const { task: updated, result: marked } = await deps.updateTaskWith(project, task.id, (current) => {
				let n = 0;
				const mark = (list: SharedImage[] | undefined) =>
					list?.map((item) => {
						if (!isPruned(item)) return item;
						n += 1;
						return { ...item, removedAt: now, removedBytes: item.bytes };
					});
				const updates: Partial<Task> = {};
				if (current.sharedVideos) updates.sharedVideos = mark(current.sharedVideos);
				if (current.sharedAudio) updates.sharedAudio = mark(current.sharedAudio);
				return { updates, result: n };
			});
			count += marked;
			if (marked > 0) deps.onTaskUpdated?.(project, updated);
		}
	}
	return count;
}
