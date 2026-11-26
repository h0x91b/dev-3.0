import { artifactVersions, latestArtifactVersion } from "./artifact-versions";
import { liveViewerEntry } from "./live-artifact";
import { getTaskTitle, isDeletableSharedMedia, isSharedAudio, isSharedVideo, type LiveArtifact, type SharedArtifact, type SharedImage, type Task, type TaskStatus } from "./types";

/**
 * The Library is a read-only projection of the output records every task already holds
 * (`sharedArtifacts`, `sharedImages`/`Videos`/`Audio`, `liveArtifact`). There is no index file:
 * the item `key` is `(projectId, taskId, recordId)`, so any future archive maps onto it.
 */
export type LibraryKind = "report" | "video" | "image" | "audio";

export const LIBRARY_KINDS: readonly LibraryKind[] = ["report", "video", "image", "audio"];

export interface LibraryItem {
	key: string;
	kind: LibraryKind;
	projectId: string;
	projectName: string;
	taskId: string;
	taskSeq: number;
	taskTitle: string;
	taskStatus: TaskStatus;
	agentId: string | null;
	/** Artifact title, else the media caption, else the file name. */
	title: string;
	caption?: string;
	name: string;
	createdAt: number;
	/**
	 * Bytes of the files that still exist: every retained artifact version with its assets, or the
	 * media file. The pure projection counts the record's claim; the host's {@link applyLibraryPresence}
	 * moves whatever is gone into `goneBytes`, so totals never count a file that is not there.
	 */
	bytes: number;
	goneBytes: number;
	versions: number;
	unread: boolean;
	/** The stored file is gone (pruned or lost); the record outlived it. Set by the host. */
	missing: boolean;
	/** The user deleted the stored file to free disk; the record stays as a tombstone. Not `missing`. */
	removedAt?: number;
	live: boolean;
	/** Position in the task's own artifact list, so the viewer opens on it with its siblings. */
	order: number;
	image?: SharedImage;
	artifact?: SharedArtifact;
	liveArtifact?: LiveArtifact;
}

export interface LibraryReport {
	items: LibraryItem[];
	generatedAt: string;
}

interface ProjectRef {
	id: string;
	name: string;
}

function mediaKind(image: SharedImage): LibraryKind {
	if (isSharedVideo(image)) return "video";
	if (isSharedAudio(image)) return "audio";
	return "image";
}

export function artifactRecordBytes(artifact: SharedArtifact): number {
	let total = 0;
	for (const version of artifactVersions(artifact)) {
		total += version.bytes;
		// Records written before assets existed carry `images` instead; they read as asset-less.
		for (const asset of version.assets ?? []) total += asset.bytes;
	}
	return total;
}

function base(project: ProjectRef, task: Task) {
	return {
		projectId: project.id,
		projectName: project.name,
		taskId: task.id,
		taskSeq: task.seq,
		taskTitle: getTaskTitle(task),
		taskStatus: task.status,
		agentId: task.agentId ?? null,
		missing: false,
		goneBytes: 0,
	};
}

/** Every output record of one task as library items. Pure: the host fills in `missing`. */
export function taskLibraryItems(project: ProjectRef, task: Task): LibraryItem[] {
	const items: LibraryItem[] = [];
	const media = [...(task.sharedImages ?? []), ...(task.sharedVideos ?? []), ...(task.sharedAudio ?? [])];
	for (const image of media) {
		items.push({
			...base(project, task),
			key: `${project.id}:${task.id}:${image.id}`,
			kind: mediaKind(image),
			title: image.caption?.trim() || image.name,
			caption: image.caption,
			name: image.name,
			createdAt: image.createdAt,
			bytes: image.removedAt ? 0 : image.bytes,
			removedAt: image.removedAt,
			versions: 1,
			unread: image.isUnread === true,
			live: false,
			order: 0,
			image,
		});
	}
	(task.sharedArtifacts ?? []).forEach((artifact, order) => {
		items.push({
			...base(project, task),
			key: `${project.id}:${task.id}:${artifact.id}`,
			kind: "report",
			title: artifact.title || artifact.name,
			name: artifact.name,
			createdAt: artifact.createdAt,
			bytes: artifactRecordBytes(artifact),
			versions: latestArtifactVersion(artifact),
			unread: artifact.isUnread === true,
			live: false,
			order,
			artifact,
		});
	});
	if (task.liveArtifact) {
		const page = liveViewerEntry(task.id, task.liveArtifact);
		items.push({
			...base(project, task),
			key: `${project.id}:${task.id}:${page.id}`,
			kind: "report",
			title: page.title || page.name,
			name: page.name,
			createdAt: task.liveArtifact.updatedAt,
			bytes: artifactRecordBytes(page),
			versions: 1,
			unread: false,
			live: true,
			order: task.sharedArtifacts?.length ?? 0,
			artifact: page,
			liveArtifact: task.liveArtifact,
		});
	}
	return items;
}

