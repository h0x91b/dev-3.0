import type { Task } from "../../../../shared/types";
import { DEFAULT_ATTENTION_BUCKETS, fillBuckets, newBucketId, normalizeAttentionLayout, type AttentionBucket } from "../buckets";

function task(seq: number, overrides: Partial<Task> = {}): Task {
	return {
		id: `t${seq}`, seq, projectId: "p1", title: `task ${seq}`, description: "", status: "todo",
		baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
		customColumnId: null, labelIds: [], notes: [], history: [], ...overrides,
	};
}

// A stand-in matcher: the query is a status name, `*` matches anything.
const byStatus = (t: Task, q: string) => q === "*" || q.split(" ").includes(t.status);
const bucket = (id: string, query: string, sort: AttentionBucket["sort"] = "priority"): AttentionBucket => ({ id, name: "", query, sort });

describe("normalizeAttentionLayout", () => {
	it("falls back to the default buckets when nothing usable is stored", () => {
		expect(normalizeAttentionLayout(undefined).buckets).toEqual(DEFAULT_ATTENTION_BUCKETS);
		expect(normalizeAttentionLayout({ buckets: "nope" }).buckets).toEqual(DEFAULT_ATTENTION_BUCKETS);
	});

	it("keeps an empty list: the user removed every bucket on purpose", () => {
		expect(normalizeAttentionLayout({ buckets: [] }).buckets).toEqual([]);
	});

	it("drops malformed and duplicate entries and repairs fields", () => {
		const layout = normalizeAttentionLayout({
			buckets: [{ id: "a", name: 3, query: "x", sort: "weird" }, { id: "a", query: "dup" }, { query: "no id" }, null],
		});
		expect(layout.buckets).toEqual([{ id: "a", name: "", query: "x", sort: "priority" }]);
	});
});

describe("fillBuckets", () => {
	it("puts a task in the first bucket it matches, so nothing shows twice", () => {
		const tasks = [task(1, { status: "user-questions" }), task(2)];
		const [first, second] = fillBuckets(tasks, [bucket("a", "user-questions"), bucket("b", "*")], byStatus);
		expect(first.tasks.map((t) => t.seq)).toEqual([1]);
		expect(second.tasks.map((t) => t.seq)).toEqual([2]);
	});

	it("never matches through a blank query", () => {
		const [blank, rest] = fillBuckets([task(1)], [bucket("a", "  "), bucket("b", "*")], () => true);
		expect(blank.tasks).toEqual([]);
		expect(rest.tasks).toHaveLength(1);
	});

	it("sorts by priority bands, longest-waiting first inside a band", () => {
		const tasks = [
			task(1, { priority: "P3", statusEnteredAt: "2026-01-03T00:00:00Z" }),
			task(2, { priority: "P0", statusEnteredAt: "2026-01-04T00:00:00Z" }),
			task(3, { priority: "P3", statusEnteredAt: "2026-01-02T00:00:00Z" }),
		];
		const [only] = fillBuckets(tasks, [bucket("a", "todo")], byStatus);
		expect(only.tasks.map((t) => t.seq)).toEqual([2, 3, 1]);
	});

	it("sorts a `recent` bucket by last activity, newest first, ignoring priority", () => {
		const tasks = [
			task(1, { priority: "P0", statusEnteredAt: "2026-01-02T00:00:00Z" }),
			task(2, { priority: "P4", statusEnteredAt: "2026-01-05T00:00:00Z" }),
		];
		const [only] = fillBuckets(tasks, [bucket("a", "todo", "recent")], byStatus);
		expect(only.tasks.map((t) => t.seq)).toEqual([2, 1]);
	});
});

describe("newBucketId", () => {
	it("never reuses an id in the list", () => {
		expect(newBucketId([bucket("b2", "x")])).toBe("b3");
		expect(newBucketId([])).toBe("b1");
	});
});
