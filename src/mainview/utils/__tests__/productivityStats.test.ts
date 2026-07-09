import { describe, expect, it } from "vitest";
import type { ProductivityStatEvent, TaskStatus } from "../../../shared/types";
import { computeMilestones, computeProductivityStats, formatDuration, gaugeMax, SHIPPING_MILESTONES } from "../productivityStats";

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
		statusDurations: {},
		statusEnteredAt: null,
		focusMs: 0,
		...over,
		lifecycleStartedAt: over.lifecycleStartedAt === undefined ? new Date(NOW - 2 * DAY).toISOString() : over.lifecycleStartedAt,
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

describe("computeProductivityStats — task lifetime", () => {
	const at = (days: number) => new Date(NOW - days * DAY).toISOString();

	it("averages only tracked completion cycles and exposes them per project", () => {
		const r = computeProductivityStats([
			ev({ projectId: "p1", projectName: "Fast", lifecycleStartedAt: at(3), movedAt: at(1) }), // 48h
			ev({ projectId: "p1", projectName: "Fast", lifecycleStartedAt: at(2), movedAt: at(1) }), // 24h
			ev({ projectId: "p2", projectName: "Legacy", lifecycleStartedAt: null, movedAt: at(1) }),
		], "week", NOW);

		expect(r.hasLifecycleData).toBe(true);
		expect(r.hero.averageLifetimeHours.value).toBe(36);
		expect(r.perProject.find((p) => p.projectId === "p1")?.averageLifetimeMs).toBe(36 * 3_600_000);
		expect(r.perProject.find((p) => p.projectId === "p2")?.averageLifetimeMs).toBeNull();
	});

	it("does not invent a duration for tasks completed before tracking started", () => {
		const r = computeProductivityStats([ev({ lifecycleStartedAt: null })], "week", NOW);
		expect(r.hasLifecycleData).toBe(false);
		expect(r.hero.averageLifetimeHours.value).toBe(0);
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

describe("computeMilestones", () => {
	it("returns reached medals and the next tier to chase", () => {
		expect(computeMilestones(0)).toEqual({ reached: [], next: 10, current: 0 });
		expect(computeMilestones(1075)).toEqual({ reached: [10, 50, 100, 250, 500, 1000], next: 2500, current: 1075 });
	});

	it("has no next tier once every milestone is earned", () => {
		const top = SHIPPING_MILESTONES[SHIPPING_MILESTONES.length - 1];
		const m = computeMilestones(top);
		expect(m.next).toBeNull();
		expect(m.reached).toHaveLength(SHIPPING_MILESTONES.length);
	});
});

describe("computeProductivityStats — momentum & on-fire", () => {
	const at = (d: number) => new Date(NOW - d * DAY).toISOString();

	it("flags on-fire when the period beats the rolling average", () => {
		// 8 completed over 28 days → weekly avg 2; this week 4 → above norm.
		const events: ProductivityStatEvent[] = [
			ev({ createdAt: at(1), movedAt: at(1) }),
			ev({ createdAt: at(2), movedAt: at(2) }),
			ev({ createdAt: at(3), movedAt: at(3) }),
			ev({ createdAt: at(4), movedAt: at(4) }),
			ev({ createdAt: at(10), movedAt: at(10) }),
			ev({ createdAt: at(15), movedAt: at(15) }),
			ev({ createdAt: at(20), movedAt: at(20) }),
			ev({ createdAt: at(28), movedAt: at(28) }),
		];
		const r = computeProductivityStats(events, "week", NOW);
		expect(r.onFire).toBe(true);
		expect(r.momentum.state).toBe("fire");
		expect(r.momentum.pct).toBe(100); // (4/2 - 1) * 100
	});

	it("is idle with no shipments, lifetime for all-time", () => {
		expect(computeProductivityStats([], "week", NOW).momentum.state).toBe("idle");
		const some = [ev({ movedAt: at(2) }), ev({ movedAt: at(40) })];
		expect(computeProductivityStats(some, "all", NOW).momentum.state).toBe("lifetime");
	});

	it("reads as behind when output drops vs the previous period", () => {
		const events: ProductivityStatEvent[] = [
			ev({ createdAt: at(1), movedAt: at(1) }), // this week: 1
			ev({ createdAt: at(8), movedAt: at(8) }), // last week: 5
			ev({ createdAt: at(9), movedAt: at(9) }),
			ev({ createdAt: at(10), movedAt: at(10) }),
			ev({ createdAt: at(11), movedAt: at(11) }),
			ev({ createdAt: at(12), movedAt: at(12) }),
		];
		const r = computeProductivityStats(events, "week", NOW);
		expect(r.onFire).toBe(false);
		expect(r.momentum.state).toBe("behind");
		expect(r.momentum.pct).toBe(80); // |(1-5)/5| * 100
	});
});

describe("computeProductivityStats — contribution heatmap", () => {
	const at = (d: number) => new Date(NOW - d * DAY).toISOString();

	it("spans ~a year of day cells starting on a Sunday", () => {
		const r = computeProductivityStats([], "week", NOW);
		expect(r.heatmap.days.length).toBeGreaterThanOrEqual(365);
		expect(r.heatmap.days.length).toBeLessThanOrEqual(378);
		expect(new Date(r.heatmap.days[0].ms).getDay()).toBe(0); // Sunday
		expect(r.heatmap.maxCount).toBe(0);
		expect(r.heatmap.totalCount).toBe(0);
	});

	it("counts completed tasks into the matching day cell", () => {
		const events = [ev({ movedAt: at(1) }), ev({ movedAt: at(1) }), ev({ movedAt: at(3) })];
		const r = computeProductivityStats(events, "week", NOW);
		expect(r.heatmap.totalCount).toBe(3);
		expect(r.heatmap.maxCount).toBe(2);
		// Match on the engine's LOCAL day key (heatmap cells are local-midnight).
		const localKey = (ms: number) => {
			const d = new Date(ms);
			return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
		};
		const cell = r.heatmap.days.find((d) => localKey(d.ms) === localKey(NOW - DAY));
		expect(cell?.count).toBe(2);
	});
});

describe("computeProductivityStats — LOC empty state", () => {
	const at = (d: number) => new Date(NOW - d * DAY).toISOString();
	it("reports hasAnyLines only once a completed task has real diff data", () => {
		const noLines = [ev({ movedAt: at(1), insertions: 0, deletions: 0 })];
		expect(computeProductivityStats(noLines, "all", NOW).hasAnyLines).toBe(false);
		const withLines = [ev({ movedAt: at(1), insertions: 3, deletions: 1 })];
		expect(computeProductivityStats(withLines, "all", NOW).hasAnyLines).toBe(true);
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

describe("computeProductivityStats — time invested", () => {
	const HOUR = 3_600_000;
	const MIN = 60_000;

	it("aggregates total/agent/focus over completed tasks in the period", () => {
		const events: ProductivityStatEvent[] = [
			ev({
				createdAt: new Date(NOW - 5 * HOUR).toISOString(),
				movedAt: new Date(NOW - 1 * HOUR).toISOString(), // total lifetime = 4h
				statusDurations: {
					"in-progress": 2 * HOUR,
					"review-by-ai": 30 * MIN,
					"review-by-user": 90 * MIN,
				},
				statusEnteredAt: new Date(NOW - 1 * HOUR).toISOString(),
				focusMs: 45 * MIN,
			}),
		];
		const r = computeProductivityStats(events, "week", NOW);
		expect(r.time.count).toBe(1);
		expect(r.time.totalMs).toBe(4 * HOUR);
		// agent = in-progress + review-by-ai; user statuses excluded
		expect(r.time.agentMs).toBe(2 * HOUR + 30 * MIN);
		expect(r.time.focusMs).toBe(45 * MIN);
		expect(r.time.avgTotalMs).toBe(4 * HOUR);
		expect(r.time.hasTracking).toBe(true);
	});

	it("sums time across projects and per-project cards", () => {
		const events: ProductivityStatEvent[] = [
			ev({
				movedAt: new Date(NOW - 1 * HOUR).toISOString(),
				createdAt: new Date(NOW - 3 * HOUR).toISOString(),
				statusDurations: { "in-progress": 1 * HOUR },
				statusEnteredAt: new Date(NOW - 1 * HOUR).toISOString(),
				focusMs: 20 * MIN,
			}),
			ev({
				projectId: "p2",
				projectName: "Proj B",
				movedAt: new Date(NOW - 2 * HOUR).toISOString(),
				createdAt: new Date(NOW - 4 * HOUR).toISOString(),
				statusDurations: { "in-progress": 30 * MIN, "review-by-ai": 30 * MIN },
				statusEnteredAt: new Date(NOW - 2 * HOUR).toISOString(),
				focusMs: 10 * MIN,
			}),
		];
		const r = computeProductivityStats(events, "week", NOW);
		expect(r.time.agentMs).toBe(2 * HOUR); // 1h + (30m+30m)
		expect(r.time.focusMs).toBe(30 * MIN);
		const p2 = r.perProject.find((p) => p.projectId === "p2");
		expect(p2?.totalMs).toBe(2 * HOUR);
		expect(p2?.agentMs).toBe(1 * HOUR);
		expect(p2?.focusMs).toBe(10 * MIN);
	});

	it("reports zero agent/focus and hasTracking=false for legacy tasks", () => {
		const events: ProductivityStatEvent[] = [
			ev({
				createdAt: new Date(NOW - 2 * HOUR).toISOString(),
				movedAt: new Date(NOW - 1 * HOUR).toISOString(),
			}),
		];
		const r = computeProductivityStats(events, "week", NOW);
		expect(r.time.totalMs).toBe(1 * HOUR); // lifetime always available
		expect(r.time.agentMs).toBe(0);
		expect(r.time.focusMs).toBe(0);
		expect(r.time.hasTracking).toBe(false);
	});

	it("reports the earliest tracked completed task as trackingSince", () => {
		const events: ProductivityStatEvent[] = [
			ev({ movedAt: new Date(NOW - 5 * DAY).toISOString() }), // legacy, no tracking
			ev({
				movedAt: new Date(NOW - 3 * DAY).toISOString(),
				statusEnteredAt: new Date(NOW - 3 * DAY).toISOString(),
				statusDurations: { "in-progress": 1 * HOUR },
			}),
		];
		const r = computeProductivityStats(events, "all", NOW);
		expect(r.time.trackingSince).toBe(new Date(NOW - 3 * DAY).toISOString().slice(0, 10));
	});
});

describe("formatDuration", () => {
	const HOUR = 3_600_000;
	const MIN = 60_000;
	it("formats coarse durations with two significant units", () => {
		expect(formatDuration(0)).toBe("0m");
		expect(formatDuration(-5)).toBe("0m");
		expect(formatDuration(45 * MIN)).toBe("45m");
		expect(formatDuration(2 * HOUR + 15 * MIN)).toBe("2h 15m");
		expect(formatDuration(3 * HOUR)).toBe("3h");
		expect(formatDuration(26 * HOUR)).toBe("1d 2h");
		expect(formatDuration(48 * HOUR)).toBe("2d");
	});
});

describe("computeProductivityStats — period navigation (offset)", () => {
	it("offset 0 matches the default (no-arg) computation", () => {
		const events = [ev(), ev({ movedAt: new Date(NOW - 9 * DAY).toISOString() })];
		const base = computeProductivityStats(events, "week", NOW);
		const zero = computeProductivityStats(events, "week", NOW, 0);
		expect(zero.hero.tasksShipped.value).toBe(base.hero.tasksShipped.value);
		expect(zero.offset).toBe(0);
		expect(zero.canGoNewer).toBe(false);
	});

	it("shifts the week window one whole period into the past", () => {
		const events = [
			ev({ movedAt: new Date(NOW - 1 * DAY).toISOString() }),
			ev({ movedAt: new Date(NOW - 2 * DAY).toISOString() }),
			ev({ movedAt: new Date(NOW - 9 * DAY).toISOString() }),
		];
		const cur = computeProductivityStats(events, "week", NOW, 0);
		const prev = computeProductivityStats(events, "week", NOW, 1);
		expect(cur.hero.tasksShipped.value).toBe(2);
		expect(prev.hero.tasksShipped.value).toBe(1);
		expect(prev.offset).toBe(1);
		expect(prev.periodTo).toBe(cur.periodTo - 7 * DAY);
	});

	it("gates the older/newer arrows on available data and offset", () => {
		const events = [
			ev({
				movedAt: new Date(NOW - 1 * DAY).toISOString(),
				createdAt: new Date(NOW - 20 * DAY).toISOString(),
			}),
		];
		const cur = computeProductivityStats(events, "week", NOW, 0);
		expect(cur.canGoOlder).toBe(true); // activity exists before the shown week
		expect(cur.canGoNewer).toBe(false); // already at the present
		const back = computeProductivityStats(events, "week", NOW, 1);
		expect(back.canGoNewer).toBe(true);
	});

	it("ignores offset entirely for range 'all'", () => {
		const all = computeProductivityStats([ev()], "all", NOW, 3);
		expect(all.offset).toBe(0);
		expect(all.canGoOlder).toBe(false);
		expect(all.canGoNewer).toBe(false);
	});

	it("keeps lifetime views (heatmap, all-time counter) anchored to now while navigating", () => {
		const events = [ev({ movedAt: new Date(NOW - 1 * DAY).toISOString() })];
		const cur = computeProductivityStats(events, "week", NOW, 0);
		const back = computeProductivityStats(events, "week", NOW, 2);
		const lastCell = (d: typeof cur) => d.heatmap.days[d.heatmap.days.length - 1].ms;
		expect(lastCell(back)).toBe(lastCell(cur));
		expect(back.counters.allTimeCompleted).toBe(cur.counters.allTimeCompleted);
	});
});
