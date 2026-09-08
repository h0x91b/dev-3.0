import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Project, Task } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-hidden`);

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

import { addTask, loadTasks, setTaskHidden } from "../data";

const project: Project = {
	id: "project-1",
	name: "Test",
	path: "/tmp/hidden-test-project",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2026-01-01T00:00:00Z",
};

function makeTask(overrides: Partial<Task> & { id: string; seq: number }): Task {
	return {
		projectId: project.id,
		title: "Task",
		description: "Task",
		status: "in-progress",
		priority: "P3",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		labelIds: [],
		...overrides,
	};
}

function tasksFilePath(): string {
	return `${TEST_HOME}/data/tmp-hidden-test-project/tasks.json`;
}

function seedTasks(tasks: Task[]): void {
	mkdirSync(dirname(tasksFilePath()), { recursive: true });
	writeFileSync(tasksFilePath(), JSON.stringify(tasks));
}

function savedTasks(): Task[] {
	return JSON.parse(readFileSync(tasksFilePath(), "utf8"));
}

describe("setTaskHidden", () => {
	it("hides every variant without changing tasks outside the group", async () => {
		seedTasks([
			makeTask({
				id: "variant-1", seq: 1, groupId: "group-1", variantIndex: 1,
				priority: "P0", watched: true, labelIds: ["label-1"],
				worktreePath: "/tmp/hidden-test-worktree", branchName: "feat/hidden-test",
				movedAt: "2026-01-02T00:00:00Z", statusEnteredAt: "2026-01-02T00:00:00Z",
				lifecycleStartedAt: "2026-01-01T00:00:00Z",
			}),
			makeTask({ id: "variant-2", seq: 1, groupId: "group-1", variantIndex: 2 }),
			makeTask({ id: "other", seq: 2 }),
		]);
		const before = await loadTasks(project);

		const changed = await setTaskHidden(project, "variant-1", true);

		expect(changed.map((task) => task.id)).toEqual(["variant-1", "variant-2"]);
		expect(savedTasks()).toEqual([
			{ ...before[0], hidden: true, updatedAt: expect.not.stringMatching(before[0].updatedAt) },
			{ ...before[1], hidden: true, updatedAt: expect.not.stringMatching(before[1].updatedAt) },
			before[2],
		]);
	});

	it("leaves an already visible task unchanged", async () => {
		seedTasks([]);
		const task = await addTask(project, "Visible task");
		const before = readFileSync(tasksFilePath(), "utf8");

		const changed = await setTaskHidden(project, task.id, false);

		expect(changed).toEqual([]);
		expect(readFileSync(tasksFilePath(), "utf8")).toBe(before);
	});

	it("unhides every hidden variant of the group and nothing outside it", async () => {
		seedTasks([
			makeTask({ id: "variant-1", seq: 1, groupId: "group-1", variantIndex: 1, hidden: true }),
			makeTask({ id: "variant-2", seq: 1, groupId: "group-1", variantIndex: 2, hidden: true }),
			makeTask({ id: "other", seq: 2, hidden: true }),
		]);

		const changed = await setTaskHidden(project, "variant-1", false);

		expect(changed.map((task) => task.id)).toEqual(["variant-1", "variant-2"]);
		const saved = savedTasks();
		// Revealing DELETES the field rather than storing `false`, so a revealed
		// task is byte-identical to one that was never hidden.
		const group = saved.filter((task) => task.groupId === "group-1");
		expect(group.map((task) => "hidden" in task)).toEqual([false, false]);
		expect(saved.find((task) => task.id === "other")?.hidden).toBe(true);
	});

	it("updates only the target when it has no variant group", async () => {
		seedTasks([
			makeTask({ id: "target", seq: 1 }),
			makeTask({ id: "other", seq: 2 }),
		]);

		const changed = await setTaskHidden(project, "target", true);

		expect(changed.map((task) => task.id)).toEqual(["target"]);
		expect(savedTasks().find((task) => task.id === "other")?.hidden).toBeUndefined();
	});
});

describe("addTask", () => {
	it("creates a new variant of a hidden group hidden", async () => {
		seedTasks([makeTask({ id: "source", seq: 1, groupId: "group-1", variantIndex: 1, hidden: true })]);

		const added = await addTask(project, "New attempt", "todo", { groupId: "group-1", autoVariantIndex: true });

		expect(added.hidden).toBe(true);
		expect(savedTasks().find((task) => task.id === added.id)?.hidden).toBe(true);
	});

	it("inherits hidden from a group whose first member lacks the field", async () => {
		seedTasks([
			makeTask({ id: "older", seq: 1, groupId: "group-1", variantIndex: 1 }),
			makeTask({ id: "hidden-sibling", seq: 1, groupId: "group-1", variantIndex: 2, hidden: true }),
		]);

		const added = await addTask(project, "New attempt", "todo", { groupId: "group-1", autoVariantIndex: true });

		expect(added.hidden).toBe(true);
	});
});
