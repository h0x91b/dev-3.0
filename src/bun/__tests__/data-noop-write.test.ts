import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Project, Task } from "../../shared/types";

// A task update that changes nothing must not rewrite tasks.json. On a big board
// (base44 runs a 14 MB file) an agent hook reporting an already-recorded value
// used to burn a full parse+serialize+write per call, ~11 times a second, pinning
// the event loop until the UI froze. See the 2026-08-16 freeze record.
//
// Proof is the inode: rawSaveTasks writes atomically through a rename, so every
// real save lands a new one and a skipped save leaves it alone.

const tempHome = mkdtempSync(join(tmpdir(), "dev3-noop-write-"));
const dev3Home = join(tempHome, ".dev3.0");
const originalHome = process.env.HOME;

const PROJECT_PATH = "/tmp/noop-write-project";
const PROJECT_SLUG = "tmp-noop-write-project";
const tasksFile = () => join(dev3Home, "data", PROJECT_SLUG, "tasks.json");

function makeProject(): Project {
	return {
		id: "proj-1",
		name: "No-op Write Project",
		path: PROJECT_PATH,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-08-16T00:00:00.000Z",
		labels: [],
	};
}

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "task-1",
		seq: 1,
		projectId: "proj-1",
		title: "No-op task",
		description: "No-op task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-08-16T00:00:00.000Z",
		updatedAt: "2026-08-16T00:00:00.000Z",
		notes: [],
		...overrides,
	};
}

/**
 * Seed the board and settle it: the first strict load persists schema migrations,
 * which is a legitimate write and would otherwise be mistaken for the no-op write
 * under test. Returns the project and the inode to measure against.
 */
async function seedSettled(task: Task): Promise<{ project: Project; inode: number }> {
	const project = makeProject();
	writeFileSync(join(dev3Home, "projects.json"), JSON.stringify([project], null, 2));
	mkdirSync(join(dev3Home, "data", PROJECT_SLUG), { recursive: true });
	writeFileSync(tasksFile(), JSON.stringify([task], null, 2));

	const data = await import("../data");
	await data.updateTask(project, task.id, { title: task.title });
	return { project, inode: statSync(tasksFile()).ino };
}

describe("data — a no-op task update never rewrites the file", () => {
	beforeEach(() => {
		vi.resetModules();
		process.env.HOME = tempHome;
		rmSync(tempHome, { recursive: true, force: true });
		mkdirSync(dev3Home, { recursive: true });
	});

	afterAll(() => {
		process.env.HOME = originalHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("updateTaskWith: a mutator returning no updates leaves the file untouched", async () => {
		const data = await import("../data");
		const { project, inode } = await seedSettled(makeTask());
		const settledAt = (await data.loadTasks(project))[0].updatedAt;

		// Five repeats, as an agent hook would fire them.
		for (let i = 0; i < 5; i++) {
			const { result } = await data.updateTaskWith(project, "task-1", () => ({
				updates: {},
				result: { changed: false },
			}));
			expect(result.changed).toBe(false);
		}

		expect(statSync(tasksFile()).ino).toBe(inode);
		expect((await data.loadTasks(project))[0].updatedAt).toBe(settledAt);
	});

	it("updateTaskWith: a mutator returning real updates does write", async () => {
		const data = await import("../data");
		const { project, inode } = await seedSettled(makeTask());

		await data.updateTaskWith(project, "task-1", () => ({
			updates: { title: "Renamed" },
			result: undefined,
		}));

		expect(statSync(tasksFile()).ino).not.toBe(inode);
		expect((await data.loadTasks(project))[0].title).toBe("Renamed");
	});

	it("updateTask: an empty patch leaves the file untouched", async () => {
		const data = await import("../data");
		const { project, inode } = await seedSettled(makeTask());
		const settledAt = (await data.loadTasks(project))[0].updatedAt;

		const updated = await data.updateTask(project, "task-1", {});

		expect(statSync(tasksFile()).ino).toBe(inode);
		expect(updated.updatedAt).toBe(settledAt);
	});

	it("updateTask: a blocked status guard leaves the file untouched", async () => {
		const data = await import("../data");
		const { project, inode } = await seedSettled(makeTask({ status: "todo" }));

		const updated = await data.updateTask(project, "task-1", { status: "in-progress" }, { ifStatusNot: "todo" });

		expect(statSync(tasksFile()).ino).toBe(inode);
		expect(updated.status).toBe("todo");
	});
});
