import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Project } from "../../shared/types";
import { taskOrigin } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-origin`);

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

import { addTask, loadTasks, moveTaskToProject, updateTask, updateTaskWith } from "../data";

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

const tasksFilePath = () => `${TEST_HOME}/data/tmp-test-project/tasks.json`;
const readSavedTasks = () => JSON.parse(readFileSync(tasksFilePath(), "utf8")) as Array<Record<string, unknown>>;
const PARENT = { kind: "task", taskId: "parent-1", projectId: "proj-9" } as const;

describe("task origin on disk", () => {
	it("stores a task origin and reads it back", async () => {
		const task = await addTask(testProject, "child", "todo", { origin: PARENT });
		expect(task.origin).toEqual(PARENT);
		expect(readSavedTasks()[0].origin).toEqual(PARENT);
	});

	it("stores no field for the user, and an absent field reads as the user", async () => {
		await addTask(testProject, "mine", "todo", { origin: { kind: "user" } });
		expect(readSavedTasks()[0]).not.toHaveProperty("origin");
		const [loaded] = await loadTasks(testProject);
		expect(taskOrigin(loaded)).toEqual({ kind: "user" });
	});

	it("reads a pre-lineage task, written without the field, as the user", async () => {
		mkdirSync(dirname(tasksFilePath()), { recursive: true });
		writeFileSync(tasksFilePath(), JSON.stringify([{
			id: "old", seq: 1, projectId: "proj-1", title: "Old", description: "", status: "todo",
			baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
			agentId: null, configId: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
		}]));
		const [loaded] = await loadTasks(testProject);
		expect(taskOrigin(loaded)).toEqual({ kind: "user" });
	});

	it("never lets an update set, change or clear the origin", async () => {
		const child = await addTask(testProject, "child", "todo", { origin: PARENT });
		const mine = await addTask(testProject, "mine", "todo");

		await updateTask(testProject, child.id, { origin: { kind: "user" }, customTitle: "renamed" });
		await updateTask(testProject, child.id, { origin: undefined });
		await updateTaskWith(testProject, mine.id, () => ({ updates: { origin: PARENT }, result: null }));

		const saved = readSavedTasks();
		expect(saved.find((t) => t.id === child.id)).toMatchObject({ origin: PARENT, customTitle: "renamed" });
		expect(saved.find((t) => t.id === mine.id)).not.toHaveProperty("origin");
	});
});

describe("task epic on disk", () => {
	const otherProject: Project = { ...testProject, id: "proj-2", name: "Other", path: "/tmp/other-project" };

	it("stores the epic id, and stores nothing for a task in no epic", async () => {
		await addTask(testProject, "in epic", "todo", { epicId: "epic-1" });
		await addTask(testProject, "loose", "todo");
		const [inEpic, loose] = readSavedTasks();
		expect(inEpic.epicId).toBe("epic-1");
		expect(loose).not.toHaveProperty("epicId");
	});

	it("clears the field on disk when an update removes the epic", async () => {
		const task = await addTask(testProject, "in epic", "todo", { epicId: "epic-1" });
		await updateTask(testProject, task.id, { epicId: undefined });
		expect(readSavedTasks()[0]).not.toHaveProperty("epicId");
	});

	it("keeps the epic through an unrelated update, as any build that preserves unknown keys does", async () => {
		mkdirSync(dirname(tasksFilePath()), { recursive: true });
		writeFileSync(tasksFilePath(), JSON.stringify([{
			id: "t1", seq: 1, projectId: "proj-1", title: "T", description: "", status: "todo",
			baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
			agentId: null, configId: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
			labelIds: [], epicId: "epic-1",
		}]));
		await updateTask(testProject, "t1", { customTitle: "renamed", labelIds: [] });
		expect(readSavedTasks()[0]).toMatchObject({ epicId: "epic-1", customTitle: "renamed" });
	});

	it("keeps the epic when the task moves to another project", async () => {
		const task = await addTask(testProject, "movable", "todo", { epicId: "epic-1" });
		const moved = await moveTaskToProject(testProject, otherProject, task.id);
		expect(moved.epicId).toBe("epic-1");
	});
});
