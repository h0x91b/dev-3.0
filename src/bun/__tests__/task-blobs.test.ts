import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Project, Task } from "../../shared/types";
import { splitTaskBlobs } from "../task-blobs";

const tempHome = mkdtempSync(join(tmpdir(), "dev3-task-blobs-"));
const dev3Home = join(tempHome, ".dev3.0");
const originalHome = process.env.HOME;

const PROJECT_SLUG = "tmp-blob-project";
const tasksDir = join(dev3Home, "data", PROJECT_SLUG);
const tasksFile = join(tasksDir, "tasks.json");
const blobsDir = join(tasksDir, "task-blobs");

function makeProject(): Project {
	return {
		id: "proj-1",
		name: "Blob Project",
		path: "/tmp/blob-project",
		setupScript: "",
		setupScriptLaunchMode: "parallel",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-08-16T00:00:00.000Z",
		labels: [],
		customColumns: [],
	};
}

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "task-1",
		seq: 1,
		projectId: "proj-1",
		title: "Task",
		description: "Task",
		status: "completed",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-08-16T00:00:00.000Z",
		updatedAt: "2026-08-16T00:00:00.000Z",
		labelIds: [],
		notes: [],
		customTitle: null,
		customColumnId: null,
		...overrides,
	};
}

/**
 * A task exactly as it sits on disk today: `fileStats` rides inside
 * `completedDiffStats` even though the type never declared it.
 */
function taskWithFileStats(overrides?: Partial<Task>): Task {
	return makeTask({
		completedDiffStats: {
			files: 2,
			insertions: 30,
			deletions: 4,
			capturedAt: "2026-08-16T10:00:00.000Z",
			fileStats: [
				{ path: "a.ts", insertions: 20, deletions: 1 },
				{ path: "b.ts", insertions: 10, deletions: 3 },
			],
		} as Task["completedDiffStats"],
		...overrides,
	});
}

describe("splitTaskBlobs — pure split rule", () => {
	it("moves fileStats out and leaves the declared diff numbers in place", () => {
		const task = taskWithFileStats();
		const split = splitTaskBlobs([task]);

		expect(split.changed).toBe(true);
		expect(split.blobs).toHaveLength(1);
		expect(split.blobs[0].taskId).toBe("task-1");
		expect(split.blobs[0].payload.completedDiffFileStats).toHaveLength(2);

		expect(split.tasks[0].completedDiffStats).toEqual({
			files: 2,
			insertions: 30,
			deletions: 4,
			capturedAt: "2026-08-16T10:00:00.000Z",
		});
	});

	it("never mutates the caller's task objects", () => {
		const task = taskWithFileStats();
		splitTaskBlobs([task]);
		expect((task.completedDiffStats as { fileStats?: unknown }).fileStats).toHaveLength(2);
	});

	it("is a no-op once the migration has run, so a steady-state save writes no sidecars", () => {
		const alreadyMigrated = makeTask({
			completedDiffStats: { files: 2, insertions: 30, deletions: 4, capturedAt: "2026-08-16T10:00:00.000Z" },
		});
		const split = splitTaskBlobs([alreadyMigrated]);

		expect(split.changed).toBe(false);
		expect(split.blobs).toHaveLength(0);
		expect(split.tasks[0]).toBe(alreadyMigrated);
	});

	it("ignores tasks with no diff stats and an empty fileStats array", () => {
		const empty = makeTask({
			id: "task-2",
			completedDiffStats: { files: 0, insertions: 0, deletions: 0, capturedAt: "x", fileStats: [] } as Task["completedDiffStats"],
		});
		const split = splitTaskBlobs([makeTask(), empty]);
		expect(split.changed).toBe(false);
		expect(split.blobs).toHaveLength(0);
	});
});

