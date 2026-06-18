import { describe, expect, it } from "vitest";
import {
	ACTIVE_PROJECT_MERGE_INTERVAL_MS,
	BACKGROUND_PROJECT_MERGE_INTERVAL_MS,
	MERGE_POLL_INTERVAL_MS,
	SCHEDULE_JITTER_MS,
	intervalForTask,
	isDue,
	nextDueAfterRun,
	pruneSchedule,
	staggeredDue,
	wasAsleep,
} from "../rpc-handlers/git-poll-throttle";

const NOW = 1_700_000_000_000;

describe("intervalForTask", () => {
	it("uses the active interval only for the on-screen foreground project", () => {
		expect(intervalForTask(true, ACTIVE_PROJECT_MERGE_INTERVAL_MS, BACKGROUND_PROJECT_MERGE_INTERVAL_MS)).toBe(ACTIVE_PROJECT_MERGE_INTERVAL_MS);
		expect(intervalForTask(false, ACTIVE_PROJECT_MERGE_INTERVAL_MS, BACKGROUND_PROJECT_MERGE_INTERVAL_MS)).toBe(BACKGROUND_PROJECT_MERGE_INTERVAL_MS);
	});
});

describe("nextDueAfterRun", () => {
	it("schedules one interval out plus random jitter within [0, SCHEDULE_JITTER_MS)", () => {
		expect(nextDueAfterRun(NOW, 60_000, () => 0)).toBe(NOW + 60_000);
		expect(nextDueAfterRun(NOW, 60_000, () => 0.5)).toBe(NOW + 60_000 + SCHEDULE_JITTER_MS / 2);
		const r = nextDueAfterRun(NOW, 60_000, () => 0.999);
		expect(r).toBeGreaterThan(NOW + 60_000);
		expect(r).toBeLessThan(NOW + 60_000 + SCHEDULE_JITTER_MS);
	});

	it("gives two tasks scheduled together different next-due times (no re-alignment)", () => {
		const a = nextDueAfterRun(NOW, 60_000, () => 0.1);
		const b = nextDueAfterRun(NOW, 60_000, () => 0.8);
		expect(a).not.toBe(b);
	});
});

describe("staggeredDue", () => {
	it("spreads a fresh/woken batch across the whole interval window", () => {
		expect(staggeredDue(NOW, 600_000, () => 0)).toBe(NOW);
		expect(staggeredDue(NOW, 600_000, () => 0.5)).toBe(NOW + 300_000);
		const late = staggeredDue(NOW, 600_000, () => 0.99);
		expect(late).toBeGreaterThan(NOW + 500_000);
		expect(late).toBeLessThan(NOW + 600_000);
	});
});

describe("isDue", () => {
	it("is due only once now has reached the scheduled time", () => {
		expect(isDue(NOW + 1_000, NOW)).toBe(false);
		expect(isDue(NOW, NOW)).toBe(true);
		expect(isDue(NOW - 1, NOW)).toBe(true);
	});
});

describe("wasAsleep", () => {
	it("flags a tick that arrives far later than the base interval", () => {
		expect(wasAsleep(MERGE_POLL_INTERVAL_MS, MERGE_POLL_INTERVAL_MS)).toBe(false);
		expect(wasAsleep(2 * MERGE_POLL_INTERVAL_MS, MERGE_POLL_INTERVAL_MS)).toBe(false);
		// A 30-minute gap on a 60s poller = host slept.
		expect(wasAsleep(30 * 60_000, MERGE_POLL_INTERVAL_MS)).toBe(true);
	});
});

describe("pruneSchedule", () => {
	it("drops scheduling state for tasks that no longer exist", () => {
		const map = new Map<string, number>([["a", 1], ["b", 2], ["c", 3]]);
		pruneSchedule(map, new Set(["b"]));
		expect([...map.keys()]).toEqual(["b"]);
	});
});
