import { describe, expect, it } from "vitest";
import type { ProductivityStatEvent, TaskStatus } from "../../../shared/types";
import { computePeriodTime, reconstructTimeline, unionMs } from "../periodTime";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-16T08:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

let idc = 0;
function ev(over: Partial<ProductivityStatEvent> = {}): ProductivityStatEvent {
	idc += 1;
	return {
		taskId: `t${idc}`,
		seq: 1,
		projectId: "p1",
		projectName: "Proj",
		projectKind: "git",
		title: "task",
		status: "in-progress",
		createdAt: at(10 * DAY),
		movedAt: null,
		lifecycleStartedAt: null,
		insertions: 0,
		deletions: 0,
		files: 0,
		liveStats: false,
		agentId: null,
		configId: null,
		groupId: null,
		variantIndex: null,
		statusEnteredAt: null,
		focusMs: 0,
		focusByHour: {},
		movements: [],
		movementsDropped: 0,
		hibernated: false,
		...over,
	};
}

/** A task with a full movement log: `steps` are [msAgo, status], the first being creation. */
function logged(steps: Array<[number, TaskStatus]>, over: Partial<ProductivityStatEvent> = {}): ProductivityStatEvent {
	const last = steps[steps.length - 1];
	return ev({
		status: last[1],
		createdAt: at(steps[0][0]),
		movedAt: at(last[0]),
		statusEnteredAt: at(last[0]),
		movements: steps.map(([ago, to]) => ({ at: at(ago), to })),
		...over,
	});
}

const lastWeek = (events: ProductivityStatEvent[], lifetimeFocus = false) =>
	computePeriodTime(events, NOW - 7 * DAY, NOW, NOW, lifetimeFocus);

describe("computePeriodTime — clipping", () => {
	it("clips a task alive across both window edges to the window", () => {
		const r = computePeriodTime([logged([[30 * DAY, "in-progress"]])], NOW - 10 * DAY, NOW - 3 * DAY, NOW);
		expect(r.agentMs).toBe(7 * DAY);
		expect(r.inFlightMs).toBe(7 * DAY);
	});

	it("treats the window as half-open and caps it at now", () => {
		const t = logged([[2 * DAY, "in-progress"]]);
		// A window reaching into the future counts only up to now.
		expect(computePeriodTime([t], NOW - DAY, NOW + 5 * DAY, NOW).agentMs).toBe(DAY);
		// A window ending exactly when the task started sees nothing.
		expect(computePeriodTime([t], NOW - 3 * DAY, NOW - 2 * DAY, NOW).agentMs).toBe(0);
	});

	it("excludes To Do and closed time from in-flight, and user columns from agent time", () => {
		const t = logged([
			[6 * DAY, "todo"],
			[5 * DAY, "in-progress"],
			[4 * DAY, "review-by-ai"],
			[3 * DAY, "review-by-user"],
			[2 * DAY, "completed"],
		]);
		const r = lastWeek([t]);
		expect(r.inFlightMs).toBe(3 * DAY);
		expect(r.agentMs).toBe(2 * DAY);
	});

	it("counts both cycles of a reopened task and nothing while it was closed", () => {
		const t = logged([
			[6 * DAY, "in-progress"],
			[5 * DAY, "completed"],
			[2 * DAY, "in-progress"],
			[1 * DAY, "completed"],
		]);
		const r = lastWeek([t]);
		expect(r.agentMs).toBe(2 * DAY);
		expect(r.gapTasks).toBe(0);
	});

	it("counts a cancelled task's in-flight time up to the cancellation", () => {
		const r = lastWeek([logged([[3 * DAY, "in-progress"], [1 * DAY, "cancelled"]])]);
		expect(r.agentMs).toBe(2 * DAY);
	});
});

