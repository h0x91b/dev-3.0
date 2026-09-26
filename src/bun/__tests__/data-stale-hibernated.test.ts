import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Project, Task } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-stale-hibernated`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));
vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
});

import { loadTasks, updateTask } from "../data";

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

function tasksFilePath(): string {
	return `${TEST_HOME}/data/tmp-test-project/tasks.json`;
}

function seed(tasks: Array<Partial<Task> & { id: string }>): void {
	mkdirSync(dirname(tasksFilePath()), { recursive: true });
	writeFileSync(tasksFilePath(), JSON.stringify(tasks.map((t, i) => ({
		seq: i + 1,
		projectId: "proj-1",
		title: "Task",
		description: "desc",
		status: "todo",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		...t,
	}))));
}

describe("loadTasks — stale hibernated flag on finished tasks", () => {
	it("clears it on completed and cancelled tasks but keeps it on a parked active one", async () => {
		seed([
			{ id: "done", status: "completed", hibernated: true },
			{ id: "dropped", status: "cancelled", hibernated: true },
			{ id: "parked", status: "in-progress", hibernated: true, worktreePath: "/wt" },
		]);

		const byId = new Map((await loadTasks(testProject)).map((t) => [t.id, t]));

		expect(byId.get("done")?.hibernated).toBe(false);
		expect(byId.get("dropped")?.hibernated).toBe(false);
		expect(byId.get("parked")?.hibernated).toBe(true);
	});

	it("persists the heal on a mutator read", async () => {
		seed([
			{ id: "done", status: "completed", hibernated: true },
			{ id: "other", status: "todo" },
		]);

		await updateTask(testProject, "other", { title: "renamed" });

		const saved = JSON.parse(readFileSync(tasksFilePath(), "utf8")) as Task[];
		expect(saved.find((t) => t.id === "done")?.hibernated).toBe(false);
	});
});
