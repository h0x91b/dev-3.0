import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { CliRequest, Label, Project, Task } from "../../shared/types";

const tempHome = mkdtempSync(join(tmpdir(), "dev3-label-race-"));
const dev3Home = join(tempHome, ".dev3.0");
const originalHome = process.env.HOME;

const LABEL_DELETED = "label-deleted-1111";
const LABEL_KEPT = "label-kept-2222";
const LABEL_CONCURRENT = "label-concurrent-3333";

/**
 * Per-test identity, so no two tests ever address the same tasks.json.
 *
 * These tests suspend a `label.delete` handler on purpose. When one of them dies
 * while suspended (a timeout or hook death under load), its `updateTask` still
 * completes afterwards — and on a shared project that late write landed in the
 * NEXT test's tasks.json, which then read back a label it never seeded. `$HOME`
 * cannot be varied per test to separate them: `vi.mock("../data")` keeps one
 * module instance alive for the whole file, so `vi.resetModules()` never
 * re-resolves `paths.ts` and `DEV3_HOME` is fixed at first import. What CAN be
 * varied is the project — a different id and path means a different slug, a
 * different tasks.json, and nowhere for a neighbour's late write to be seen.
 */
let testIndex = 0;
let projectId = "";
let projectPath = "";
/** `projectSlug()` in git.ts: `/tmp/label-race-project-3` → `tmp-label-race-project-3`. */
let projectSlug = "";
/** Every project seeded so far — projects.json is one shared file at the home root. */
const seededProjects: Project[] = [];

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
		id: projectId,
		name: "Label Race Project",
		path: projectPath,
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
		projectId,
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
	seededProjects.push(project);
	writeFileSync(join(dev3Home, "projects.json"), JSON.stringify(seededProjects, null, 2));
	mkdirSync(join(dev3Home, "data", projectSlug), { recursive: true });
	writeFileSync(join(dev3Home, "data", projectSlug, "tasks.json"), JSON.stringify(tasks, null, 2));
	return project;
}

function readTasksRaw(slug: string = projectSlug): Task[] {
	return JSON.parse(readFileSync(join(dev3Home, "data", slug, "tasks.json"), "utf8")) as Task[];
}

function readProjectRaw(id: string): Project {
	const projects = JSON.parse(readFileSync(join(dev3Home, "projects.json"), "utf8")) as Project[];
	const found = projects.find((p) => p.id === id);
	if (!found) throw new Error(`Project not found on disk: ${id}`);
	return found;
}

function makeRequest(method: string, params: Record<string, unknown>): CliRequest {
	return { id: "req-1", method, params };
}

/** Begin a test on state nothing already in flight can reach. */
function enterFreshTest(): void {
	vi.resetModules();
	injectAfterLoad = null;
	process.env.HOME = tempHome;
	testIndex += 1;
	projectId = `proj-${testIndex}`;
	projectPath = `/tmp/label-race-project-${testIndex}`;
	projectSlug = `tmp-label-race-project-${testIndex}`;
	mkdirSync(dev3Home, { recursive: true });
}

describe("cli-socket label.delete — lost-update race", () => {
	beforeEach(enterFreshTest);

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

		const resp = await handleRequest(makeRequest("label.delete", { projectId, labelId: LABEL_DELETED }));
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

		const resp = await handleRequest(makeRequest("label.delete", { projectId, labelId: LABEL_DELETED }));
		expect(resp.ok).toBe(true);

		const tasks = readTasksRaw();
		expect(tasks.find((t) => t.id === "task-1")?.labelIds).toEqual([LABEL_KEPT]);
		expect(tasks.find((t) => t.id === "task-2")?.labelIds).toEqual([LABEL_KEPT]);

		expect(readProjectRaw(projectId).labels?.map((l) => l.id)).toEqual([LABEL_KEPT, LABEL_CONCURRENT]);
	});

	it("keeps the CLI protocol response shape stable (backward compat)", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed([makeTask({ id: "task-1", labelIds: [LABEL_DELETED] })]);

		const resp = await handleRequest(makeRequest("label.delete", { projectId, labelId: LABEL_DELETED }));
		expect(resp.id).toBe("req-1");
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual({ deleted: LABEL_DELETED });
	});

	it("persists tasks.json within the Task schema, readable after a downgrade (backward compat)", async () => {
		const data = await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		const seeded = makeTask({ id: "task-1", labelIds: [LABEL_DELETED, LABEL_KEPT] });
		seed([seeded]);

		await handleRequest(makeRequest("label.delete", { projectId, labelId: LABEL_DELETED }));

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
		const project = await data.getProject(projectId);
		const reloaded = (await data.loadTasks(project)).find((t) => t.id === "task-1");
		expect(reloaded?.labelIds).toEqual([LABEL_KEPT]);
	});

	// Isolation guard: kill the neighbour deliberately instead of waiting for the
	// scheduler to do it under load, and assert its late write is unobservable.
	it("does not observe a write from a neighbour abandoned mid-flight", async () => {
		let releaseNeighbour!: () => void;
		let neighbourSuspended!: () => void;
		const neighbourStalled = new Promise<void>((resolve) => { releaseNeighbour = resolve; });
		const neighbourReachedStall = new Promise<void>((resolve) => { neighbourSuspended = resolve; });

		const neighbourData = await import("../data");
		const { handleRequest: neighbourHandle } = await import("../cli-socket-server");
		const neighbourId = projectId;
		const neighbourProject = seed([makeTask({ id: "task-1", labelIds: [LABEL_DELETED, LABEL_KEPT] })]);

		injectAfterLoad = async () => {
			neighbourSuspended();
			await neighbourStalled;
			await neighbourData.updateTask(neighbourProject, "task-1", {
				labelIds: [LABEL_DELETED, LABEL_KEPT, LABEL_CONCURRENT],
			});
		};
		// Deliberately not awaited — this is the neighbour dying with a write pending.
		const abandoned = neighbourHandle(makeRequest("label.delete", { projectId: neighbourId, labelId: LABEL_DELETED }));
		await neighbourReachedStall;

		// The next test starts while the neighbour is still suspended.
		enterFreshTest();
		const { handleRequest } = await import("../cli-socket-server");
		seed([
			makeTask({ id: "task-1", labelIds: [LABEL_DELETED, LABEL_KEPT] }),
			makeTask({ id: "task-2", seq: 2, labelIds: [LABEL_KEPT] }),
		]);

		// The corpse finishes its write now, inside the next test's window.
		releaseNeighbour();
		await abandoned.catch(() => undefined);

		const resp = await handleRequest(makeRequest("label.delete", { projectId, labelId: LABEL_DELETED }));
		expect(resp.ok).toBe(true);

		const tasks = readTasksRaw();
		expect(tasks.find((t) => t.id === "task-1")?.labelIds).toEqual([LABEL_KEPT]);
		expect(tasks.find((t) => t.id === "task-2")?.labelIds).toEqual([LABEL_KEPT]);
	});
});
