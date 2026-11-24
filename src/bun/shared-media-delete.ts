import { statSync, unlinkSync } from "node:fs";
import type { Project, SharedImage, SharedMediaDeleteSummary, Task } from "../shared/types";
import { isDeletableSharedMedia, taskSharedMedia } from "../shared/types";
import { isStoredSharedMediaPath } from "./shared-media-stream";

/**
 * User-initiated deletion of stored `dev3 show-media` clips to free disk. The
 * record stays as a tombstone (`removedAt`); only the stored file is unlinked —
 * never a directory, never a rename (AGENTS.md on-disk invariants).
 * decisions/2026/11/24/delete-large-shared-media.md
 */

export interface SharedMediaDeletePlanItem {
	id: string;
	storedPath: string;
	bytes: number;
	/** What unlinking frees: 0 when the stored file is most likely an APFS clone of a live original. */
	freeableBytes: number;
}

export class SharedMediaDeleteError extends Error {}

type StatFn = (path: string) => { size: number; mtimeMs: number; dev: number; isFile(): boolean } | null;

const safeStat: StatFn = (path) => {
	try {
		return statSync(path);
	} catch {
		return null;
	}
};

// mtime is second-granular on some filesystems; a render finished just before the show is still "unchanged".
const MTIME_SLACK_MS = 5000;

/**
 * Bun's copyFile clones on APFS, so a stored clip whose original still sits on the
 * same volume, same size and untouched since the show shares its blocks: deleting
 * our copy frees ~0. Measured 46/46 on real data (F_LOG2PHYS), see the decision.
 */
export function freeableBytes(item: Pick<SharedImage, "storedPath" | "originalPath" | "bytes" | "createdAt">, stat: StatFn = safeStat, platform: NodeJS.Platform = process.platform): number {
	const stored = stat(item.storedPath);
	if (!stored) return 0;
	if (platform !== "darwin") return stored.size;
	const original = stat(item.originalPath);
	const liveClone = original !== null && original.isFile() && original.dev === stored.dev && original.size === stored.size && original.mtimeMs <= item.createdAt + MTIME_SLACK_MS;
	return liveClone ? 0 : stored.size;
}

/**
 * Resolves the ids against the task's own records — the renderer never names a
 * path. Refuses anything that is not a live clip, not inside a shared-images pool,
 * or referenced by another record in the project.
 */
export function planSharedMediaDelete(task: Task, allTasks: Task[], mediaIds: string[], stat: StatFn = safeStat): SharedMediaDeletePlanItem[] {
	if (mediaIds.length === 0) throw new SharedMediaDeleteError("No media ids given");
	const byId = new Map(taskSharedMedia(task).map((item) => [item.id, item]));
	const plan: SharedMediaDeletePlanItem[] = [];
	for (const id of new Set(mediaIds)) {
		const item = byId.get(id);
		if (!item) throw new SharedMediaDeleteError(`Media not found on task: ${id}`);
		if (!isDeletableSharedMedia(item)) throw new SharedMediaDeleteError(`Not a deletable clip: ${id}`);
		if (!isStoredSharedMediaPath(item.storedPath)) throw new SharedMediaDeleteError(`Refusing a path outside the shared media pool: ${id}`);
		const sharers = allTasks.flatMap((other) => taskSharedMedia(other)).filter((rec) => rec.storedPath === item.storedPath && rec.id !== item.id && !rec.removedAt);
		if (sharers.length > 0) throw new SharedMediaDeleteError(`Stored file is shared with another record: ${id}`);
		plan.push({ id, storedPath: item.storedPath, bytes: item.bytes, freeableBytes: freeableBytes(item, stat) });
	}
	return plan;
}

function tombstone(list: SharedImage[] | undefined, marks: Map<string, { removedAt: number; removedBytes: number }>): SharedImage[] | undefined {
	return list?.map((item) => {
		const mark = marks.get(item.id);
		return mark ? { ...item, ...mark } : item;
	});
}