/**
 * Splits an item's bytes into files that exist and files that are gone, and flags it `missing`
 * when its primary file (the media, or the newest artifact version) is gone. Older artifact
 * versions and assets are checked one by one: the retention pruner removes them independently.
 */
export function applyLibraryPresence(item: LibraryItem, exists: (path: string) => boolean): LibraryItem {
	if (item.removedAt) return item;
	if (item.image) {
		if (exists(item.image.storedPath)) return item;
		return { ...item, missing: true, bytes: 0, goneBytes: item.image.bytes };
	}
	if (!item.artifact) return item;
	let present = 0;
	let gone = 0;
	const count = (path: string, bytes: number) => {
		if (exists(path)) present += bytes;
		else gone += bytes;
	};
	for (const version of artifactVersions(item.artifact)) {
		count(version.storedPath, version.bytes);
		for (const asset of version.assets ?? []) count(asset.storedPath, asset.bytes);
	}
	return { ...item, missing: !exists(item.artifact.storedPath), bytes: present, goneBytes: gone };
}

/**
 * One task's items rebuilt from a pushed task record, keeping the host-checked presence of every
 * item whose record did not change. A new record or version reads as present: it was just written.
 */
export function mergeTaskLibraryItems(previous: readonly LibraryItem[], fresh: readonly LibraryItem[]): LibraryItem[] {
	const known = new Map(previous.map((item) => [item.key, item]));
	return fresh.map((item) => {
		const prior = known.get(item.key);
		if (!prior || prior.versions !== item.versions || prior.createdAt !== item.createdAt || prior.removedAt !== item.removedAt) return item;
		return { ...item, bytes: prior.bytes, goneBytes: prior.goneBytes, missing: prior.missing };
	});
}

/** The whole list with one task's items swapped for `next` (an empty `next` drops the task). */
export function replaceTaskLibraryItems(all: readonly LibraryItem[], projectId: string, taskId: string, next: readonly LibraryItem[]): LibraryItem[] {
	const sameTask = (item: LibraryItem) => item.projectId === projectId && item.taskId === taskId;
	const kept = all.filter((item) => !sameTask(item));
	const merged = mergeTaskLibraryItems(all.filter(sameTask), next);
	return [...kept, ...merged];
}

// ── Renderer-side helpers (pure) ────────────────────────────────────────────

/** A clip whose stored file the user can delete to free disk (images and reports cannot be). */
export function isLibraryItemDeletable(item: LibraryItem): boolean {
	return item.image != null && !item.missing && !item.removedAt && isDeletableSharedMedia(item.image);
}

/** Deletable items grouped per task, the unit the delete RPC works on. */
export function libraryDeleteGroups(items: readonly LibraryItem[]): { projectId: string; taskId: string; items: SharedImage[] }[] {
	const groups = new Map<string, { projectId: string; taskId: string; items: SharedImage[] }>();
	for (const item of items) {
		if (!isLibraryItemDeletable(item)) continue;
		const id = `${item.projectId}:${item.taskId}`;
		const group = groups.get(id) ?? { projectId: item.projectId, taskId: item.taskId, items: [] };
		group.items.push(item.image!);
		groups.set(id, group);
	}
	return [...groups.values()];
}

export type LibrarySort = "newest" | "oldest" | "largest";

