import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TASK_RELATION_TYPES } from "../../shared/types";
import type { Project, Task, TaskRelation } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-task-relations`);

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

import { addTask, loadTasks, updateTask } from "../data";

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

function seedTasks(tasks: unknown[]): void {
	mkdirSync(dirname(tasksFilePath()), { recursive: true });
	writeFileSync(tasksFilePath(), JSON.stringify(tasks));
}

function readSavedTasks(): Task[] {
	return JSON.parse(readFileSync(tasksFilePath(), "utf8"));
}

describe("task relation persistence", () => {
	it("exposes the reserved relation kinds", () => {
		expect(TASK_RELATION_TYPES).toEqual(["blocked-by", "relates-to"]);
	});

	it("initializes an empty relation collection for new tasks", async () => {
		const task = await addTask(testProject, "Fresh task");

		expect(task.relations).toEqual([]);
		expect(readSavedTasks()[0].relations).toEqual([]);
	});

	it("persists blocked-by and relates-to relation records", async () => {
		const blockedTask = await addTask(testProject, "Blocked task");
		const relatedTask = await addTask(testProject, "Related task");
		const relations: TaskRelation[] = [
			{ type: "blocked-by", taskId: relatedTask.id },
			{ type: "relates-to", taskId: blockedTask.id },
		];

		await updateTask(testProject, blockedTask.id, { relations });

		expect((await loadTasks(testProject)).find((task) => task.id === blockedTask.id)?.relations).toEqual(relations);
	});

	it("backfills the empty relation collection when a legacy task is mutated", async () => {
		seedTasks([
			{
				id: "legacy-task",
				seq: 1,
				projectId: testProject.id,
				title: "Legacy task",
				description: "Legacy task",
				status: "todo",
				baseBranch: "main",
				worktreePath: null,
				branchName: null,
				groupId: null,
				variantIndex: null,
				agentId: null,
				configId: null,
				createdAt: "2025-01-01T00:00:00Z",
				updatedAt: "2025-01-01T00:00:00Z",
			},
		]);

		await updateTask(testProject, "legacy-task", { title: "Updated task" });

		expect(readSavedTasks()[0].relations).toEqual([]);
	});
});