function revive(list: SharedImage[] | undefined, ids: Set<string>): SharedImage[] | undefined {
	return list?.map((item) => {
		if (!ids.has(item.id)) return item;
		const { removedAt: _removedAt, removedBytes: _removedBytes, ...rest } = item;
		return rest;
	});
}

export interface SharedMediaDeletePorts {
	loadTasks(project: Project): Promise<Task[]>;
	updateTaskWith<T>(project: Project, taskId: string, mutator: (task: Task) => { updates: Partial<Task>; result: T }): Promise<{ task: Task; result: T }>;
	unlink?: (path: string) => void;
	stat?: StatFn;
	now?: () => number;
}

const defaultUnlink = (path: string) => {
	try {
		unlinkSync(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
};

/**
 * Marks first, then unlinks: a crash in between leaves a tombstone over a file
 * still on disk, never a live record without its file. A failed unlink (Windows
 * holds a file a player has open) revives that record so the user can retry.
 */
export async function deleteSharedMedia(
	project: Project,
	taskId: string,
	mediaIds: string[],
	ports: SharedMediaDeletePorts,
): Promise<{ task: Task; summary: SharedMediaDeleteSummary }> {
	const unlink = ports.unlink ?? defaultUnlink;
	const allTasks = await ports.loadTasks(project);
	const now = (ports.now ?? Date.now)();
	const { task: marked, result: plan } = await ports.updateTaskWith(project, taskId, (current) => {
		const items = planSharedMediaDelete(current, allTasks, mediaIds, ports.stat);
		const marks = new Map(items.map((item) => [item.id, { removedAt: now, removedBytes: item.freeableBytes }]));
		const updates: Partial<Task> = {};
		if (current.sharedVideos) updates.sharedVideos = tombstone(current.sharedVideos, marks);
		if (current.sharedAudio) updates.sharedAudio = tombstone(current.sharedAudio, marks);
		return { updates, result: items };
	});

	const failed: SharedMediaDeleteSummary["failed"] = [];
	for (const item of plan) {
		try {
			unlink(item.storedPath);
		} catch (err) {
			failed.push({ id: item.id, reason: err instanceof Error ? err.message : String(err) });
		}
	}
	let task = marked;
	if (failed.length > 0) {
		const ids = new Set(failed.map((f) => f.id));
		({ task } = await ports.updateTaskWith(project, taskId, (current) => {
			const updates: Partial<Task> = {};
			if (current.sharedVideos) updates.sharedVideos = revive(current.sharedVideos, ids);
			if (current.sharedAudio) updates.sharedAudio = revive(current.sharedAudio, ids);
			return { updates, result: undefined };
		}));
	}
	const done = plan.filter((item) => !failed.some((f) => f.id === item.id));
	return {
		task,
		summary: {
			count: done.length,
			bytes: done.reduce((sum, item) => sum + item.bytes, 0),
			freeableBytes: done.reduce((sum, item) => sum + item.freeableBytes, 0),
			failed,
		},
	};
}

/** Dry run for the confirmation dialog: what would be deleted and freed, nothing touched. */
export async function previewSharedMediaDelete(project: Project, taskId: string, mediaIds: string[], loadTasks: (project: Project) => Promise<Task[]>, stat: StatFn = safeStat): Promise<SharedMediaDeleteSummary> {
	const allTasks = await loadTasks(project);
	const task = allTasks.find((candidate) => candidate.id === taskId);
	if (!task) throw new SharedMediaDeleteError(`Task not found: ${taskId}`);
	const plan = planSharedMediaDelete(task, allTasks, mediaIds, stat);
	return {
		count: plan.length,
		bytes: plan.reduce((sum, item) => sum + item.bytes, 0),
		freeableBytes: plan.reduce((sum, item) => sum + item.freeableBytes, 0),
		failed: [],
	};
}
