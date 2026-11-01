import type { Task } from "../../../shared/types";
import { compareTasksInBand, taskActivityTime } from "../../components/sortTasks";

/** `priority`: priority bands, longest-waiting first inside a band. `recent`: last activity first. */
export type AttentionBucketSort = "priority" | "recent";
export const ATTENTION_BUCKET_SORTS: readonly AttentionBucketSort[] = ["priority", "recent"];

/** One bucket = one named token query (D20). An empty `name` shows the default name for `id`, if it has one. */
export interface AttentionBucket {
	id: string;
	name: string;
	query: string;
	sort: AttentionBucketSort;
}

export interface AttentionLayout {
	buckets: AttentionBucket[];
}

export const DEFAULT_ATTENTION_BUCKETS: readonly AttentionBucket[] = [
	{ id: "needs-you", name: "", query: "is:attention", sort: "priority" },
	{ id: "ready", name: "", query: "status:todo", sort: "priority" },
	// Same facet twice is OR: hibernated or gone quiet.
	{ id: "stalled", name: "", query: "is:hibernated is:stalled", sort: "priority" },
	// A finished task's PR state freezes when it leaves the board, so a bare `pr:open`
	// would list every merged task. Review statuses are already "Needs you".
	{ id: "waiting-pr", name: "", query: "pr:open status:in-progress status:review-by-ai", sort: "recent" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whatever the layout file holds becomes a usable bucket list; an unreadable one means the defaults. */
export function normalizeAttentionLayout(value: unknown): AttentionLayout {
	if (!isRecord(value) || !Array.isArray(value.buckets)) return { buckets: [...DEFAULT_ATTENTION_BUCKETS] };
	const seen = new Set<string>();
	const buckets: AttentionBucket[] = [];
	for (const raw of value.buckets) {
		if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id || seen.has(raw.id)) continue;
		seen.add(raw.id);
		buckets.push({
			id: raw.id,
			name: typeof raw.name === "string" ? raw.name : "",
			query: typeof raw.query === "string" ? raw.query : "",
			sort: ATTENTION_BUCKET_SORTS.includes(raw.sort as AttentionBucketSort) ? (raw.sort as AttentionBucketSort) : "priority",
		});
	}
	return { buckets };
}

export function newBucketId(existing: readonly AttentionBucket[]): string {
	const ids = new Set(existing.map((b) => b.id));
	let n = existing.length + 1;
	while (ids.has(`b${n}`)) n++;
	return `b${n}`;
}

function sortBucket(tasks: Task[], sort: AttentionBucketSort): Task[] {
	if (sort === "recent") {
		return tasks.sort((a, b) => taskActivityTime(b) - taskActivityTime(a) || a.seq - b.seq);
	}
	return tasks.sort((a, b) => compareTasksInBand(a, b, "oldest-first"));
}

export interface FilledBucket {
	bucket: AttentionBucket;
	tasks: Task[];
}

/**
 * Sort tasks into buckets. A task lands in the FIRST bucket whose query it
 * matches, so the view reads as one triage queue with no duplicates — bucket
 * order is precedence. A blank query matches nothing, so a half-typed bucket
 * never swallows the board.
 */
export function fillBuckets(
	tasks: readonly Task[],
	buckets: readonly AttentionBucket[],
	matches: (task: Task, query: string) => boolean,
): FilledBucket[] {
	const filled = buckets.map((bucket) => ({ bucket, tasks: [] as Task[] }));
	const live = filled.filter((entry) => entry.bucket.query.trim());
	for (const task of tasks) {
		const home = live.find((entry) => matches(task, entry.bucket.query));
		home?.tasks.push(task);
	}
	for (const entry of filled) sortBucket(entry.tasks, entry.bucket.sort);
	return filled;
}
