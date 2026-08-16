import { mkdir, readFile } from "node:fs/promises";
import type { Project, Task } from "../shared/types";
import { atomicWriteFile } from "./atomic-write";
import { projectSlug } from "./git";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

const log = createLogger("task-blobs");

/**
 * Cold per-task payload lives in `~/.dev3.0/data/<slug>/task-blobs/<taskId>.json`
 * — a NEW sibling directory of tasks.json (the rule-5 additive parallel-path
 * pattern from AGENTS.md, same shape as automations.json). Older app versions
 * never look inside it, nothing is moved or renamed, and tasks.json stays a
 * fully valid task list for them.
 *
 * Only fields no released version has ever read may live here. Today that is
 * exactly one: the per-file diff breakdown that leaked onto disk through
 * `captureCompletedDiffStats`'s object spread and grew to 5.5 MB of base44's
 * 13.9 MB tasks.json. See the 2026-08-16 decision record.
 */
export interface TaskBlob {
	taskId: string;
	/** ISO time this blob was last written. */
	savedAt: string;
	/**
	 * Per-file diff breakdown captured when the task reached a terminal status.
	 * Archived, never hydrated back onto the Task: no code path reads it.
	 */
	completedDiffFileStats?: TaskDiffFileStat[];
}

export interface TaskDiffFileStat {
	path: string;
	insertions: number;
	deletions: number;
}

export function taskBlobsDir(project: Project): string {
	return `${DEV3_HOME}/data/${projectSlug(project.path)}/task-blobs`;
}

export function taskBlobFile(project: Project, taskId: string): string {
	return `${taskBlobsDir(project)}/${taskId}.json`;
}

/** Read one task's blob. Returns null when absent or unreadable — never throws. */
export async function readTaskBlob(project: Project, taskId: string): Promise<TaskBlob | null> {
	try {
		return JSON.parse(await readFile(taskBlobFile(project, taskId), "utf8")) as TaskBlob;
	} catch (err: any) {
		if (err?.code !== "ENOENT") {
			log.warn("Failed to read task blob", { taskId: taskId.slice(0, 8), error: String(err) });
		}
		return null;
	}
}

/**
 * Merge `patch` into the task's existing blob and write it back. Merging rather
 * than replacing keeps a future second field from clobbering the first, and
 * makes a re-run idempotent.
 */
export async function writeTaskBlob(project: Project, taskId: string, patch: Omit<TaskBlob, "taskId" | "savedAt">): Promise<void> {
	const existing = await readTaskBlob(project, taskId);
	const next: TaskBlob = { ...existing, ...patch, taskId, savedAt: new Date().toISOString() };
	await mkdir(taskBlobsDir(project), { recursive: true });
	await atomicWriteFile(taskBlobFile(project, taskId), JSON.stringify(next));
}

/**
 * Anything on a Task that belongs in its blob rather than in tasks.json. Kept as
 * one predicate so the split rule lives in a single place.
 */
function blobPayloadOf(task: Task): Omit<TaskBlob, "taskId" | "savedAt"> | null {
	const fileStats = withFileStats(task)?.fileStats;
	if (!Array.isArray(fileStats) || fileStats.length === 0) return null;
	return { completedDiffFileStats: fileStats };
}

/**
 * `fileStats` is absent from the {@link CompletedDiffStats} type but present on
 * disk — it reached the file through an object spread in
 * `captureCompletedDiffStats`. This is the one place that admits it exists.
 */
type DiffStatsOnDisk = NonNullable<Task["completedDiffStats"]> & { fileStats?: TaskDiffFileStat[] };

function withFileStats(task: Task): DiffStatsOnDisk | null {
	const stats = task.completedDiffStats as DiffStatsOnDisk | null | undefined;
	return stats && "fileStats" in stats ? stats : null;
}

/** The same task with its blob-bound fields stripped. Never mutates the input. */
function withoutBlobPayload(task: Task): Task {
	const stats = withFileStats(task);
	if (!stats) return task;
	const { fileStats: _archived, ...rest } = stats;
	return { ...task, completedDiffStats: rest };
}

/**
 * Split blob-bound fields out of `tasks` ahead of a tasks.json write.
 *
 * Returns the trimmed list plus the blobs that must land on disk FIRST: writing
 * the sidecar before tasks.json means a crash between the two leaves the data in
 * both places (harmless) instead of neither. `changed` is false when there was
 * nothing to split, which is the steady state after the one-time migration —
 * so an ordinary save does no extra I/O at all.
 */
export function splitTaskBlobs(tasks: Task[]): {
	tasks: Task[];
	blobs: Array<{ taskId: string; payload: Omit<TaskBlob, "taskId" | "savedAt"> }>;
	changed: boolean;
} {
	const blobs: Array<{ taskId: string; payload: Omit<TaskBlob, "taskId" | "savedAt"> }> = [];
	let changed = false;
	const trimmed = tasks.map((task) => {
		const payload = blobPayloadOf(task);
		if (!payload) return task;
		blobs.push({ taskId: task.id, payload });
		changed = true;
		return withoutBlobPayload(task);
	});
	return { tasks: changed ? trimmed : tasks, blobs, changed };
}

/**
 * Persist every pending blob. Best-effort per task: one unwritable sidecar must
 * never block the tasks.json write that follows it, because the caller has
 * already decided to drop these fields from the main file.
 */
export async function persistTaskBlobs(
	project: Project,
	blobs: Array<{ taskId: string; payload: Omit<TaskBlob, "taskId" | "savedAt"> }>,
): Promise<void> {
	let failed = 0;
	for (const { taskId, payload } of blobs) {
		try {
			await writeTaskBlob(project, taskId, payload);
		} catch (err) {
			failed++;
			log.warn("Failed to write task blob (non-fatal)", { taskId: taskId.slice(0, 8), error: String(err) });
		}
	}
	if (blobs.length > 0) {
		log.info("Wrote task blobs", { projectId: project.id, count: blobs.length - failed, failed });
	}
}
