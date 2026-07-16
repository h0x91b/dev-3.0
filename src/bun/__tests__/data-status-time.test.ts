import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import type { Project } from "../../shared/types";
import { computeTaskTimeBreakdown } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-status-time`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
	vi.useRealTimers();
});

import { addTask, addTaskFocusMs, getTask, updateTask } from "../data";

const testProject: Project = {
	id: "proj-1",
	name: "Test",
	path: "/tmp/test-project",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

const MIN = 60_000;

describe("status-duration accumulation", () => {
	it("seeds statusEnteredAt at creation with no durations yet", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
		const task = await addTask(testProject, "Timed task");
		expect(task.statusEnteredAt).toBe("2026-07-01T00:00:00.000Z");
		expect(task.statusDurations ?? {}).toEqual({});
	});

	it("credits the leaving status on each transition and re-stamps statusEnteredAt", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
		const task = await addTask(testProject, "Timed task"); // todo @ t0

		vi.setSystemTime(new Date("2026-07-01T00:10:00.000Z")); // +10m
		let u = await updateTask(testProject, task.id, { status: "in-progress" });
		expect(u.statusDurations).toEqual({ todo: 10 * MIN });
		expect(u.statusEnteredAt).toBe("2026-07-01T00:10:00.000Z");

		vi.setSystemTime(new Date("2026-07-01T00:40:00.000Z")); // +30m in-progress
		u = await updateTask(testProject, task.id, { status: "review-by-user" });
		expect(u.statusDurations).toEqual({ todo: 10 * MIN, "in-progress": 30 * MIN });

		vi.setSystemTime(new Date("2026-07-01T00:45:00.000Z")); // +5m review-by-user
		u = await updateTask(testProject, task.id, { status: "completed" });
		expect(u.statusDurations).toEqual({
			todo: 10 * MIN,
			"in-progress": 30 * MIN,
			"review-by-user": 5 * MIN,
		});

		// The breakdown derived from the persisted task matches the split.
		const tb = computeTaskTimeBreakdown(u, Date.parse("2026-07-01T02:00:00.000Z"));
		expect(tb.totalMs).toBe(45 * MIN); // create → complete
		expect(tb.agentMs).toBe(30 * MIN); // in-progress (+ AI review = 0)
		expect(tb.userMs).toBe(5 * MIN); // review-by-user
		expect(tb.hasStatusTracking).toBe(true);
	});

	it("accumulates repeat visits to the same status", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-02T00:00:00.000Z"));
		const task = await addTask(testProject, "Bouncy");

		vi.setSystemTime(new Date("2026-07-02T00:05:00.000Z"));
		await updateTask(testProject, task.id, { status: "in-progress" }); // todo 5m

		vi.setSystemTime(new Date("2026-07-02T00:20:00.000Z"));
		await updateTask(testProject, task.id, { status: "user-questions" }); // in-progress 15m

		vi.setSystemTime(new Date("2026-07-02T00:25:00.000Z"));
		await updateTask(testProject, task.id, { status: "in-progress" }); // user-questions 5m

		vi.setSystemTime(new Date("2026-07-02T00:35:00.000Z"));
		const u = await updateTask(testProject, task.id, { status: "completed" }); // in-progress +10m
		expect(u.statusDurations).toEqual({
			todo: 5 * MIN,
			"in-progress": 25 * MIN, // 15 + 10
			"user-questions": 5 * MIN,
		});
	});

	it("does not touch status timing on non-status updates", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-03T00:00:00.000Z"));
		const task = await addTask(testProject, "T");
		vi.setSystemTime(new Date("2026-07-03T00:05:00.000Z"));
		const u = await updateTask(testProject, task.id, { overview: "hi" });
		expect(u.statusEnteredAt).toBe("2026-07-03T00:00:00.000Z"); // unchanged
		expect(u.statusDurations ?? {}).toEqual({});
	});
});

describe("addTaskFocusMs", () => {
	it("accumulates focus time without bumping updatedAt or history", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-04T00:00:00.000Z"));
		const task = await addTask(testProject, "T");
		const beforeUpdatedAt = task.updatedAt;

		vi.setSystemTime(new Date("2026-07-04T01:00:00.000Z"));
		await addTaskFocusMs(testProject, task.id, 90_000);
		await addTaskFocusMs(testProject, task.id, 30_000);

		const got = await getTask(testProject, task.id);
		expect(got.focusMs).toBe(120_000);
		expect(got.updatedAt).toBe(beforeUpdatedAt);
		expect(got.history).toHaveLength(1); // only the seeded 'created' entry
	});

	it("ignores non-positive deltas and unknown task ids", async () => {
		const task = await addTask(testProject, "T");
		await addTaskFocusMs(testProject, task.id, 0);
		await addTaskFocusMs(testProject, task.id, -50);
		await addTaskFocusMs(testProject, "nope", 1000);
		const got = await getTask(testProject, task.id);
		expect(got.focusMs ?? 0).toBe(0);
	});
});
