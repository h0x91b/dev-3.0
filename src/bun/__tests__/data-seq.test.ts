import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Project, Task } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-seq`);

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

afterEach(() => {
	vi.useRealTimers();
});

import { addTask, loadTasks, saveTasks, updateTask } from "../data";

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

function tasksBackupDirPath(): string {
	return `${TEST_HOME}/data/tmp-test-project/tasks-backups`;
}

function readBackupFileNames(): string[] {
	try {
		return readdirSync(tasksBackupDirPath()).sort();
	} catch {
		return [];
	}
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

// ============================================================
// Backfill tests
// ============================================================

describe("loadTasks — seq backfill", () => {
	it("keeps existing seq values and backfills the rest from max+1, in order", async () => {
		seedTasks([
			makeRawTask({ id: "a", seq: 3 } as any),
			makeRawTask({ id: "b" }), // no seq
			makeRawTask({ id: "c", seq: 1 } as any),
			makeRawTask({ id: "d" }), // no seq
		]);

		const result = await loadTasks(testProject);

		expect(result.map((t) => t.seq)).toEqual([3, 4, 1, 5]);
	});

	it("assigns same seq to tasks sharing groupId", async () => {
		const tasks = [
			makeRawTask({ id: "a", groupId: "g1", variantIndex: 1 }),
			makeRawTask({ id: "b", groupId: "g1", variantIndex: 2 }),
			makeRawTask({ id: "c" }),
		];
		seedTasks(tasks);

		const result = await loadTasks(testProject);

		// a and b share groupId → same seq
		expect(result[0].seq).toBe(result[1].seq);
		// c gets a different seq
		expect(result[2].seq).not.toBe(result[0].seq);
	});

	it("keeps backfilled seq in memory without writing to disk, stable across loads", async () => {
		seedTasks([makeRawTask({ id: "a" }), makeRawTask({ id: "b" })]);

		const first = await loadTasks(testProject);
		expect(first.map((t) => t.seq)).toEqual([1, 2]);
		expect(readSavedTasks()[0].seq).toBeUndefined();
		expect((await loadTasks(testProject)).map((t) => t.seq)).toEqual([1, 2]);
	});

	it("returns an empty list for an empty or missing tasks file", async () => {
		expect(await loadTasks(testProject)).toHaveLength(0);
		seedTasks([]);
		expect(await loadTasks(testProject)).toHaveLength(0);
	});
});

// ============================================================
// addTask seq tests
// ============================================================

describe("addTask — seq assignment", () => {
	it("new task gets auto-incremented seq from the existing (or backfilled) max unless extras name one", async () => {
		seedTasks([{ ...makeRawTask({ id: "a" }), seq: 3 }]);
		expect((await addTask(testProject, "New task")).seq).toBe(4);
		{
		seedTasks([]);

		const task = await addTask(testProject, "New task", "todo", { seq: 42 });

		expect(task.seq).toBe(42);
		}
		{
		// Old tasks without seq
		const tasks = [
			makeRawTask({ id: "a" }),
			makeRawTask({ id: "b" }),
		];
		seedTasks(tasks);

		// loadTasks triggers backfill: a=1, b=2
		await loadTasks(testProject);

		// New task should get seq=3
		const newTask = await addTask(testProject, "New task");
		expect(newTask.seq).toBe(3);
		}
	});

	it("sequential addTask calls in an empty project produce 1, 2, 3", async () => {
		// No tasks file → empty list
		const t1 = await addTask(testProject, "Task 1");
		const t2 = await addTask(testProject, "Task 2");
		const t3 = await addTask(testProject, "Task 3");

		expect([t1.seq, t2.seq, t3.seq]).toEqual([1, 2, 3]);
	});

	it("addTask persists existingBranch (origin/ stripped for baseBranch) and omits it when not given", async () => {
		seedTasks([]);

		const task = await addTask(testProject, "Continue on branch", "todo", { existingBranch: "feature/login" });
		expect(task.existingBranch).toBe("feature/login");
		expect(task.baseBranch).toBe("feature/login");
		const loaded = await loadTasks(testProject);
		expect(loaded[0].existingBranch).toBe("feature/login");
		expect(loaded[0].baseBranch).toBe("feature/login");

		const remote = await addTask(testProject, "Continue on remote branch", "todo", { existingBranch: "origin/feature/login" });
		expect(remote.existingBranch).toBe("origin/feature/login");
		expect(remote.baseBranch).toBe("feature/login");

		const normal = await addTask(testProject, "Normal task");
		expect(normal.existingBranch).toBeUndefined();
		expect((await loadTasks(testProject)).find((t) => t.id === normal.id)?.existingBranch).toBeUndefined();
	});

	it("addTask persists the per-launch accountId (managed account and system-login null)", async () => {
		seedTasks([]);

		const managed = await addTask(testProject, "On a managed account", "todo", { accountId: "acc-123" });
		expect(managed.accountId).toBe("acc-123");
		expect((await loadTasks(testProject))[0].accountId).toBe("acc-123");

		seedTasks([]);
		// null is an explicit choice (system login) and must round-trip as null.
		const systemLogin = await addTask(testProject, "On the system login", "todo", { accountId: null });
		expect(systemLogin.accountId).toBeNull();
		expect((await loadTasks(testProject))[0].accountId).toBeNull();

		seedTasks([]);
		// Omitted means "use the registry default": the field stays unset.
		const unset = await addTask(testProject, "No explicit account");
		expect(unset.accountId).toBeUndefined();
		expect((await loadTasks(testProject))[0].accountId).toBeUndefined();
	});

});

// ============================================================
// addTask variant index tests
// ============================================================

describe("addTask — autoVariantIndex allocation", () => {
	it("assigns the next free variant index of the same group, ignoring other groups and never duplicating", async () => {
		seedTasks([
			makeRawTask({ id: "a", groupId: "g1", variantIndex: 1 }),
			makeRawTask({ id: "b", groupId: "g1", variantIndex: 2 }),
			makeRawTask({ id: "c", groupId: "other", variantIndex: 9 }),
		]);

		const task = await addTask(testProject, "Variant", "in-progress", { groupId: "g1", autoVariantIndex: true });

		expect(task.variantIndex).toBe(3);
		{
		seedTasks([makeRawTask({ id: "src", groupId: "g1", variantIndex: 1 })]);

		const t2 = await addTask(testProject, "V2", "in-progress", { groupId: "g1", autoVariantIndex: true });
		const t3 = await addTask(testProject, "V3", "in-progress", { groupId: "g1", autoVariantIndex: true });

		expect(t2.variantIndex).toBe(2);
		expect(t3.variantIndex).toBe(3);
		}
	});

	it("assigns 1 for a fresh group and nothing without a groupId", async () => {
		seedTasks([]);

		const fresh = await addTask(testProject, "Variant", "in-progress", { groupId: "g-new", autoVariantIndex: true });
		expect(fresh.variantIndex).toBe(1);
		const loner = await addTask(testProject, "Loner", "in-progress", { autoVariantIndex: true });
		expect(loner.variantIndex).toBeNull();
	});

});

describe("additive task fields", () => {
	it("preserves runtimeState and unknown fields across ordinary updates", async () => {
		seedTasks([{
			...makeRawTask({ id: "a", seq: 1 }),
			runtimeState: {
				runtime: "preparing",
				stage: "creating-worktree",
				runId: "run-1",
				updatedAt: 123,
			},
			futureFieldFromNewerVersion: { enabled: true },
		}]);

		await updateTask(testProject, "a", { title: "Updated title" });

		const saved = readSavedTasks()[0] as Task & { futureFieldFromNewerVersion?: { enabled: boolean } };
		expect(saved.runtimeState).toEqual({
			runtime: "preparing",
			stage: "creating-worktree",
			runId: "run-1",
			updatedAt: 123,
		});
		expect(saved.futureFieldFromNewerVersion).toEqual({ enabled: true });
	});
});

describe("tasks.json hourly backups", () => {
	it("captures the previous tasks.json once per hour before overwriting it", async () => {
		vi.useFakeTimers();

		const originalTasks = [{ ...makeRawTask({ id: "a", title: "Original", description: "Original" }), seq: 1 }];
		seedTasks(originalTasks);

		vi.setSystemTime(new Date("2026-04-22T10:05:00.000Z"));
		await updateTask(testProject, "a", { title: "First update" });
		expect(readSavedTasks()[0].title).toBe("First update");

		// A second write within the same hour adds no second backup.
		vi.setSystemTime(new Date("2026-04-22T10:45:00.000Z"));
		await updateTask(testProject, "a", { title: "Second update" });

		expect(readBackupFileNames()).toEqual(["2026-04-22T10Z.json"]);
		expect(JSON.parse(readFileSync(`${tasksBackupDirPath()}/2026-04-22T10Z.json`, "utf8"))).toEqual(originalTasks);
		expect(readSavedTasks()[0].title).toBe("Second update");
	});

	it("keeps only the latest 72 hourly backups", async () => {
		vi.useFakeTimers();

		seedTasks([{ ...makeRawTask({ id: "a", title: "Task 0", description: "Task 0" }), seq: 1 }]);

		for (let hour = 0; hour < 73; hour++) {
			vi.setSystemTime(new Date(`2026-04-${String(20 + Math.floor(hour / 24)).padStart(2, "0")}T${String(hour % 24).padStart(2, "0")}:00:00.000Z`));
			await saveTasks(testProject, readSavedTasks());
		}

		const backupFiles = readBackupFileNames();
		expect(backupFiles).toHaveLength(72);
		expect(backupFiles[0]).toBe("2026-04-20T01Z.json");
		expect(backupFiles[backupFiles.length - 1]).toBe("2026-04-23T00Z.json");
		expect(backupFiles).not.toContain("2026-04-20T00Z.json");
	});

	it("does not block task save when backup write fails", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-22T10:00:00.000Z"));

		const originalTasks = [{ ...makeRawTask({ id: "a", title: "Original", description: "Original" }), seq: 1 }];
		seedTasks(originalTasks);

		// Make the backup dir unwritable by pre-creating a file where mkdir would put the dir
		const backupDir = tasksBackupDirPath();
		writeFileSync(backupDir, "block"); // file in place of directory → mkdir will fail

		await expect(updateTask(testProject, "a", { title: "Updated" })).resolves.toBeDefined();
		expect(readSavedTasks()[0].title).toBe("Updated");

		rmSync(backupDir);
	});
});
