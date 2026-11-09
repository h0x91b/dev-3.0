import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import type { Project } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-project-storage`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: `${TEST_HOME}/home`,
	OPS_DIR: `${TEST_HOME}/home/ops`,
}));

const lockHooks = vi.hoisted(() => ({ beforeRun: null as null | (() => void), locked: [] as string[] }));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(filePath: string, fn: () => Promise<T>): Promise<T> => {
		lockHooks.locked.push(filePath);
		const hook = lockHooks.beforeRun;
		lockHooks.beforeRun = null;
		hook?.();
		return fn();
	},
}));

import { addTask, loadTasks, moveTaskToProject } from "../data";
import { _resetStorageSwitches, recordStorageSwitch } from "../project-storage-live";
import { projectSlug } from "../git";

function project(id: string, name: string, storageRoot?: "project"): Project {
	return {
		id,
		name,
		path: `${TEST_HOME}/${name}`,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2025-01-01T00:00:00Z",
		...(storageRoot ? { storageRoot } : {}),
	};
}

const homeTasksFile = (p: Project) => `${TEST_HOME}/home/data/${projectSlug(p.path)}/tasks.json`;
const inProjectTasksFile = (p: Project) => `${p.path}/.dev3/data/tasks.json`;

beforeEach(() => {
	_resetStorageSwitches();
	lockHooks.beforeRun = null;
	lockHooks.locked = [];
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(`${TEST_HOME}/home`, { recursive: true });
});

describe("per-project storage root", () => {
	it("sends a write from a Project loaded before the switch to the new location", async () => {
		const stale = project("p-stale", "stale");
		mkdirSync(stale.path, { recursive: true });
		recordStorageSwitch(stale.id, "project");

		const task = await addTask(stale, "Written after the switch");

		expect(task.taskDirLocation).toBe("project");
		expect(existsSync(inProjectTasksFile(stale))).toBe(true);
		expect(existsSync(homeTasksFile(stale))).toBe(false);
	});

	it("retries on the new lock when the board moves while a writer waits on the old one", async () => {
		const moving = project("p-moving", "moving");
		mkdirSync(moving.path, { recursive: true });
		lockHooks.beforeRun = () => recordStorageSwitch(moving.id, "project");

		await addTask(moving, "Queued behind the switch");

		expect(lockHooks.locked).toEqual([homeTasksFile(moving), inProjectTasksFile(moving)]);
		expect(existsSync(inProjectTasksFile(moving))).toBe(true);
		expect(existsSync(homeTasksFile(moving))).toBe(false);
	});

	it("writes the board into the project folder and stamps new tasks", async () => {
		const acme = project("p-acme", "acme", "project");
		mkdirSync(acme.path, { recursive: true });

		const task = await addTask(acme, "Do the thing");

		expect(task.taskDirLocation).toBe("project");
		expect(existsSync(inProjectTasksFile(acme))).toBe(true);
		expect(existsSync(homeTasksFile(acme))).toBe(false);
		expect((await loadTasks(acme)).map((t) => t.id)).toEqual([task.id]);
	});

	it("leaves a default project's board and tasks in the dev3 home", async () => {
		const plain = project("p-plain", "plain");
		const task = await addTask(plain, "Do the thing");

		expect(task.taskDirLocation).toBeUndefined();
		expect(existsSync(homeTasksFile(plain))).toBe(true);
	});

	it("restamps a To Do task moved into an in-project board", async () => {
		const plain = project("p-plain", "plain");
		const acme = project("p-acme", "acme", "project");
		mkdirSync(acme.path, { recursive: true });
		const task = await addTask(plain, "Move me");

		const moved = await moveTaskToProject(plain, acme, task.id);

		expect(moved.taskDirLocation).toBe("project");
		const stored = JSON.parse(readFileSync(inProjectTasksFile(acme), "utf-8"));
		expect(stored[0].taskDirLocation).toBe("project");
	});

	it("clears the stamp when a task moves back to a home-stored board", async () => {
		const acme = project("p-acme", "acme", "project");
		const plain = project("p-plain", "plain");
		mkdirSync(acme.path, { recursive: true });
		const task = await addTask(acme, "Move me");

		const moved = await moveTaskToProject(acme, plain, task.id);

		expect(moved.taskDirLocation).toBeUndefined();
	});
});
