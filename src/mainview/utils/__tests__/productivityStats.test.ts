import { describe, expect, it } from "vitest";
import type { ProductivityStatEvent, TaskStatus } from "../../../shared/types";
import { computeProductivityStats, niceCeil } from "../productivityStats";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-28T12:00:00.000Z");

let idc = 0;
function ev(over: Partial<ProductivityStatEvent> = {}): ProductivityStatEvent {
	idc += 1;
	return {
		taskId: `t${idc}`,
		projectId: "p1",
		projectName: "Proj A",
		projectKind: "git",
		title: "task",
		status: "completed" as TaskStatus,
		createdAt: new Date(NOW - 3 * DAY).toISOString(),
		movedAt: new Date(NOW - 1 * DAY).toISOString(),
		insertions: 0,
		deletions: 0,
		files: 0,
		liveStats: false,
		agentId: "claude",
		groupId: null,
		variantIndex: null,
		...over,
	};
}

describe("niceCeil", () => {
	it("rounds up to 1/2/5 × 10ⁿ and respects the floor", () => {
		expect(niceCeil(3)).toBe(5);
		expect(niceCeil(13)).toBe(20);
		expect(niceCeil(0, 5)).toBe(5);
		expect(niceCeil(0, 4)).toBeGreaterThanOrEqual(4);
		expect(niceCeil(7)).toBe(10);
		expect(niceCeil(1)).toBe(1);
		expect(niceCeil(140, 100)).toBe(200);
	});
});

describe("computeProductivityStats — week range", () => {
	const events: ProductivityStatEvent[] = [
		// 3 completed this week, 2 projects
		ev({ movedAt: new Date(NOW - 1 * DAY).toISOString(), insertions: 10, deletions: 5 }),
		ev({ movedAt: new Date(NOW - 2 * DAY).toISOString(), insertions: 20, deletions: 0 }),
		ev({ projectId: "p2", projectName: "Proj B", movedAt: new Date(NOW - 3 * DAY).toISOString(), insertions: 1, deletions: 1 }),
		// 1 completed last week (previous period)
		ev({ movedAt: new Date(NOW - 9 * DAY).toISOString(), insertions: 100, deletions: 100 }),
		// 1 cancelled this week
		ev({ status: "cancelled", movedAt: new Date(NOW - 2 * DAY).toISOString() }),
		// 1 in-progress (no completion) — counts toward tasksTotal/agentsRun only
		ev({ status: "in-progress", movedAt: undefined, insertions: 7, deletions: 0 }),
	];

	const r = computeProductivityStats(events, "week", NOW);

	it("counts tasks shipped this week vs last week with trend", () => {
		expect(r.hero.tasksShipped.value).toBe(3);
		expect(r.hero.tasksShipped.previous).toBe(1);
		expect(r.hero.tasksShipped.trendPct).toBe(200);
	});

	it("sums lines changed this week", () => {
		expect(r.hero.linesChanged.value).toBe(10 + 5 + 20 + 1 + 1);
		expect(r.hero.linesChanged.previous).toBe(200);
	});

	it("computes completion rate from completed vs cancelled in period", () => {
		// 3 completed, 1 cancelled → 75%
		expect(r.hero.completionRate.value).toBe(75);
	});

	it("reports projects touched and a busiest project", () => {
		expect(r.counters.projectsTouched).toBe(2);
		expect(r.perProject[0].busiest).toBe(true);
		expect(r.perProject[0].projectId).toBe("p1");
		expect(r.perProject[0].completed).toBe(2);
		expect(r.perProject.find((p) => p.projectId === "p2")?.sharePct).toBe(33);
	});

	it("counts all-time completed and approximate agents run", () => {
		expect(r.counters.allTimeCompleted).toBe(4); // 3 this week + 1 last week
		expect(r.counters.tasksTotal).toBe(6);
		expect(r.counters.agentsRun).toBe(6); // every event has agentId
	});

	it("builds a 7-bucket daily series", () => {
		expect(r.series).toHaveLength(7);
	});

	it("exposes a non-null gauge max for scaling", () => {
		expect(r.hero.tasksShipped.max).toBeGreaterThanOrEqual(4);
		expect(r.hero.completionRate.max).toBe(100);
	});
});

describe("computeProductivityStats — all range", () => {
	const events = [ev({ movedAt: new Date(NOW - 40 * DAY).toISOString() }), ev({ movedAt: new Date(NOW - 5 * DAY).toISOString() })];
	const r = computeProductivityStats(events, "all", NOW);

	it("has no previous period / trend for all-time", () => {
		expect(r.hero.tasksShipped.previous).toBeNull();
		expect(r.hero.tasksShipped.trendPct).toBeNull();
		expect(r.hero.tasksShipped.value).toBe(2);
	});

	it("buckets monthly across the history", () => {
		expect(r.series.length).toBeGreaterThanOrEqual(2);
	});
});

describe("computeProductivityStats — streaks", () => {
	it("computes current and best streak from consecutive completion days", () => {
		const events = [
			// current run: today, -1, -2
			ev({ movedAt: new Date(NOW).toISOString() }),
			ev({ movedAt: new Date(NOW - 1 * DAY).toISOString() }),
			ev({ movedAt: new Date(NOW - 2 * DAY).toISOString() }),
			// older run of 4: -6..-9
			ev({ movedAt: new Date(NOW - 6 * DAY).toISOString() }),
			ev({ movedAt: new Date(NOW - 7 * DAY).toISOString() }),
			ev({ movedAt: new Date(NOW - 8 * DAY).toISOString() }),
			ev({ movedAt: new Date(NOW - 9 * DAY).toISOString() }),
		];
		const r = computeProductivityStats(events, "all", NOW);
		expect(r.hero.streak.value).toBe(3);
		expect(r.counters.bestStreak).toBe(4);
	});

	it("handles empty input without throwing", () => {
		const r = computeProductivityStats([], "week", NOW);
		expect(r.hasAnyData).toBe(false);
		expect(r.hero.tasksShipped.value).toBe(0);
		expect(r.counters.bestStreak).toBe(0);
		expect(r.series).toHaveLength(7);
	});
});

describe("computeProductivityStats — LOC tracking hint", () => {
	it("reports the earliest completed task with real diff data", () => {
		const events = [
			ev({ movedAt: new Date(NOW - 5 * DAY).toISOString(), insertions: 0, deletions: 0 }),
			ev({ movedAt: new Date(NOW - 3 * DAY).toISOString(), insertions: 5, deletions: 2 }),
		];
		const r = computeProductivityStats(events, "all", NOW);
		expect(r.locTrackingSince).toBe(new Date(NOW - 3 * DAY).toISOString().slice(0, 10));
	});
});
