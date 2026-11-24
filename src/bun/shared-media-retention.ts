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

export interface SharedMediaRetentionDeps extends Omit<SharedMediaDeletePorts, "now"> {
	loadProjects(): Promise<Project[]>;
	loadTasks(project: Project): Promise<Task[]>;
	now(): number;
	onTaskUpdated?: (project: Project, task: Task) => void;
	exists?: (path: string) => boolean;
}

export interface SharedMediaRetentionResult {
	removed: number;
	freedBytes: number;
	tombstoned: number;
	failed: number;
}

const CLOSED = new Set(["completed", "cancelled"]);

/** One delete call per clip after a batch refusal, so one bad record cannot shield the rest. */
async function deleteDue(project: Project, task: Task, ids: string[], deps: SharedMediaRetentionDeps): Promise<{ task: Task; removed: number; freedBytes: number; failed: number }> {
	try {
		const { task: updated, summary } = await deleteSharedMedia(project, task.id, ids, deps);
		return { task: updated, removed: summary.count, freedBytes: summary.freeableBytes, failed: summary.failed.length };
	} catch (err) {
		if (!(err instanceof SharedMediaDeleteError) || ids.length === 1) return { task, removed: 0, freedBytes: 0, failed: ids.length };
	}
	let current = task;
	let removed = 0;
	let freedBytes = 0;
	let failed = 0;
	for (const id of ids) {
		const one = await deleteDue(project, current, [id], deps);
		current = one.task;
		removed += one.removed;
		freedBytes += one.freedBytes;
		failed += one.failed;
	}
	return { task: current, removed, freedBytes, failed };
}

export async function runSharedMediaRetention(deps: SharedMediaRetentionDeps): Promise<SharedMediaRetentionResult> {
	const result: SharedMediaRetentionResult = { removed: 0, freedBytes: 0, tombstoned: 0, failed: 0 };
	const now = deps.now();
	for (const project of await deps.loadProjects()) {
		for (const task of await deps.loadTasks(project)) {
			if (!CLOSED.has(task.status)) continue;
			const due = dueSharedMediaIds(task, now);
			if (due.length === 0) continue;
			const outcome = await deleteDue(project, task, due, deps);
			result.removed += outcome.removed;
			result.freedBytes += outcome.freedBytes;
			result.failed += outcome.failed;
			if (outcome.removed > 0) deps.onTaskUpdated?.(project, outcome.task);
		}
	}
	return result;
}

function markMissing(list: SharedImage[] | undefined, missing: Set<string>, now: number): SharedImage[] | undefined {
	return list?.map((item) => (missing.has(item.id) ? { ...item, removedAt: now, removedBytes: 0 } : item));
}

/**
 * After the file prune: a closed task's clip whose stored file is gone becomes a
 * tombstone, so the viewer says "Removed to free space" rather than "unavailable".
 */
export async function tombstoneMissingClips(deps: SharedMediaRetentionDeps): Promise<number> {
	const exists = deps.exists ?? existsSync;
	const now = deps.now();
	let count = 0;
	for (const project of await deps.loadProjects()) {
		for (const task of await deps.loadTasks(project)) {
			if (!CLOSED.has(task.status)) continue;
			const missing = new Set([...(task.sharedVideos ?? []), ...(task.sharedAudio ?? [])].filter((item) => isDeletableSharedMedia(item) && !exists(item.storedPath)).map((item) => item.id));
			if (missing.size === 0) continue;
			const { task: updated } = await deps.updateTaskWith(project, task.id, (current) => {
				const updates: Partial<Task> = {};
				if (current.sharedVideos) updates.sharedVideos = markMissing(current.sharedVideos, missing, now);
				if (current.sharedAudio) updates.sharedAudio = markMissing(current.sharedAudio, missing, now);
				return { updates, result: undefined };
			});
			count += missing.size;
			deps.onTaskUpdated?.(project, updated);
		}
	}
	return count;
}
