import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Project, Task } from "../../shared/types";
import { MAX_TASK_MOVEMENTS_KEPT } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-movements`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
	OPS_DIR: `${TEST_HOME}/ops`,
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

import { addTask, getTask, updateTask, _resetDataCaches } from "../data";

const testProject: Project = {
	id: "proj-1",
	name: "Test",
	path: "/tmp/test-movements",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

const TASKS_FILE = `${TEST_HOME}/data/tmp-test-movements/tasks.json`;

function readTasksFile(): Task[] {
	return JSON.parse(readFileSync(TASKS_FILE, "utf8")) as Task[];
}

describe("board movements are recorded because nothing else retains them", () => {
	it("stamps a created movement at the column the task appeared in", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-05T09:00:00.000Z"));
		const task = await addTask(testProject, "Fresh task");

		expect(task.movements).toEqual([
			expect.objectContaining({ at: "2026-09-05T09:00:00.000Z", kind: "created", to: "todo" }),
		]);
		expect(task.movements?.[0].from).toBeUndefined();
	});

	it("appends one movement per status change, keeping where it came from", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-05T09:00:00.000Z"));
		const task = await addTask(testProject, "Moving task");

		vi.setSystemTime(new Date("2026-09-05T09:10:00.000Z"));
		await updateTask(testProject, task.id, { status: "in-progress" });
		vi.setSystemTime(new Date("2026-09-05T09:20:00.000Z"));
		const done = await updateTask(testProject, task.id, { status: "completed" });

		expect(done.movements?.map((m) => [m.kind, m.from ?? null, m.to, m.at])).toEqual([
			["created", null, "todo", "2026-09-05T09:00:00.000Z"],
			["status", "todo", "in-progress", "2026-09-05T09:10:00.000Z"],
			["status", "in-progress", "completed", "2026-09-05T09:20:00.000Z"],
		]);
	});

	// Completion and cancellation are not their own kinds — they are the
	// destination of an ordinary move, so nothing double-fires.
	it("records cancellation as a move to cancelled, not as a separate kind", async () => {
		const task = await addTask(testProject, "Doomed task");
		const dead = await updateTask(testProject, task.id, { status: "cancelled" });

		const last = dead.movements?.[(dead.movements?.length ?? 0) - 1];
		expect(last).toMatchObject({ kind: "status", to: "cancelled" });
	});

	it("records a custom-column move that leaves the status alone", async () => {
		const task = await addTask(testProject, "Parked task");
		const parked = await updateTask(testProject, task.id, { customColumnId: "col-hold" });

		expect(parked.movements?.[(parked.movements?.length ?? 0) - 1]).toMatchObject({
			kind: "column",
			from: "todo",
			to: "todo",
			toColumnId: "col-hold",
		});
	});

	it("writes nothing for an edit that does not move the card", async () => {
		const task = await addTask(testProject, "Renamed task");
		const renamed = await updateTask(testProject, task.id, { customTitle: "A better title" });

		expect(renamed.movements).toHaveLength(1); // the creation entry, and only that
	});

	// A trimmed log must announce itself; otherwise a cursor's answer silently
	// claims to be the whole history.
	it("caps the log and counts what the cap destroyed", async () => {
		const task = await addTask(testProject, "Busy task");
		for (let i = 0; i < MAX_TASK_MOVEMENTS_KEPT + 3; i++) {
			await updateTask(testProject, task.id, { status: i % 2 === 0 ? "in-progress" : "todo" });
		}

		const busy = await getTask(testProject, task.id);
		expect(busy?.movements).toHaveLength(MAX_TASK_MOVEMENTS_KEPT);
		// 1 creation + 53 moves = 54 written, 50 kept.
		expect(busy?.movementsDropped).toBe(4);
		expect(busy?.movements?.[0].kind).toBe("status"); // the creation entry was the first evicted
	});

	// The on-disk invariants in AGENTS.md: a version that has never heard of
	// `movements` must round-trip the field rather than erase it.
	it("survives a write by a version that does not know the field", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-05T09:00:00.000Z"));
		const task = await addTask(testProject, "Round-tripped task");
		vi.setSystemTime(new Date("2026-09-05T09:05:00.000Z"));
		await updateTask(testProject, task.id, { status: "in-progress" });
		const before = readTasksFile();
		expect(before[0].movements).toHaveLength(2);

		// Exactly what an older version does: parse tasks.json into objects it
		// types without `movements`, touch a field it does know, serialize back.
		const asOldVersion = JSON.parse(readFileSync(TASKS_FILE, "utf8")) as Array<Record<string, unknown>>;
		asOldVersion[0] = { ...asOldVersion[0], title: "Renamed by an old build" };
		writeFileSync(TASKS_FILE, JSON.stringify(asOldVersion, null, 2));
		_resetDataCaches();

		const after = await getTask(testProject, task.id);
		expect(after?.title).toBe("Renamed by an old build");
		expect(after?.movements).toEqual(before[0].movements);
	});

	// The gap is disclosed, never papered over: a task written before this
	// shipped has no movements and none are manufactured for it.
	it("never backfills movements onto a task that predates the field", async () => {
		const task = await addTask(testProject, "Legacy task");
		const stripped = readTasksFile().map(({ movements: _gone, ...rest }) => rest);
		writeFileSync(TASKS_FILE, JSON.stringify(stripped, null, 2));
		_resetDataCaches();

		const loaded = await getTask(testProject, task.id);
		expect(loaded?.movements).toBeUndefined();

		// And the first real move starts the log from there, without inventing a past.
		const moved = await updateTask(testProject, task.id, { status: "in-progress" });
		expect(moved.movements?.map((m) => m.kind)).toEqual(["status"]);
	});
});
