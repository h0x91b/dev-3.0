import { describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// The module imports these at load; the tests inject their own deps, so the reals
// are never called — mock them only to keep the import graph light and hermetic.
vi.mock("../data", () => ({ getProject: vi.fn(), addTaskFocusMs: vi.fn() }));
vi.mock("../rpc-handlers/shared", () => ({ getActiveContext: vi.fn(), isAppForeground: vi.fn() }));
vi.mock("../user-activity", () => ({ getUserIdleSeconds: vi.fn() }));

import { FocusTracker, type FocusTrackerDeps, shouldCreditFocus } from "../focus-tracker";

describe("shouldCreditFocus", () => {
	const base = { foreground: true, idleSeconds: 0, activeTaskId: "t1", activeProjectId: "p1" };

	it("credits when foreground, a task is active, and not idle", () => {
		expect(shouldCreditFocus(base, 60)).toEqual({ taskId: "t1", projectId: "p1" });
	});

	it("credits when idle is unknown (null) — foreground is the best signal", () => {
		expect(shouldCreditFocus({ ...base, idleSeconds: null }, 60)).toEqual({ taskId: "t1", projectId: "p1" });
	});

	it("does not credit when the app is backgrounded", () => {
		expect(shouldCreditFocus({ ...base, foreground: false }, 60)).toBeNull();
	});

	it("does not credit when no task/project is on screen", () => {
		expect(shouldCreditFocus({ ...base, activeTaskId: null }, 60)).toBeNull();
		expect(shouldCreditFocus({ ...base, activeProjectId: null }, 60)).toBeNull();
	});

	it("does not credit when the user is idle past the threshold", () => {
		expect(shouldCreditFocus({ ...base, idleSeconds: 120 }, 60)).toBeNull();
		expect(shouldCreditFocus({ ...base, idleSeconds: 60 }, 60)).toEqual({ taskId: "t1", projectId: "p1" });
	});
});

describe("FocusTracker", () => {
	function makeTracker(over: Partial<FocusTrackerDeps> = {}) {
		const state = {
			nowMs: 1000,
			foreground: true,
			idle: 0 as number | null,
			ctx: { projectId: "p1" as string | null, taskId: "t1" as string | null },
		};
		const addFocusMs = vi.fn(async () => {});
		const deps: FocusTrackerDeps = {
			now: () => state.nowMs,
			isForeground: () => state.foreground,
			getActiveContext: () => state.ctx,
			getIdleSeconds: async () => state.idle,
			addFocusMs,
			tickMs: 1000,
			idleThresholdSec: 60,
			flushEveryTicks: 2,
			maxCreditPerTickMs: 5000,
			...over,
		};
		return { tracker: new FocusTracker(deps), state, addFocusMs };
	}

	it("credits elapsed attention and flushes on the flush cadence", async () => {
		const { tracker, state, addFocusMs } = makeTracker();
		await tracker.tick(); // baseline — elapsed 0
		state.nowMs = 2000;
		await tracker.tick(); // +1000ms credited to t1; 2nd tick → flush
		expect(addFocusMs).toHaveBeenCalledWith("p1", "t1", 1000);
	});

	it("accumulates across ticks before flushing", async () => {
		const { tracker, state, addFocusMs } = makeTracker({ flushEveryTicks: 3 });
		await tracker.tick(); // baseline
		state.nowMs = 2000;
		await tracker.tick(); // +1000
		state.nowMs = 3500;
		await tracker.tick(); // +1500 → 3rd tick flushes 2500 total
		expect(addFocusMs).toHaveBeenCalledTimes(1);
		expect(addFocusMs).toHaveBeenCalledWith("p1", "t1", 2500);
	});

	it("does not credit while backgrounded", async () => {
		const { tracker, state, addFocusMs } = makeTracker({ flushEveryTicks: 1 });
		state.foreground = false;
		await tracker.tick();
		state.nowMs = 2000;
		await tracker.tick();
		await tracker.flush();
		expect(addFocusMs).not.toHaveBeenCalled();
	});

	it("does not credit while idle past the threshold", async () => {
		const { tracker, state, addFocusMs } = makeTracker({ flushEveryTicks: 1 });
		state.idle = 300;
		await tracker.tick();
		state.nowMs = 2000;
		await tracker.tick();
		await tracker.flush();
		expect(addFocusMs).not.toHaveBeenCalled();
	});

	it("clamps a single tick's credit (sleep/blocked event loop guard)", async () => {
		const { tracker, state, addFocusMs } = makeTracker({ flushEveryTicks: 1 });
		await tracker.tick(); // baseline @ 1000
		state.nowMs = 1_000_000; // huge gap
		await tracker.tick(); // clamped to maxCreditPerTickMs = 5000
		expect(addFocusMs).toHaveBeenCalledWith("p1", "t1", 5000);
	});

	it("attributes credit to whichever task is on-screen at the tick", async () => {
		const { tracker, state, addFocusMs } = makeTracker({ flushEveryTicks: 4 });
		await tracker.tick(); // baseline
		state.nowMs = 2000;
		await tracker.tick(); // +1000 → t1
		state.ctx = { projectId: "p2", taskId: "t2" };
		state.nowMs = 3000;
		await tracker.tick(); // +1000 → t2
		state.nowMs = 4000;
		await tracker.tick(); // +1000 → t2 ; 4th tick flushes
		const calls = addFocusMs.mock.calls.map((c) => c.join(":")).sort();
		expect(calls).toEqual(["p1:t1:1000", "p2:t2:2000"]);
	});

	it("flush is a no-op with nothing pending and clears the buffer after flushing", async () => {
		const { tracker, state, addFocusMs } = makeTracker({ flushEveryTicks: 100 });
		await tracker.flush(); // empty
		expect(addFocusMs).not.toHaveBeenCalled();
		await tracker.tick(); // baseline
		state.nowMs = 2000;
		await tracker.tick(); // +1000 pending
		await tracker.flush(); // manual flush
		expect(addFocusMs).toHaveBeenCalledTimes(1);
		await tracker.flush(); // buffer cleared → no further writes
		expect(addFocusMs).toHaveBeenCalledTimes(1);
	});
});
