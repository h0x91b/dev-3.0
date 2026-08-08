import { afterAll, describe, expect, it, vi } from "vitest";
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
 * One frozen identity per test, handed to the body instead of read from module
 * scope.
 *
 * These tests suspend a `label.delete` handler on purpose, and a suspended test
 * that blows its time budget does NOT stop running: vitest fails it and starts
 * the next one while the abandoned body carries on. Per-test projects alone did
 * not separate them, because the body read the project id/path/slug from mutable
 * module scope LAZILY — so a corpse reaching `seed()` after the next test began
 * picked up THAT test's identity and wrote its fixture, and its injected
 * concurrent write, into that test's tasks.json. A context created synchronously
 * before the body's first await can only ever address its own project.
 *
 * `$HOME` cannot be varied per test instead: `vi.mock("../data")` keeps one
 * module instance alive for the whole file, so `vi.resetModules()` never
 * re-resolves `paths.ts` and `DEV3_HOME` is fixed at first import.
 */
interface TestCtx {
	readonly projectId: string;
	readonly projectPath: string;
	/** `projectSlug()` in git.ts: `/tmp/label-race-project-3` → `tmp-label-race-project-3`. */
	readonly projectSlug: string;
}

let testIndex = 0;
/** Every project seeded so far — projects.json is one shared file at the home root. */
const seededProjects: Project[] = [];

/**
 * Concurrent writes to inject once, keyed by the project whose `loadTasks` fires
 * them. Keying matters as much as the context does: a single shared slot let a
 * corpse arm an injection that the next test's handler then triggered.
 */
const injectAfterLoad = new Map<string, () => Promise<void>>();