describe("saveTasks — sidecar migration on disk", () => {
	beforeEach(() => {
		vi.resetModules();
		process.env.HOME = tempHome;
		rmSync(tempHome, { recursive: true, force: true });
		mkdirSync(tasksDir, { recursive: true });
	});

	afterAll(() => {
		process.env.HOME = originalHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("archives fileStats into task-blobs/<taskId>.json on the first save", async () => {
		const data = await import("../data");
		await data.saveTasks(makeProject(), [taskWithFileStats()]);

		const persisted = JSON.parse(readFileSync(tasksFile, "utf8")) as Task[];
		expect((persisted[0].completedDiffStats as { fileStats?: unknown }).fileStats).toBeUndefined();
		expect(persisted[0].completedDiffStats?.insertions).toBe(30);

		const blob = JSON.parse(readFileSync(join(blobsDir, "task-1.json"), "utf8"));
		expect(blob.taskId).toBe("task-1");
		expect(blob.completedDiffFileStats).toEqual([
			{ path: "a.ts", insertions: 20, deletions: 1 },
			{ path: "b.ts", insertions: 10, deletions: 3 },
		]);
	});

	it("shrinks the file it migrates and writes one sidecar per affected task only", async () => {
		const data = await import("../data");
		const tasks = [taskWithFileStats(), taskWithFileStats({ id: "task-2", seq: 2 }), makeTask({ id: "task-3", seq: 3 })];
		const before = JSON.stringify(tasks).length;

		await data.saveTasks(makeProject(), tasks);

		expect(readFileSync(tasksFile, "utf8").length).toBeLessThan(before);
		expect(readdirSync(blobsDir).sort()).toEqual(["task-1.json", "task-2.json"]);
	});

	it("does not create the blobs directory when there is nothing to archive", async () => {
		const data = await import("../data");
		await data.saveTasks(makeProject(), [makeTask()]);
		expect(existsSync(blobsDir)).toBe(false);
	});

	it("merges into an existing blob instead of clobbering it", async () => {
		mkdirSync(blobsDir, { recursive: true });
		writeFileSync(
			join(blobsDir, "task-1.json"),
			JSON.stringify({ taskId: "task-1", savedAt: "2026-08-01T00:00:00.000Z", futureField: "keep me" }),
		);

		const data = await import("../data");
		await data.saveTasks(makeProject(), [taskWithFileStats()]);

		const blob = JSON.parse(readFileSync(join(blobsDir, "task-1.json"), "utf8"));
		expect(blob.futureField).toBe("keep me");
		expect(blob.completedDiffFileStats).toHaveLength(2);
	});
});

describe("history archive", () => {
	beforeEach(() => {
		vi.resetModules();
		process.env.HOME = tempHome;
		rmSync(tempHome, { recursive: true, force: true });
		mkdirSync(tasksDir, { recursive: true });
	});

	afterAll(() => {
		process.env.HOME = originalHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	const entry = (at: string, title: string) => ({ at, title, overview: null, changed: "title" as const });

	it("moves history to the sidecar and leaves an empty array behind", async () => {
		const data = await import("../data");
		await data.saveTasks(makeProject(), [
			makeTask({ history: [entry("2026-08-01T00:00:00.000Z", "first"), entry("2026-08-02T00:00:00.000Z", "second")] }),
		]);

		const persisted = JSON.parse(readFileSync(tasksFile, "utf8")) as Task[];
		expect(persisted[0].history).toEqual([]);

		const blob = JSON.parse(readFileSync(join(blobsDir, "task-1.json"), "utf8"));
		expect(blob.history.map((h: { title: string }) => h.title)).toEqual(["first", "second"]);
	});

	it("unions successive saves instead of replacing — an incremental append keeps the archive", async () => {
		const data = await import("../data");
		const project = makeProject();
		await data.saveTasks(project, [makeTask({ history: [entry("2026-08-01T00:00:00.000Z", "first")] })]);

		// What a later save looks like: the in-memory task was loaded AFTER the
		// migration, so it carries only the newly appended entry.
		await data.saveTasks(project, [makeTask({ history: [entry("2026-08-03T00:00:00.000Z", "third")] })]);

		const blob = JSON.parse(readFileSync(join(blobsDir, "task-1.json"), "utf8"));
		expect(blob.history.map((h: { title: string }) => h.title)).toEqual(["first", "third"]);
	});

	it("does not duplicate an entry that is saved twice", async () => {
		const data = await import("../data");
		const project = makeProject();
		const same = entry("2026-08-01T00:00:00.000Z", "first");
		await data.saveTasks(project, [makeTask({ history: [same] })]);
		await data.saveTasks(project, [makeTask({ history: [same] })]);

		const blob = JSON.parse(readFileSync(join(blobsDir, "task-1.json"), "utf8"));
		expect(blob.history).toHaveLength(1);
	});

	it("folds in entries a downgraded version wrote into tasks.json, in chronological order", async () => {
		const data = await import("../data");
		const project = makeProject();
		await data.saveTasks(project, [
			makeTask({ history: [entry("2026-08-01T00:00:00.000Z", "first"), entry("2026-08-05T00:00:00.000Z", "last")] }),
		]);

		// The old build knows nothing about the sidecar: it appends to the empty
		// history it found in tasks.json and writes the whole file back.
		const onOldVersion = JSON.parse(readFileSync(tasksFile, "utf8")) as Task[];
		onOldVersion[0].history = [entry("2026-08-03T00:00:00.000Z", "written on the old version")];
		writeFileSync(tasksFile, JSON.stringify(onOldVersion, null, 2));

		// Upgrade: the next save unions the rollback-window entry into the archive.
		vi.resetModules();
		const dataAgain = await import("../data");
		const tasks = await dataAgain.loadTasks(project);
		await dataAgain.saveTasks(project, tasks);

		const blob = JSON.parse(readFileSync(join(blobsDir, "task-1.json"), "utf8"));
		expect(blob.history.map((h: { title: string }) => h.title)).toEqual([
			"first",
			"written on the old version",
			"last",
		]);
	});
});

describe("downgrade safety", () => {
	beforeEach(() => {
		vi.resetModules();
		process.env.HOME = tempHome;
		rmSync(tempHome, { recursive: true, force: true });
		mkdirSync(tasksDir, { recursive: true });
	});

	afterAll(() => {
		process.env.HOME = originalHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("leaves a tasks.json an older version parses into an unchanged task list", async () => {
		const data = await import("../data");
		const task = taskWithFileStats();
		await data.saveTasks(makeProject(), [task]);

		// An older build only ever did JSON.parse(readFileSync(...)). It must get a
		// complete, valid task — the archived field is simply absent, and every
		// released version reads `completedDiffStats` through optional access.
		const asOldVersionSees = JSON.parse(readFileSync(tasksFile, "utf8")) as Task[];
		expect(asOldVersionSees).toHaveLength(1);
		expect(asOldVersionSees[0].id).toBe("task-1");
		expect(asOldVersionSees[0].status).toBe("completed");
		expect(asOldVersionSees[0].completedDiffStats).toEqual({
			files: 2,
			insertions: 30,
			deletions: 4,
			capturedAt: "2026-08-16T10:00:00.000Z",
		});
	});

	it("survives an older version rewriting tasks.json underneath: the sidecar is untouched", async () => {
		const data = await import("../data");
		await data.saveTasks(makeProject(), [taskWithFileStats()]);

		// Downgrade: the old build loads, edits an unrelated field, writes the whole
		// file back pretty-printed and knows nothing about task-blobs/.
		const reloaded = JSON.parse(readFileSync(tasksFile, "utf8")) as Task[];
		reloaded[0].overview = "edited on the old version";
		writeFileSync(tasksFile, JSON.stringify(reloaded, null, 2));

		// Upgrade again: the new build reads the old build's edit, and the archive
		// it never saw is still on disk, byte for byte.
		vi.resetModules();
		const dataAgain = await import("../data");
		const tasks = await dataAgain.loadTasks(makeProject());
		expect(tasks[0].overview).toBe("edited on the old version");

		const blob = JSON.parse(readFileSync(join(blobsDir, "task-1.json"), "utf8"));
		expect(blob.completedDiffFileStats).toHaveLength(2);
	});
});