export interface LibraryFilter {
	query: string;
	kind: LibraryKind | "all";
	projectId: string | null;
	unseenOnly: boolean;
	/** Items whose text must not be searched (privacy-locked projects). */
	isLocked?: (projectId: string) => boolean;
	agentName?: (agentId: string | null) => string | null;
}

function haystack(item: LibraryItem, agentName: string | null): string {
	return [item.title, item.caption ?? "", item.name, item.taskTitle, item.projectName, agentName ?? "", `#${item.taskSeq}`]
		.join("\n")
		.toLocaleLowerCase();
}

export function filterLibraryItems(items: readonly LibraryItem[], filter: LibraryFilter): LibraryItem[] {
	const terms = filter.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	return items.filter((item) => {
		if (filter.kind !== "all" && item.kind !== filter.kind) return false;
		if (filter.projectId && item.projectId !== filter.projectId) return false;
		if (filter.unseenOnly && !item.unread) return false;
		if (terms.length === 0) return true;
		if (filter.isLocked?.(item.projectId)) return false;
		const text = haystack(item, filter.agentName?.(item.agentId) ?? null);
		return terms.every((term) => text.includes(term));
	});
}

export function sortLibraryItems(items: readonly LibraryItem[], sort: LibrarySort): LibraryItem[] {
	const copy = [...items];
	if (sort === "largest") copy.sort((a, b) => b.bytes - a.bytes || b.createdAt - a.createdAt);
	else if (sort === "oldest") copy.sort((a, b) => a.createdAt - b.createdAt);
	else copy.sort((a, b) => b.createdAt - a.createdAt);
	return copy;
}

export type LibraryDayBucket = "today" | "yesterday" | "week" | "month" | "older";

function startOfDay(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** Calendar-day bucket in the viewer's local time zone. */
export function libraryDayBucket(createdAt: number, now: number): LibraryDayBucket {
	const today = startOfDay(now);
	const day = 24 * 60 * 60 * 1000;
	if (createdAt >= today) return "today";
	if (createdAt >= today - day) return "yesterday";
	if (createdAt >= today - 6 * day) return "week";
	if (createdAt >= today - 29 * day) return "month";
	return "older";
}

export interface LibraryGroup {
	id: string;
	label: string;
	bytes: number;
	count: number;
}

/** Bytes per project (or per task inside one project), biggest first. */
export function libraryDiskGroups(items: readonly LibraryItem[], by: "project" | "task"): LibraryGroup[] {
	const groups = new Map<string, LibraryGroup>();
	for (const item of items) {
		const id = by === "project" ? item.projectId : item.taskId;
		const label = by === "project" ? item.projectName : item.taskTitle;
		const group = groups.get(id) ?? { id, label, bytes: 0, count: 0 };
		group.bytes += item.bytes;
		group.count += 1;
		groups.set(id, group);
	}
	return [...groups.values()].sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label));
}

export interface LibrarySummary {
	count: number;
	bytes: number;
	unseen: number;
	/** Items with any file already gone (the record or an older version); `goneBytes` is their size. */
	missing: number;
	goneBytes: number;
}

export function summarizeLibrary(items: readonly LibraryItem[]): LibrarySummary {
	let bytes = 0;
	let unseen = 0;
	let missing = 0;
	let goneBytes = 0;
	for (const item of items) {
		bytes += item.bytes;
		goneBytes += item.goneBytes;
		if (item.unread) unseen += 1;
		// Counted with the same rule as `goneBytes`, so "N removed (X)" describes one set of items.
		if (item.missing || item.goneBytes > 0) missing += 1;
	}
	return { count: items.length, bytes, unseen, missing, goneBytes };
}

/** The viewer's history for an item: its task's media (oldest → newest) or its task's artifacts. */
export function libraryViewerSiblings(items: readonly LibraryItem[], target: LibraryItem): LibraryItem[] {
	const sameTask = items.filter((item) => item.taskId === target.taskId && item.projectId === target.projectId);
	if (target.kind === "report") return sameTask.filter((item) => item.kind === "report" && !item.live).sort((a, b) => a.order - b.order);
	return sameTask.filter((item) => item.kind !== "report").sort((a, b) => a.createdAt - b.createdAt);
}