describe("computePeriodTime — history gaps are reported, never estimated", () => {
	it("starts a truncated log at the first kept movement and flags the gap", () => {
		const t = logged([[3 * DAY, "review-by-user"]], { createdAt: at(6 * DAY), movementsDropped: 12 });
		const r = lastWeek([t]);
		expect(r.inFlightMs).toBe(3 * DAY);
		expect(r.agentMs).toBe(0);
		expect(r.gapTasks).toBe(1);
	});

	it("leaves a gap for a move an older build made without logging it", () => {
		// Log says in-progress since 5d; statusEnteredAt says the task entered review 2d ago.
		const t = ev({
			status: "review-by-user",
			createdAt: at(5 * DAY),
			statusEnteredAt: at(2 * DAY),
			movements: [{ at: at(5 * DAY), to: "in-progress" }],
		});
		const r = lastWeek([t]);
		expect(r.agentMs).toBe(0);
		expect(r.inFlightMs).toBe(2 * DAY);
		expect(r.gapTasks).toBe(1);
	});

	it("uses statusEnteredAt and lifecycleStartedAt for a task with no log at all", () => {
		const t = ev({
			status: "in-progress",
			createdAt: at(9 * DAY),
			lifecycleStartedAt: at(5 * DAY),
			statusEnteredAt: at(2 * DAY),
		});
		const r = lastWeek([t]);
		expect(r.agentMs).toBe(2 * DAY); // only the current stint is known to be In Progress
		expect(r.inFlightMs).toBe(5 * DAY); // launched 5d ago, status before the stint unknown
		expect(r.gapTasks).toBe(1); // creation → launch is unaccounted for
	});

	it("never credits a legacy task closed before the window", () => {
		const t = ev({ status: "completed", createdAt: at(40 * DAY), movedAt: at(20 * DAY), lifecycleStartedAt: at(39 * DAY) });
		const r = lastWeek([t]);
		expect(r.inFlightMs).toBe(0);
		expect(r.gapTasks).toBe(0);
	});

	it("survives unparseable timestamps without counting anything", () => {
		const t = ev({ createdAt: "garbage", movements: [{ at: "nope", to: "in-progress" }] });
		const r = lastWeek([t]);
		expect(r.inFlightMs).toBe(0);
		expect(reconstructTimeline(t, NOW)).toBeNull();
	});
});

describe("computePeriodTime — parallel agents", () => {
	it("adds task-hours up but merges them for wall-clock", () => {
		const a = logged([[3 * DAY, "in-progress"], [1 * DAY, "review-by-user"]]);
		const b = logged([[2 * DAY, "in-progress"]]);
		const r = lastWeek([a, b]);
		expect(r.agentMs).toBe(4 * DAY); // 2d + 2d
		expect(r.agentWallMs).toBe(3 * DAY); // 3d ago → now, overlap counted once
	});

	it("flags hibernated tasks counted in agent columns", () => {
		const r = lastWeek([logged([[2 * DAY, "in-progress"]], { hibernated: true })]);
		expect(r.agentMs).toBe(2 * DAY);
		expect(r.hibernatedAgentTasks).toBe(1);
	});

	it("unionMs merges touching and nested intervals", () => {
		expect(unionMs([[0, 10], [10, 20], [2, 5], [30, 40], [35, 36]])).toBe(30);
		expect(unionMs([])).toBe(0);
	});
});

describe("computePeriodTime — focus", () => {
	const hourKey = (ms: number) => String(Math.floor(ms / HOUR));

	it("places recorded focus by hour and keeps untimed focus out of bounded periods", () => {
		const inside = NOW - 2 * DAY;
		const outside = NOW - 9 * DAY;
		const t = logged([[10 * DAY, "in-progress"]], {
			focusMs: 100 * 60_000, // 40m in the window, 20m before it, 40m with no recorded hour
			focusByHour: { [hourKey(inside)]: 40 * 60_000, [hourKey(outside)]: 20 * 60_000 },
		});
		const r = lastWeek([t]);
		expect(r.focusMs).toBe(40 * 60_000);
		expect(r.untimedFocusTasks).toBe(1);
		expect(r.focusSinceMs).toBe(Math.floor(outside / HOUR) * HOUR);
		// "All time" is the one window the whole counter is exact for.
		const all = lastWeek([t], true);
		expect(all.focusMs).toBe(100 * 60_000);
		expect(all.untimedFocusTasks).toBe(0);
	});

	it("attributes an hour bucket by its start, so a window edge moves at most one hour", () => {
		const hourStart = Math.floor((NOW - 3 * DAY) / HOUR) * HOUR;
		const t = ev({ focusMs: 30 * 60_000, focusByHour: { [hourKey(hourStart)]: 30 * 60_000 } });
		expect(computePeriodTime([t], hourStart, NOW, NOW).focusMs).toBe(30 * 60_000);
		expect(computePeriodTime([t], hourStart + 1, NOW, NOW).focusMs).toBe(0);
		expect(computePeriodTime([t], 0, hourStart, NOW).focusMs).toBe(0);
	});

	it("counts focus on a task that never left To Do", () => {
		const t = logged([[3 * DAY, "todo"]], { focusMs: 10 * 60_000, focusByHour: { [hourKey(NOW - DAY)]: 10 * 60_000 } });
		const r = lastWeek([t]);
		expect(r.focusMs).toBe(10 * 60_000);
		expect(r.inFlightMs).toBe(0);
		expect(r.perProject.get("p1")?.focusMs).toBe(10 * 60_000);
	});
});
