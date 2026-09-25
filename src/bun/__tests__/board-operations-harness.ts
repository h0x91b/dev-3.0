import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { Label, Project, Task } from "../../shared/types";
import type { BoardPorts, BoardPushEvent } from "../board-operations/types";

/**
 * A real, disposable board for board-operation tests: a temp `$HOME` holding one
 * project and its tasks.json, read and written by the real `data.ts` (no mocks).
 * Modules that capture `DEV3_HOME` at import time must be imported AFTER
 * `createBoard()` — use `await import(...)` in the test body.
 */

export const PROJECT_PATH = "/tmp/board-ops-project";
const PROJECT_SLUG = "tmp-board-ops-project";

export interface RecordedPush {
	name: BoardPushEvent | string;
	payload: Record<string, unknown>;
}

export interface RecordingPorts extends BoardPorts {
	pushes: RecordedPush[];
	manualCompletionCalls: string[];
}

export function recordingPorts(): RecordingPorts {
	const pushes: RecordedPush[] = [];
	const manualCompletionCalls: string[] = [];
	return {
		pushes,
		manualCompletionCalls,
		push: (name, payload) => { pushes.push({ name, payload }); },
		manualCompletionChanged: (taskId) => { manualCompletionCalls.push(taskId); },
	};
}

export function makeProject(labels: Label[] = []): Project {
	return {
		id: "proj-1",
		name: "Board Ops Project",
		path: PROJECT_PATH,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-09-25T00:00:00.000Z",
		labels,
	};
}

export function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "task-1",
		seq: 1,
		projectId: "proj-1",
		title: "Board ops task",
		description: "Board ops task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-09-25T00:00:00.000Z",
		updatedAt: "2026-09-25T00:00:00.000Z",
		notes: [],
		...overrides,
	};
}

export interface Board {
	home: string;
	project: Project;
	tasksFile: string;
	/** Inode of tasks.json — atomic saves rename into place, so a real write changes it. */
	tasksInode(): number;
	/** Inode of projects.json, same idea. */
	projectsInode(): number;
	cleanup(): void;
}

/**
 * Seed and settle a board: the first strict load persists schema migrations, a
 * legitimate write that would otherwise read as the write under test.
 */
export async function createBoard(opts: { labels?: Label[]; tasks?: Task[] } = {}): Promise<Board> {
	vi.resetModules();
	const home = mkdtempSync(join(tmpdir(), "dev3-board-ops-"));
	const dev3Home = join(home, ".dev3.0");
	process.env.HOME = home;
	const project = makeProject(opts.labels ?? []);
	const tasksFile = join(dev3Home, "data", PROJECT_SLUG, "tasks.json");
	const projectsFile = join(dev3Home, "projects.json");
	mkdirSync(join(dev3Home, "data", PROJECT_SLUG), { recursive: true });
	writeFileSync(projectsFile, JSON.stringify([project], null, 2));
	const tasks = opts.tasks ?? [makeTask()];
	writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));

	const data = await import("../data");
	await data.updateTask(project, tasks[0].id, { title: tasks[0].title });
	await data.updateProject(project.id, { labels: project.labels });
	return {
		home,
		project: await data.getProject(project.id),
		tasksFile,
		tasksInode: () => statSync(tasksFile).ino,
		projectsInode: () => statSync(projectsFile).ino,
		cleanup: () => rmSync(home, { recursive: true, force: true }),
	};
}
