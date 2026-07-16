import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CustomColumn, Project, Task } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-dangling-custom-column`);

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
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

import { loadTasks, updateTask } from "../data";

const colX: CustomColumn = { id: "col-x", name: "Alpha", color: "#ff0000", llmInstruction: "" };

const testProject: Project = {
	id: "proj-1",
	name: "Test",
	path: "/tmp/test-project",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
	customColumns: [colX],
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

function makeRawTask(overrides: Partial<Task> & { id: string }): Record<string, unknown> {
	return {
		seq: 1,
		projectId: "proj-1",
		title: "Task",
		description: "desc",
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
		...overrides,
	};
}

describe("loadTasks — dangling customColumnId self-heal", () => {
	it("clears a dangling customColumnId to null on a mutator read and persists it", async () => {
		seedTasks([
			makeRawTask({ id: "dangling", seq: 1, customColumnId: "col-gone" }),
			makeRawTask({ id: "valid", seq: 2, customColumnId: "col-x" }),
		]);

		// updateTask reads with persistMigrations (under the file lock), heals all
		// dangling ids, then writes the full array back.
		await updateTask(testProject, "dangling", { title: "renamed" });

		const saved = readSavedTasks();
		const dangling = saved.find((t) => t.id === "dangling")!;
		const valid = saved.find((t) => t.id === "valid")!;
		expect(dangling.customColumnId).toBeNull();
		// A valid assignment is untouched.
		expect(valid.customColumnId).toBe("col-x");
	});

	it("treats every assignment as dangling when the project has no custom columns", async () => {
		seedTasks([makeRawTask({ id: "orphan", seq: 1, customColumnId: "col-x" })]);

		await updateTask({ ...testProject, customColumns: [] }, "orphan", { title: "renamed" });

		expect(readSavedTasks().find((t) => t.id === "orphan")!.customColumnId).toBeNull();
	});

	// --- Backward compatibility (definition of done) ---

	it("(compat a) loads a tasks.json with a dangling id without error and renders via the task list", async () => {
		// As written by a current/older version: the column id is still present on disk.
		seedTasks([makeRawTask({ id: "dangling", seq: 1, customColumnId: "col-gone" })]);

		// A pure read must not throw and must return the task. It does NOT rewrite
		// disk (only mutator reads heal) — the renderer falls back to the status
		// column, so the task is never lost.
		const before = statSync(tasksFilePath()).mtimeMs;
		const loaded = await loadTasks(testProject);
		expect(loaded).toHaveLength(1);
		expect(loaded[0].id).toBe("dangling");
		expect(statSync(tasksFilePath()).mtimeMs).toBe(before);
	});

	it("(compat b) a tasks.json written after the heal adds no new fields beyond the existing Task shape", async () => {
		seedTasks([
			makeRawTask({ id: "dangling", seq: 1, customColumnId: "col-gone" }),
			makeRawTask({ id: "valid", seq: 2, customColumnId: "col-x" }),
		]);

		await updateTask(testProject, "valid", { title: "renamed" });

		const saved = readSavedTasks();
		const healed = saved.find((t) => t.id === "dangling")!;
		const untouched = saved.find((t) => t.id === "valid")!;

		// The heal only flips an existing field's VALUE to null (a value older
		// versions already tolerate via the backfill) — it must not introduce any
		// new key. Both tasks pass through identical backfills, so a field added
		// only on the healed task would surface as a key-set difference.
		expect(Object.keys(healed).sort()).toEqual(Object.keys(untouched).sort());
		expect(healed.customColumnId).toBeNull();
		// No bespoke heal-marker field leaked into the schema.
		expect(healed).not.toHaveProperty("customColumnIdHealed");
		expect(healed).not.toHaveProperty("danglingCustomColumnId");
	});
});
