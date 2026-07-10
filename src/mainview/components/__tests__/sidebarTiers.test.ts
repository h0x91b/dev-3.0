import { describe, it, expect } from "vitest";
import { groupTasksIntoTiers, byPriorityThenMovedAtOldestFirst, type TierGroupingContext } from "../sidebarTiers";
import type { Task, TaskPriority, TaskStatus } from "../../../shared/types";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
	return {
		seq: 1,
		projectId: "p1",
		title: "Task",
		description: "desc",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

function ctx(overrides?: Partial<TierGroupingContext>): TierGroupingContext {
	return {
		scope: "project",
		bellCounts: new Map(),
		orderedCustomColumns: [],
		...overrides,
	};
}

function ids(tasks: Task[]): string[] {
	return tasks.map((t) => t.id);
}

/** Convenience: map tier kinds in render order. */
function kinds(tiers: ReturnType<typeof groupTasksIntoTiers>): string[] {
	return tiers.map((t) => t.kind);
}

// ============================================================
// Tier boundaries — which status lands in which tier
// ============================================================

describe("groupTasksIntoTiers — tier membership by status", () => {
	it("review-by-user and user-questions go to NEEDS YOU", () => {
		const tasks = [
			makeTask({ id: "review", status: "review-by-user" }),
			makeTask({ id: "question", status: "user-questions" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx());
		expect(kinds(tiers)).toEqual(["needs-you"]);
		expect(ids(tiers[0].tasks).sort()).toEqual(["question", "review"]);
	});

	it("in-progress and review-by-ai go to WAITING", () => {
		const tasks = [
			makeTask({ id: "working", status: "in-progress" }),
			makeTask({ id: "ai", status: "review-by-ai" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx());
		expect(kinds(tiers)).toEqual(["waiting"]);
		expect(ids(tiers[0].tasks).sort()).toEqual(["ai", "working"]);
	});

	it("review-by-colleague WITHOUT a signal sinks into WAITING", () => {
		const tasks = [makeTask({ id: "pr", status: "review-by-colleague" })];
		const tiers = groupTasksIntoTiers(tasks, ctx());
		expect(kinds(tiers)).toEqual(["waiting"]);
		expect(ids(tiers[0].tasks)).toEqual(["pr"]);
	});

	it("review-by-colleague WITH a live signal (bell) is promoted to NEEDS YOU", () => {
		const tasks = [makeTask({ id: "pr", status: "review-by-colleague" })];
		const tiers = groupTasksIntoTiers(tasks, ctx({ bellCounts: new Map([["pr", 1]]) }));
		expect(kinds(tiers)).toEqual(["needs-you"]);
		expect(ids(tiers[0].tasks)).toEqual(["pr"]);
	});

	it("full active set produces NEEDS YOU → WAITING with signal-driven PR split", () => {
		const tasks = [
			makeTask({ id: "working", status: "in-progress" }),
			makeTask({ id: "ai", status: "review-by-ai" }),
			makeTask({ id: "review", status: "review-by-user" }),
			makeTask({ id: "question", status: "user-questions" }),
			makeTask({ id: "pr-hot", status: "review-by-colleague" }),
			makeTask({ id: "pr-cold", status: "review-by-colleague" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx({ bellCounts: new Map([["pr-hot", 3]]) }));
		expect(kinds(tiers)).toEqual(["needs-you", "waiting"]);
		expect(ids(tiers[0].tasks).sort()).toEqual(["pr-hot", "question", "review"]);
		expect(ids(tiers[1].tasks).sort()).toEqual(["ai", "pr-cold", "working"]);
	});
});

// ============================================================
// Per-task attention bell is visual-only (never reorders/retiers a normal task)
// ============================================================

describe("groupTasksIntoTiers — attention bell does not move non-PR tasks", () => {
	it("a bell on an in-progress task keeps it in WAITING", () => {
		const tasks = [makeTask({ id: "working", status: "in-progress" })];
		const tiers = groupTasksIntoTiers(tasks, ctx({ bellCounts: new Map([["working", 5]]) }));
		expect(kinds(tiers)).toEqual(["waiting"]);
	});

	it("a bell only promotes review-by-colleague, not review-by-ai", () => {
		const tasks = [makeTask({ id: "ai", status: "review-by-ai" })];
		const tiers = groupTasksIntoTiers(tasks, ctx({ bellCounts: new Map([["ai", 2]]) }));
		expect(kinds(tiers)).toEqual(["waiting"]);
	});
});

// ============================================================
// Priority banding within a tier
// ============================================================

describe("groupTasksIntoTiers — priority banding within a tier", () => {
	it("sorts strictly by priority band P0 → P4 across merged statuses in NEEDS YOU", () => {
		const tasks = [
			makeTask({ id: "p2-review", status: "review-by-user", priority: "P2" }),
			makeTask({ id: "p0-question", status: "user-questions", priority: "P0" }),
			makeTask({ id: "p4-review", status: "review-by-user", priority: "P4" }),
			makeTask({ id: "p1-question", status: "user-questions", priority: "P1" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx());
		expect(kinds(tiers)).toEqual(["needs-you"]);
		// A P0 question sits above a P2 review regardless of status.
		expect(ids(tiers[0].tasks)).toEqual(["p0-question", "p1-question", "p2-review", "p4-review"]);
	});

	it("undefined priority bands as the default P3", () => {
		const tasks = [
			makeTask({ id: "p4", status: "review-by-user", priority: "P4" }),
			makeTask({ id: "default", status: "review-by-user", priority: undefined }),
			makeTask({ id: "p0", status: "review-by-user", priority: "P0" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx());
		// default (P3) sits between P0 and P4.
		expect(ids(tiers[0].tasks)).toEqual(["p0", "default", "p4"]);
	});
});

// ============================================================
// Oldest-movedAt / seq tiebreak within a band
// ============================================================

describe("groupTasksIntoTiers — tiebreak within a priority band", () => {
	it("oldest movedAt first within the same band", () => {
		const tasks = [
			makeTask({ id: "newer", status: "review-by-user", priority: "P1", movedAt: "2025-03-01T00:00:00Z" }),
			makeTask({ id: "older", status: "review-by-user", priority: "P1", movedAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "mid", status: "review-by-user", priority: "P1", movedAt: "2025-02-01T00:00:00Z" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx());
		expect(ids(tiers[0].tasks)).toEqual(["older", "mid", "newer"]);
	});

	it("tasks without movedAt sink to the bottom of their band; seq breaks the final tie", () => {
		const tasks = [
			makeTask({ id: "no-moved-b", seq: 20, status: "review-by-user", priority: "P1" }),
			makeTask({ id: "moved", seq: 5, status: "review-by-user", priority: "P1", movedAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "no-moved-a", seq: 10, status: "review-by-user", priority: "P1" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx());
		expect(ids(tiers[0].tasks)).toEqual(["moved", "no-moved-a", "no-moved-b"]);
	});
});

// ============================================================
// Custom-column tiers — ordering + positioning between NEEDS YOU and WAITING
// ============================================================

describe("groupTasksIntoTiers — custom columns", () => {
	it("custom-column tasks form their own tiers between NEEDS YOU and WAITING, in column order", () => {
		const tasks = [
			makeTask({ id: "working", status: "in-progress" }),
			makeTask({ id: "review", status: "review-by-user" }),
			makeTask({ id: "hold-1", status: "in-progress", customColumnId: "onhold" }),
			makeTask({ id: "backlog-1", status: "in-progress", customColumnId: "backlog" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx({
			orderedCustomColumns: [
				{ projectId: "p1", columnId: "onhold" },
				{ projectId: "p1", columnId: "backlog" },
			],
		}));
		expect(kinds(tiers)).toEqual(["needs-you", "custom", "custom", "waiting"]);
		expect(tiers[1].customColumnId).toBe("onhold");
		expect(tiers[1].key).toBe("custom:p1|onhold");
		expect(tiers[2].customColumnId).toBe("backlog");
		expect(ids(tiers[1].tasks)).toEqual(["hold-1"]);
		expect(ids(tiers[3].tasks)).toEqual(["working"]);
	});

	it("a custom-column task stays in its column even when its status is actionable", () => {
		const tasks = [
			makeTask({ id: "parked-review", status: "review-by-user", customColumnId: "onhold" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx({
			orderedCustomColumns: [{ projectId: "p1", columnId: "onhold" }],
		}));
		expect(kinds(tiers)).toEqual(["custom"]);
	});

	it("custom columns are priority-sorted internally", () => {
		const tasks = [
			makeTask({ id: "hold-p3", status: "in-progress", customColumnId: "onhold", priority: "P3" }),
			makeTask({ id: "hold-p0", status: "in-progress", customColumnId: "onhold", priority: "P0" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx({
			orderedCustomColumns: [{ projectId: "p1", columnId: "onhold" }],
		}));
		expect(ids(tiers[0].tasks)).toEqual(["hold-p0", "hold-p3"]);
	});

	it("custom columns are keyed per project so two projects' columns do not merge (global scope)", () => {
		const tasks = [
			makeTask({ id: "p1-hold", projectId: "p1", status: "in-progress", customColumnId: "onhold" }),
			makeTask({ id: "p2-hold", projectId: "p2", status: "in-progress", customColumnId: "onhold" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx({
			scope: "global",
			orderedCustomColumns: [
				{ projectId: "p1", columnId: "onhold" },
				{ projectId: "p2", columnId: "onhold" },
			],
		}));
		expect(kinds(tiers)).toEqual(["custom", "custom"]);
		expect(ids(tiers[0].tasks)).toEqual(["p1-hold"]);
		expect(ids(tiers[1].tasks)).toEqual(["p2-hold"]);
	});
});

// ============================================================
// Empty-tier omission
// ============================================================

describe("groupTasksIntoTiers — empty tiers", () => {
	it("omits tiers with no tasks", () => {
		const tasks = [makeTask({ id: "working", status: "in-progress" })];
		const tiers = groupTasksIntoTiers(tasks, ctx({
			orderedCustomColumns: [{ projectId: "p1", columnId: "onhold" }],
		}));
		expect(kinds(tiers)).toEqual(["waiting"]);
	});

	it("returns an empty array when there are no tasks", () => {
		expect(groupTasksIntoTiers([], ctx())).toEqual([]);
	});
});

// ============================================================
// Attention scope — filter + priority sort, single flat tier
// ============================================================

describe("groupTasksIntoTiers — attention scope", () => {
	it("keeps only tasks needing the user and returns a single flat NEEDS YOU tier", () => {
		const tasks = [
			makeTask({ id: "working", status: "in-progress" }),
			makeTask({ id: "ai", status: "review-by-ai" }),
			makeTask({ id: "review", status: "review-by-user" }),
			makeTask({ id: "question", status: "user-questions" }),
			makeTask({ id: "pr-cold", status: "review-by-colleague" }),
			makeTask({ id: "pr-hot", status: "review-by-colleague" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx({
			scope: "attention",
			bellCounts: new Map([["pr-hot", 1]]),
		}));
		expect(kinds(tiers)).toEqual(["needs-you"]);
		expect(tiers[0].key).toBe("attention");
		expect(ids(tiers[0].tasks).sort()).toEqual(["pr-hot", "question", "review"]);
	});

	it("sorts the attention tier by priority band, then oldest movedAt", () => {
		const tasks = [
			makeTask({ id: "p2-old", status: "review-by-user", priority: "P2", movedAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "p0", status: "user-questions", priority: "P0", movedAt: "2025-05-01T00:00:00Z" }),
			makeTask({ id: "p2-new", status: "review-by-user", priority: "P2", movedAt: "2025-02-01T00:00:00Z" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx({ scope: "attention" }));
		// P0 leads (even though newest); within P2 the older movedAt wins.
		expect(ids(tiers[0].tasks)).toEqual(["p0", "p2-old", "p2-new"]);
	});

	it("never produces custom or waiting tiers in attention scope, even with custom columns present", () => {
		const tasks = [
			makeTask({ id: "review", status: "review-by-user" }),
			makeTask({ id: "working", status: "in-progress" }),
		];
		const tiers = groupTasksIntoTiers(tasks, ctx({
			scope: "attention",
			orderedCustomColumns: [{ projectId: "p1", columnId: "onhold" }],
		}));
		expect(kinds(tiers)).toEqual(["needs-you"]);
		expect(ids(tiers[0].tasks)).toEqual(["review"]);
	});

	it("returns an empty array when nothing needs the user", () => {
		const tasks = [
			makeTask({ id: "working", status: "in-progress" }),
			makeTask({ id: "ai", status: "review-by-ai" }),
		];
		expect(groupTasksIntoTiers(tasks, ctx({ scope: "attention" }))).toEqual([]);
	});
});

// ============================================================
// Purity — the input array is not mutated
// ============================================================

describe("groupTasksIntoTiers — purity", () => {
	it("does not mutate or reorder the caller's array", () => {
		const tasks = [
			makeTask({ id: "b", status: "review-by-user", priority: "P4" }),
			makeTask({ id: "a", status: "review-by-user", priority: "P0" }),
		];
		const snapshot = ids(tasks);
		groupTasksIntoTiers(tasks, ctx());
		expect(ids(tasks)).toEqual(snapshot);
	});
});

// ============================================================
// Comparator (exported for reuse)
// ============================================================

describe("byPriorityThenMovedAtOldestFirst", () => {
	function t(id: string, priority: TaskPriority | undefined, movedAt: string | undefined, seq = 1): Task {
		return makeTask({ id, status: "review-by-user" as TaskStatus, priority, movedAt, seq });
	}

	it("orders by priority band first", () => {
		expect(byPriorityThenMovedAtOldestFirst(t("a", "P0", undefined), t("b", "P1", undefined))).toBeLessThan(0);
	});

	it("within a band, oldest movedAt first", () => {
		expect(
			byPriorityThenMovedAtOldestFirst(
				t("a", "P1", "2025-01-01T00:00:00Z"),
				t("b", "P1", "2025-02-01T00:00:00Z"),
			),
		).toBeLessThan(0);
	});

	it("missing movedAt sinks below a task that has one", () => {
		expect(
			byPriorityThenMovedAtOldestFirst(t("a", "P1", undefined), t("b", "P1", "2025-02-01T00:00:00Z")),
		).toBeGreaterThan(0);
	});

	it("seq breaks the final tie", () => {
		expect(byPriorityThenMovedAtOldestFirst(t("a", "P1", undefined, 5), t("b", "P1", undefined, 9))).toBeLessThan(0);
	});
});
