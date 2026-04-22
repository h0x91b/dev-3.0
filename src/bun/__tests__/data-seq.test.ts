import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Project, Task } from "../../shared/types";

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/dev3-test-seq",
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync("/tmp/dev3-test-seq", { recursive: true, force: true });
	mkdirSync("/tmp/dev3-test-seq", { recursive: true });
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
	return "/tmp/dev3-test-seq/data/tmp-test-project/tasks.json";
}

function tasksBackupDirPath(): string {
	return "/tmp/dev3-test-seq/data/tmp-test-project/tasks-backups";
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
	it("assigns sequential seq to tasks without seq field", async () => {
		const tasks = [
			makeRawTask({ id: "a" }),
			makeRawTask({ id: "b" }),
			makeRawTask({ id: "c" }),
		];
		seedTasks(tasks);

		const result = await loadTasks(testProject);

		expect(result).toHaveLength(3);
		expect(result[0].seq).toBe(1);
		expect(result[1].seq).toBe(2);
		expect(result[2].seq).toBe(3);
	});

	it("respects existing seq values (starts from max+1)", async () => {
		const tasks = [
			makeRawTask({ id: "a", seq: 5 } as any),
			makeRawTask({ id: "b" }), // no seq
		];
		seedTasks(tasks);

		const result = await loadTasks(testProject);

		expect(result[0].seq).toBe(5);
		expect(result[1].seq).toBe(6);
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

	it("keeps backfilled seq in memory during loadTasks without writing to disk", async () => {
		const tasks = [makeRawTask({ id: "a" })];
		seedTasks(tasks);

		const loaded = await loadTasks(testProject);
		const saved = readSavedTasks();
		expect(loaded[0].seq).toBe(1);
		expect(saved[0].seq).toBeUndefined();
	});

	it("second load returns same seq values (no re-backfill)", async () => {
		const tasks = [
			makeRawTask({ id: "a" }),
			makeRawTask({ id: "b" }),
		];
		seedTasks(tasks);

		const first = await loadTasks(testProject);
		const second = await loadTasks(testProject);

		expect(first[0].seq).toBe(second[0].seq);
		expect(first[1].seq).toBe(second[1].seq);
	});

	it("handles mix of tasks with and without seq", async () => {
		const tasks = [
			makeRawTask({ id: "a", seq: 3 } as any),
			makeRawTask({ id: "b" }), // no seq
			makeRawTask({ id: "c", seq: 1 } as any),
			makeRawTask({ id: "d" }), // no seq
		];
		seedTasks(tasks);

		const result = await loadTasks(testProject);

		expect(result[0].seq).toBe(3); // kept
		expect(result[2].seq).toBe(1); // kept
		expect(result[1].seq).toBe(4); // backfilled from max(3)+1
		expect(result[3].seq).toBe(5); // backfilled
	});

	it("handles empty task list (no crash)", async () => {
		seedTasks([]);

		const result = await loadTasks(testProject);
		expect(result).toHaveLength(0);
	});

	it("handles no tasks file", async () => {
		// No file in store
		const result = await loadTasks(testProject);
		expect(result).toHaveLength(0);
	});
});

// ============================================================
// addTask seq tests
// ============================================================

describe("addTask — seq assignment", () => {
	it("new task gets auto-incremented seq", async () => {
		// Seed with one existing task
		const existing = [{ ...makeRawTask({ id: "a" }), seq: 3 }];
		seedTasks(existing);

		const task = await addTask(testProject, "New task");

		expect(task.seq).toBe(4);
	});

	it("explicit seq in extras is respected", async () => {
		seedTasks([]);

		const task = await addTask(testProject, "New task", "todo", { seq: 42 });

		expect(task.seq).toBe(42);
	});

	it("first task in empty project gets seq 1", async () => {
		// No tasks file → empty list
		const task = await addTask(testProject, "First task");

		expect(task.seq).toBe(1);
	});

	it("multiple sequential addTask calls produce unique seq values", async () => {
		seedTasks([]);

		const t1 = await addTask(testProject, "Task 1");
		const t2 = await addTask(testProject, "Task 2");
		const t3 = await addTask(testProject, "Task 3");

		expect(t1.seq).toBe(1);
		expect(t2.seq).toBe(2);
		expect(t3.seq).toBe(3);
	});

	it("addTask persists existingBranch and loadTasks reads it back", async () => {
		seedTasks([]);

		const task = await addTask(testProject, "Continue on branch", "todo", { existingBranch: "feature/login" });
		expect(task.existingBranch).toBe("feature/login");
		expect(task.baseBranch).toBe("feature/login");

		// Read back from disk
		const loaded = await loadTasks(testProject);
		expect(loaded[0].existingBranch).toBe("feature/login");
		expect(loaded[0].baseBranch).toBe("feature/login");
	});

	it("normalizes origin/ branch refs into task baseBranch", async () => {
		seedTasks([]);

		const task = await addTask(testProject, "Continue on remote branch", "todo", { existingBranch: "origin/feature/login" });

		expect(task.existingBranch).toBe("origin/feature/login");
		expect(task.baseBranch).toBe("feature/login");
	});

	it("addTask without existingBranch does not set the field", async () => {
		seedTasks([]);

		const task = await addTask(testProject, "Normal task");
		expect(task.existingBranch).toBeUndefined();

		const loaded = await loadTasks(testProject);
		expect(loaded[0].existingBranch).toBeUndefined();
	});

	it("addTask after backfill continues from correct seq", async () => {
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
	});
});

describe("tasks.json hourly backups", () => {
	it("captures the previous tasks.json once per hour before overwriting it", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-22T10:15:00.000Z"));

		const originalTasks = [{ ...makeRawTask({ id: "a", title: "Original", description: "Original" }), seq: 1 }];
		seedTasks(originalTasks);

		await updateTask(testProject, "a", { title: "Updated title" });

		const backupFiles = readBackupFileNames();
		expect(backupFiles).toEqual(["2026-04-22T10Z.json"]);
		expect(JSON.parse(readFileSync(`${tasksBackupDirPath()}/2026-04-22T10Z.json`, "utf8"))).toEqual(originalTasks);
		expect(readSavedTasks()[0].title).toBe("Updated title");
	});

	it("does not create a second backup file within the same hour", async () => {
		vi.useFakeTimers();

		const originalTasks = [{ ...makeRawTask({ id: "a", title: "Original", description: "Original" }), seq: 1 }];
		seedTasks(originalTasks);

		vi.setSystemTime(new Date("2026-04-22T10:05:00.000Z"));
		await updateTask(testProject, "a", { title: "First update" });

		vi.setSystemTime(new Date("2026-04-22T10:45:00.000Z"));
		await updateTask(testProject, "a", { title: "Second update" });

		const backupFiles = readBackupFileNames();
		expect(backupFiles).toEqual(["2026-04-22T10Z.json"]);
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

// ============================================================
// updateTask — columnOrder reset on status change
// ============================================================

describe("updateTask — clears columnOrder on status change", () => {
	it("clears columnOrder when status changes", async () => {
		const tasks = [{ ...makeRawTask({ id: "t1", status: "in-progress" as const }), seq: 1, columnOrder: 3, labelIds: [] }];
		seedTasks(tasks);

		const updated = await updateTask(testProject, "t1", { status: "completed" });

		expect(updated.columnOrder).toBeUndefined();
		expect(updated.movedAt).toBeDefined();
	});

	it("preserves columnOrder when status does not change", async () => {
		const tasks = [{ ...makeRawTask({ id: "t1", status: "in-progress" as const }), seq: 1, columnOrder: 3, labelIds: [] }];
		seedTasks(tasks);

		const updated = await updateTask(testProject, "t1", { title: "Updated title" });

		expect(updated.columnOrder).toBe(3);
		expect(updated.movedAt).toBeUndefined();
	});
});
