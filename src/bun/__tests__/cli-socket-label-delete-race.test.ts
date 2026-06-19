import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { CliRequest, Label, Project, Task } from "../../shared/types";

const tempHome = mkdtempSync(join(tmpdir(), "dev3-label-race-"));
const dev3Home = join(tempHome, ".dev3.0");
const originalHome = process.env.HOME;

const PROJECT_PATH = "/tmp/label-race-project";
const PROJECT_SLUG = "tmp-label-race-project";

const LABEL_DELETED = "label-deleted-1111";
const LABEL_KEPT = "label-kept-2222";
const LABEL_CONCURRENT = "label-concurrent-3333";

// Injected once, right after the handler reads its (now stale) task snapshot
// inside `label.delete` — simulates a concurrent UI label change landing in the
// window between loadTasks() and the per-task update.
let injectAfterLoad: (() => Promise<void>) | null = null;

vi.mock("../data", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../data")>();
	return {
		...actual,
		loadTasks: vi.fn(async (project: Project) => {
			const snapshot = await actual.loadTasks(project);
			if (injectAfterLoad) {
				const run = injectAfterLoad;
				injectAfterLoad = null;
				await run();
			}
			return snapshot;
		}),
	};
});

// Break the electrobun import chain (../rpc-handlers → rpc-handlers/shared →
// ../electrobun-platform) so cli-socket-server can be imported under vitest.
// The label.delete handler only consumes getPushMessage from this barrel.
vi.mock("../rpc-handlers", () => ({
	isActive: vi.fn(() => true),
	activateTask: vi.fn(),
	getPushMessage: vi.fn(() => null),
	getPushMessageLocal: vi.fn(() => null),
	moveTask: vi.fn(),
	triggerColumnAgentIfNeeded: vi.fn(),
	notifyWatchedTaskStatusChange: vi.fn(),
}));

vi.mock("../rpc-handlers/tmux-pty", () => ({
	getDevServerStatus: vi.fn(),
	runDevServer: vi.fn(),
	stopDevServer: vi.fn(),
	restartDevServer: vi.fn(),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function makeProject(overrides?: Partial<Project>): Project {
	return {
		id: "proj-1",
		name: "Label Race Project",
		path: PROJECT_PATH,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-04-15T00:00:00.000Z",
		labels: [],
		...overrides,
	};
}

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "task-1",
		seq: 1,
		projectId: "proj-1",
		title: "Label race task",
		description: "Label race task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-04-15T00:00:00.000Z",
		updatedAt: "2026-04-15T00:00:00.000Z",
		notes: [],
		...overrides,
	};
}

const LABELS: Label[] = [
	{ id: LABEL_DELETED, name: "Deleted", color: "#ef4444" },
	{ id: LABEL_KEPT, name: "Kept", color: "#3b82f6" },
	{ id: LABEL_CONCURRENT, name: "Concurrent", color: "#22c55e" },
];

function seed(tasks: Task[], labels: Label[] = LABELS): Project {
	const project = makeProject({ labels });
	writeFileSync(join(dev3Home, "projects.json"), JSON.stringify([project], null, 2));
	mkdirSync(join(dev3Home, "data", PROJECT_SLUG), { recursive: true });
	writeFileSync(join(dev3Home, "data", PROJECT_SLUG, "tasks.json"), JSON.stringify(tasks, null, 2));
	return project;
}

function readTasksRaw(): Task[] {
	return JSON.parse(readFileSync(join(dev3Home, "data", PROJECT_SLUG, "tasks.json"), "utf8")) as Task[];
}

function makeRequest(method: string, params: Record<string, unknown>): CliRequest {
	return { id: "req-1", method, params };
}

describe("cli-socket label.delete — lost-update race", () => {
	beforeEach(() => {
		vi.resetModules();
		injectAfterLoad = null;
		process.env.HOME = tempHome;
		rmSync(tempHome, { recursive: true, force: true });
		mkdirSync(dev3Home, { recursive: true });
	});

	afterAll(() => {
		process.env.HOME = originalHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("does not clobber a concurrent labelIds change made after the snapshot is read", async () => {
		const data = await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		const project = seed([makeTask({ id: "task-1", labelIds: [LABEL_DELETED, LABEL_KEPT] })]);

		// Concurrent UI write: user adds LABEL_CONCURRENT to the task in the window
		// between the handler's loadTasks() and its per-task update.
		injectAfterLoad = async () => {
			await data.updateTask(project, "task-1", {
				labelIds: [LABEL_DELETED, LABEL_KEPT, LABEL_CONCURRENT],
			});
		};

		const resp = await handleRequest(makeRequest("label.delete", { projectId: "proj-1", labelId: LABEL_DELETED }));
		expect(resp.ok).toBe(true);

		const [task] = readTasksRaw();
		// The deleted label must be gone...
		expect(task.labelIds).not.toContain(LABEL_DELETED);
		// ...and the kept label must survive...
		expect(task.labelIds).toContain(LABEL_KEPT);
		// ...and crucially the concurrently-added label must NOT be lost.
		expect(task.labelIds).toContain(LABEL_CONCURRENT);
	});

	it("deletes the label from project and all tasks (no concurrency)", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed([
			makeTask({ id: "task-1", labelIds: [LABEL_DELETED, LABEL_KEPT] }),
			makeTask({ id: "task-2", seq: 2, labelIds: [LABEL_KEPT] }),
		]);

		const resp = await handleRequest(makeRequest("label.delete", { projectId: "proj-1", labelId: LABEL_DELETED }));
		expect(resp.ok).toBe(true);

		const tasks = readTasksRaw();
		expect(tasks.find((t) => t.id === "task-1")?.labelIds).toEqual([LABEL_KEPT]);
		expect(tasks.find((t) => t.id === "task-2")?.labelIds).toEqual([LABEL_KEPT]);

		const projects = JSON.parse(readFileSync(join(dev3Home, "projects.json"), "utf8")) as Project[];
		expect(projects[0].labels?.map((l) => l.id)).toEqual([LABEL_KEPT, LABEL_CONCURRENT]);
	});

	it("keeps the CLI protocol response shape stable (backward compat)", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed([makeTask({ id: "task-1", labelIds: [LABEL_DELETED] })]);

		const resp = await handleRequest(makeRequest("label.delete", { projectId: "proj-1", labelId: LABEL_DELETED }));
		expect(resp.id).toBe("req-1");
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual({ deleted: LABEL_DELETED });
	});

	it("persists tasks.json within the Task schema, readable after a downgrade (backward compat)", async () => {
		const data = await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		const seeded = makeTask({ id: "task-1", labelIds: [LABEL_DELETED, LABEL_KEPT] });
		seed([seeded]);

		await handleRequest(makeRequest("label.delete", { projectId: "proj-1", labelId: LABEL_DELETED }));

		const [task] = readTasksRaw();
		// Every originally-seeded field is still present — nothing dropped, so an
		// older app version reading this file sees no missing data.
		for (const key of Object.keys(seeded)) {
			expect(task).toHaveProperty(key);
		}
		// labelIds stays a plain string[] (no shape change) with the deleted id removed.
		expect(Array.isArray(task.labelIds)).toBe(true);
		expect(task.labelIds).toEqual([LABEL_KEPT]);

		// The on-disk JSON round-trips cleanly back through the data layer.
		const project = await data.getProject("proj-1");
		const reloaded = (await data.loadTasks(project)).find((t) => t.id === "task-1");
		expect(reloaded?.labelIds).toEqual([LABEL_KEPT]);
	});
});