vi.mock("../data", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../data")>();
	return {
		...actual,
		loadTasks: vi.fn(async (project: Project) => {
			const snapshot = await actual.loadTasks(project);
			const inject = injectAfterLoad.get(project.id);
			if (inject) {
				injectAfterLoad.delete(project.id);
				await inject();
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

function makeProject(ctx: TestCtx, overrides?: Partial<Project>): Project {
	return {
		id: ctx.projectId,
		name: "Label Race Project",
		path: ctx.projectPath,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-04-15T00:00:00.000Z",
		labels: [],
		...overrides,
	};
}

function makeTask(ctx: TestCtx, overrides?: Partial<Task>): Task {
	return {
		id: "task-1",
		seq: 1,
		projectId: ctx.projectId,
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

function seed(ctx: TestCtx, tasks: Task[], labels: Label[] = LABELS): Project {
	const project = makeProject(ctx, { labels });
	const existing = seededProjects.findIndex((p) => p.id === project.id);
	if (existing === -1) seededProjects.push(project);
	else seededProjects[existing] = project;
	writeFileSync(join(dev3Home, "projects.json"), JSON.stringify(seededProjects, null, 2));
	mkdirSync(join(dev3Home, "data", ctx.projectSlug), { recursive: true });
	writeFileSync(join(dev3Home, "data", ctx.projectSlug, "tasks.json"), JSON.stringify(tasks, null, 2));
	return project;
}

function readTasksRaw(ctx: TestCtx): Task[] {
	return JSON.parse(readFileSync(join(dev3Home, "data", ctx.projectSlug, "tasks.json"), "utf8")) as Task[];
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
function freshCtx(): TestCtx {
	vi.resetModules();
	process.env.HOME = tempHome;
	testIndex += 1;
	mkdirSync(dev3Home, { recursive: true });
	return {
		projectId: `proj-${testIndex}`,
		projectPath: `/tmp/label-race-project-${testIndex}`,
		projectSlug: `tmp-label-race-project-${testIndex}`,
	};
}

/**
 * Two dynamic imports, several file locks and a JSON round-trip per test. The
 * default 5s budget is not a correctness signal on a box that routinely runs
 * many agents at once, and blowing it is what produces the abandoned bodies the
 * context above defends against.
 */
const RACE_TEST_TIMEOUT = 30_000;

function raceIt(name: string, fn: (ctx: TestCtx) => Promise<void>): void {
	it(name, () => fn(freshCtx()), RACE_TEST_TIMEOUT);
}

describe("cli-socket label.delete — lost-update race", () => {
	afterAll(() => {
		process.env.HOME = originalHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	raceIt("does not clobber a concurrent labelIds change made after the snapshot is read", async (ctx) => {
		const data = await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		const project = seed(ctx, [makeTask(ctx, { id: "task-1", labelIds: [LABEL_DELETED, LABEL_KEPT] })]);

		// Concurrent UI write: user adds LABEL_CONCURRENT to the task in the window
		// between the handler's loadTasks() and its per-task update.
		injectAfterLoad.set(ctx.projectId, async () => {
			await data.updateTask(project, "task-1", {
				labelIds: [LABEL_DELETED, LABEL_KEPT, LABEL_CONCURRENT],
			});
		});

		const resp = await handleRequest(makeRequest("label.delete", { projectId: ctx.projectId, labelId: LABEL_DELETED }));
		expect(resp.ok).toBe(true);

		const [task] = readTasksRaw(ctx);
		// The deleted label must be gone...
		expect(task.labelIds).not.toContain(LABEL_DELETED);
		// ...and the kept label must survive...
		expect(task.labelIds).toContain(LABEL_KEPT);
		// ...and crucially the concurrently-added label must NOT be lost.
		expect(task.labelIds).toContain(LABEL_CONCURRENT);
	});

	raceIt("deletes the label from project and all tasks (no concurrency)", async (ctx) => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed(ctx, [
			makeTask(ctx, { id: "task-1", labelIds: [LABEL_DELETED, LABEL_KEPT] }),
			makeTask(ctx, { id: "task-2", seq: 2, labelIds: [LABEL_KEPT] }),
		]);

		const resp = await handleRequest(makeRequest("label.delete", { projectId: ctx.projectId, labelId: LABEL_DELETED }));
		expect(resp.ok).toBe(true);

		const tasks = readTasksRaw(ctx);
		expect(tasks.find((t) => t.id === "task-1")?.labelIds).toEqual([LABEL_KEPT]);
		expect(tasks.find((t) => t.id === "task-2")?.labelIds).toEqual([LABEL_KEPT]);

		expect(readProjectRaw(ctx.projectId).labels?.map((l) => l.id)).toEqual([LABEL_KEPT, LABEL_CONCURRENT]);
	});

	raceIt("keeps the CLI protocol response shape stable (backward compat)", async (ctx) => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed(ctx, [makeTask(ctx, { id: "task-1", labelIds: [LABEL_DELETED] })]);

		const resp = await handleRequest(makeRequest("label.delete", { projectId: ctx.projectId, labelId: LABEL_DELETED }));
		expect(resp.id).toBe("req-1");
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual({ deleted: LABEL_DELETED });
	});

	raceIt("persists tasks.json within the Task schema, readable after a downgrade (backward compat)", async (ctx) => {
		const data = await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		const seeded = makeTask(ctx, { id: "task-1", labelIds: [LABEL_DELETED, LABEL_KEPT] });
		seed(ctx, [seeded]);

		await handleRequest(makeRequest("label.delete", { projectId: ctx.projectId, labelId: LABEL_DELETED }));

		const [task] = readTasksRaw(ctx);
		// Every originally-seeded field is still present — nothing dropped, so an
		// older app version reading this file sees no missing data.
		for (const key of Object.keys(seeded)) {
			expect(task).toHaveProperty(key);
		}
		// labelIds stays a plain string[] (no shape change) with the deleted id removed.
		expect(Array.isArray(task.labelIds)).toBe(true);
		expect(task.labelIds).toEqual([LABEL_KEPT]);

		// The on-disk JSON round-trips cleanly back through the data layer.
		const project = await data.getProject(ctx.projectId);
		const reloaded = (await data.loadTasks(project)).find((t) => t.id === "task-1");
		expect(reloaded?.labelIds).toEqual([LABEL_KEPT]);
	});

	// Isolation guard: kill the neighbour deliberately instead of waiting for the
	// scheduler to do it under load, and assert its late write is unobservable.
	raceIt("does not observe a write from a neighbour abandoned mid-flight", async (ctx) => {
		let releaseNeighbour!: () => void;
		let neighbourSuspended!: () => void;
		const neighbourStalled = new Promise<void>((resolve) => { releaseNeighbour = resolve; });
		const neighbourReachedStall = new Promise<void>((resolve) => { neighbourSuspended = resolve; });

		const neighbourData = await import("../data");
		const { handleRequest: neighbourHandle } = await import("../cli-socket-server");
		const neighbourProject = seed(ctx, [makeTask(ctx, { id: "task-1", labelIds: [LABEL_DELETED, LABEL_KEPT] })]);

		injectAfterLoad.set(ctx.projectId, async () => {
			neighbourSuspended();
			await neighbourStalled;
			await neighbourData.updateTask(neighbourProject, "task-1", {
				labelIds: [LABEL_DELETED, LABEL_KEPT, LABEL_CONCURRENT],
			});
		});
		// Deliberately not awaited — this is the neighbour dying with a write pending.
		const abandoned = neighbourHandle(makeRequest("label.delete", { projectId: ctx.projectId, labelId: LABEL_DELETED }));
		await neighbourReachedStall;

		// The next test starts while the neighbour is still suspended.
		const next = freshCtx();
		const { handleRequest } = await import("../cli-socket-server");
		seed(next, [
			makeTask(next, { id: "task-1", labelIds: [LABEL_DELETED, LABEL_KEPT] }),
			makeTask(next, { id: "task-2", seq: 2, labelIds: [LABEL_KEPT] }),
		]);

		// The corpse finishes its write now, inside the next test's window.
		releaseNeighbour();
		await abandoned.catch(() => undefined);

		const resp = await handleRequest(makeRequest("label.delete", { projectId: next.projectId, labelId: LABEL_DELETED }));
		expect(resp.ok).toBe(true);

		const tasks = readTasksRaw(next);
		expect(tasks.find((t) => t.id === "task-1")?.labelIds).toEqual([LABEL_KEPT]);
		expect(tasks.find((t) => t.id === "task-2")?.labelIds).toEqual([LABEL_KEPT]);
	});

	// The corpse this file actually died of: a body abandoned BEFORE it seeded
	// anything, resuming inside the next test. It must build its fixture and fire
	// its injected write against its own project, never the live one.
	raceIt("a body abandoned before it seeds cannot adopt the next test's project", async (ctx) => {
		const data = await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		let releaseCorpse!: () => void;
		const corpseStalled = new Promise<void>((resolve) => { releaseCorpse = resolve; });

		// Suspended where the timed-out test was: past the imports, before seed().
		const corpse = (async () => {
			await corpseStalled;
			const corpseProject = seed(ctx, [makeTask(ctx, { id: "task-1", labelIds: [LABEL_DELETED, LABEL_KEPT] })]);
			injectAfterLoad.set(ctx.projectId, async () => {
				await data.updateTask(corpseProject, "task-1", {
					labelIds: [LABEL_DELETED, LABEL_KEPT, LABEL_CONCURRENT],
				});
			});
			await handleRequest(makeRequest("label.delete", { projectId: ctx.projectId, labelId: LABEL_DELETED }));
		})();

		const next = freshCtx();
		const { handleRequest: nextHandle } = await import("../cli-socket-server");
		seed(next, [makeTask(next, { id: "task-1", labelIds: [LABEL_DELETED, LABEL_KEPT] })]);

		releaseCorpse();
		await corpse.catch(() => undefined);

		const resp = await nextHandle(makeRequest("label.delete", { projectId: next.projectId, labelId: LABEL_DELETED }));
		expect(resp.ok).toBe(true);

		expect(readTasksRaw(next)[0].labelIds).toEqual([LABEL_KEPT]);
		// The corpse's own project still shows its work — it ran, it just landed elsewhere.
		expect(readTasksRaw(ctx)[0].labelIds).toContain(LABEL_CONCURRENT);
	});
});
