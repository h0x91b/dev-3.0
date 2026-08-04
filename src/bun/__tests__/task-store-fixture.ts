import type { Project, Task, TaskHistoryEntry, TaskStatus } from "../../shared/types";

/**
 * Deterministic task-store fixture shaped like the live dev-3.0 board: 1509 tasks
 * in 7.4 MB, per-task p50 ~2 KB / p99 ~27 KB / max ~246 KB. The long tail is the
 * point — uniformly average tasks under-report parse and serialize cost.
 */

const SEED = 0x5eed1509;

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Size buckets (compact bytes, share of tasks) reproducing the live quantiles. */
const SIZE_BUCKETS: Array<{ bytes: number; share: number }> = [
	{ bytes: 1_000, share: 0.25 },
	{ bytes: 1_700, share: 0.25 },
	{ bytes: 2_700, share: 0.25 },
	{ bytes: 5_400, share: 0.15 },
	{ bytes: 12_500, share: 0.07 },
	{ bytes: 30_000, share: 0.023 },
	{ bytes: 90_000, share: 0.006 },
	{ bytes: 246_000, share: 0.001 },
];

const WORDS = [
	"lifecycle", "worktree", "tmux", "mutation", "burst", "persist", "kanban", "renderer",
	"handler", "column", "variant", "review", "socket", "backend", "harness", "fixture",
	"latency", "parse", "serialize", "atomic", "lock", "cache", "stall", "profile",
];

function filler(rand: () => number, bytes: number): string {
	const out: string[] = [];
	let size = 0;
	while (size < bytes) {
		const word = WORDS[Math.floor(rand() * WORDS.length)];
		out.push(word);
		size += word.length + 1;
	}
	return out.join(" ");
}

/**
 * Bucket by position, not by dice: a golden-ratio sweep hits every quantile at any
 * task count, so the heavy tail is present in exactly its real proportion instead
 * of depending on how the rolls fell.
 */
function pickBudget(index: number): number {
	const quantile = (index * 0.6180339887498949) % 1;
	let acc = 0;
	for (const bucket of SIZE_BUCKETS) {
		acc += bucket.share;
		if (quantile <= acc) return bucket.bytes;
	}
	return SIZE_BUCKETS[SIZE_BUCKETS.length - 1].bytes;
}

const FIXTURE_PROJECT_PATH = "/tmp/dev3-task-store-perf";

/** The frozen projectSlug() of the fixture project path — never recompute it inline. */
export const FIXTURE_PROJECT_SLUG = "tmp-dev3-task-store-perf";

export function fixtureProject(): Project {
	return {
		id: "perf-project",
		name: "task-store-perf",
		path: FIXTURE_PROJECT_PATH,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		labels: [],
		customColumns: [],
	} satisfies Project;
}

interface TaskShape {
	seq: number;
	descBytes: number;
	noteBytes: number;
	historyBytes: number;
	noteCount: number;
	historyCount: number;
}

function makeTask(shape: TaskShape, rand: () => number): Task {
	const { seq, descBytes, noteBytes, historyBytes, noteCount, historyCount } = shape;
	const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seq * 60_000).toISOString();
	const status: TaskStatus = seq % 7 === 0 ? "completed" : seq % 3 === 0 ? "in-progress" : "todo";
	return {
		id: `task-${String(seq).padStart(5, "0")}-0000-4000-8000-000000000000`,
		seq,
		projectId: "perf-project",
		title: `Task ${seq} — ${filler(rand, 40)}`,
		description: filler(rand, descBytes),
		status,
		priority: "P3",
		baseBranch: "main",
		worktreePath: seq % 3 === 0 ? `/tmp/wt/${seq}/worktree` : null,
		branchName: seq % 3 === 0 ? `feat/dev3-task-${seq}` : null,
		groupId: null,
		variantIndex: null,
		agentId: "builtin-claude",
		configId: "claude-bypass-sonnet",
		createdAt,
		updatedAt: createdAt,
		statusEnteredAt: createdAt,
		movedAt: createdAt,
		tmuxSocket: "dev3",
		labelIds: [],
		relations: [],
		customTitle: null,
		titleEditedByUser: false,
		customColumnId: null,
		overview: filler(rand, 120),
		userOverview: null,
		notes: Array.from({ length: noteCount }, (_, n) => ({
			id: `note-${seq}-${n}`,
			content: filler(rand, Math.floor(noteBytes / noteCount)),
			source: "ai",
			createdAt,
			updatedAt: createdAt,
		})),
		history: Array.from({ length: historyCount }, (_, h): TaskHistoryEntry => ({
			at: createdAt,
			title: `Task ${seq}`,
			overview: filler(rand, Math.floor(historyBytes / historyCount)),
			changed: h === 0 ? "created" : "overview",
		})),
	} satisfies Task;
}

/** Same seed → byte-identical output, so every consumer measures the same store. */
export function buildFixtureTasks(count: number): Task[] {
	const rand = mulberry32(SEED);
	// Fixed field overhead, so a bucket value is the final serialized size.
	const overhead = JSON.stringify(
		makeTask({ seq: 1, descBytes: 0, noteBytes: 0, historyBytes: 0, noteCount: 1, historyCount: 3 }, () => 0),
	).length;
	const tasks: Task[] = [];
	for (let i = 0; i < count; i++) {
		const budget = pickBudget(i);
		// Floor keeps even the smallest task carrying real text in every field.
		const free = Math.max(240, budget - overhead);
		tasks.push(
			makeTask(
				{
					seq: i + 1,
					descBytes: Math.floor(free * 0.35),
					noteBytes: Math.floor(free * 0.45),
					historyBytes: Math.floor(free * 0.2),
					noteCount: budget > 20_000 ? 4 : budget > 4_000 ? 2 : 1,
					historyCount: budget > 20_000 ? 6 : 3,
				},
				rand,
			),
		);
	}
	return tasks;
}
