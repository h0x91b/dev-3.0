import { describe, expect, it } from "vitest";
import type { ProductivityStatEvent, TaskStatus } from "../../../shared/types";
import { computeProductivityStats, gaugeMax } from "../productivityStats";

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

describe("gaugeMax", () => {
	it("rounds up with headroom using fine steps (no huge 20→50 jumps)", () => {
		// The headline requirement: 25 shipped → a tight 30, not 50.
		expect(gaugeMax(25, 4)).toBe(30);
		expect(gaugeMax(3)).toBe(4);
		expect(gaugeMax(7)).toBe(8);
		expect(gaugeMax(13)).toBe(16);
		expect(gaugeMax(140, 100)).toBe(160);
	});

	it("respects the floor and never pegs the needle at full", () => {
		expect(gaugeMax(0, 5)).toBe(5);
		expect(gaugeMax(0, 4)).toBe(4);
		// Always strictly above a positive value so the needle has headroom.
		for (const v of [1, 4, 9, 20, 25, 48, 99, 250, 1234]) {
			expect(gaugeMax(v, 1)).toBeGreaterThan(v);
		}
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

describe("computeProductivityStats — red zone = rolling average", () => {
	// 8 completed over a 28-day history → average per week = 8 * (7/28) = 2.
	const at = (d: number) => new Date(NOW - d * DAY).toISOString();
	const events: ProductivityStatEvent[] = [
		// 4 this week
		ev({ createdAt: at(1), movedAt: at(1), insertions: 5, deletions: 0 }),
		ev({ createdAt: at(2), movedAt: at(2), insertions: 5, deletions: 0 }),
		ev({ createdAt: at(3), movedAt: at(3), insertions: 5, deletions: 0 }),
		ev({ createdAt: at(4), movedAt: at(4), insertions: 5, deletions: 0 }),
		// 4 spread earlier, anchoring earliest at NOW-28d
		ev({ createdAt: at(10), movedAt: at(10) }),
		ev({ createdAt: at(15), movedAt: at(15) }),
		ev({ createdAt: at(20), movedAt: at(20) }),
		ev({ createdAt: at(28), movedAt: at(28) }),
	];

	it("sets the weekly red zone to the lifetime average for that period", () => {
		const r = computeProductivityStats(events, "week", NOW);
		expect(r.hero.tasksShipped.value).toBe(4);
		expect(r.hero.tasksShipped.redZone).toBe(2); // 8 * 7/28
		// Max must clear both the value and the red zone.
		expect(r.hero.tasksShipped.max).toBeGreaterThanOrEqual(4);
	});

	it("sets the velocity red zone to the lifetime tasks/day average", () => {
		const r = computeProductivityStats(events, "week", NOW);
		expect(r.hero.velocity.redZone).toBeCloseTo(0.3, 5); // 8 / 28 ≈ 0.286 → 0.3
	});

	it("has no red zone on completion rate, and none for all-time counts", () => {
		const week = computeProductivityStats(events, "week", NOW);
		expect(week.hero.completionRate.redZone).toBeNull();
		const all = computeProductivityStats(events, "all", NOW);
		expect(all.hero.tasksShipped.redZone).toBeNull();
		expect(all.hero.velocity.redZone).toBeNull();
	});
});

describe("computeProductivityStats — per-agent breakdown", () => {
	const at = (d: number) => new Date(NOW - d * DAY).toISOString();
	it("groups completed tasks by agent type with friendly names", () => {
		const events: ProductivityStatEvent[] = [
			ev({ agentId: "builtin-claude", movedAt: at(1) }),
			ev({ agentId: "builtin-claude", movedAt: at(2) }),
			ev({ agentId: "builtin-claude", movedAt: at(3) }),
			ev({ agentId: "builtin-codex", movedAt: at(1) }),
		];
		const r = computeProductivityStats(events, "week", NOW);
		expect(r.perAgent).toHaveLength(2);
		expect(r.perAgent[0]).toMatchObject({ agentId: "builtin-claude", name: "Claude", completed: 3, busiest: true });
		const codex = r.perAgent.find((a) => a.agentId === "builtin-codex");
		expect(codex).toMatchObject({ name: "Codex", completed: 1, sharePct: 25 });
	});

	it("falls back to 'unknown' for tasks with no agent", () => {
		const r = computeProductivityStats([ev({ agentId: null, movedAt: at(1) })], "week", NOW);
		expect(r.perAgent[0]).toMatchObject({ agentId: "unknown", name: "Unknown", completed: 1 });
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
