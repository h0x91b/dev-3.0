import { afterAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { CliRequest, Project, Task, TaskNote } from "../../shared/types";

const tempHome = mkdtempSync(join(tmpdir(), "dev3-note-race-"));
const dev3Home = join(tempHome, ".dev3.0");
const originalHome = process.env.HOME;

/**
 * One frozen identity per test, handed to the body instead of read from module
 * scope.
 *
 * These tests suspend a handler on purpose, and a suspended test that blows its
 * time budget does NOT stop running: vitest fails it and starts the next one
 * while the abandoned body carries on. Per-test projects alone did not separate
 * them, because the body read the project id/path/slug from mutable module scope
 * LAZILY — so a corpse reaching `seed()` after the next test began picked up
 * THAT test's identity and wrote its fixture, and its injected concurrent write,
 * into that test's tasks.json. A context created synchronously before the body's
 * first await can only ever address its own project.
 *
 * `$HOME` cannot be varied per test instead: `vi.mock("../data")` keeps one
 * module instance alive for the whole file, so `vi.resetModules()` never
 * re-resolves `paths.ts` and `DEV3_HOME` is fixed at first import.
 */
interface TestCtx {
	readonly projectId: string;
	readonly projectPath: string;
	/** `projectSlug()` in git.ts: `/tmp/note-race-project-3` → `tmp-note-race-project-3`. */
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
		name: "Note Race Project",
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
		title: "Note race task",
		description: "Note race task",
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

function makeNote(id: string, content: string): TaskNote {
	return { id, content, source: "ai", createdAt: "2026-04-15T00:00:00.000Z", updatedAt: "2026-04-15T00:00:00.000Z" };
}

function seed(ctx: TestCtx, tasks: Task[]): Project {
	const project = makeProject(ctx);
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
		projectPath: `/tmp/note-race-project-${testIndex}`,
		projectSlug: `tmp-note-race-project-${testIndex}`,
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

describe("cli-socket note.add / note.delete — lost-update race", () => {
	afterAll(() => {
		process.env.HOME = originalHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	raceIt("note.add does not clobber a note added concurrently after the snapshot read", async (ctx) => {
		const data = await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		const project = seed(ctx, [makeTask(ctx, { id: "task-1", notes: [] })]);

		// Concurrent write: another note lands between the handler's resolve read
		// and its own update.
		injectAfterLoad.set(ctx.projectId, async () => {
			await data.updateTask(project, "task-1", { notes: [makeNote("concurrent", "from other writer")] });
		});

		const resp = await handleRequest(makeRequest("note.add", { projectId: ctx.projectId, taskId: "task-1", content: "mine" }));
		expect(resp.ok).toBe(true);

		const [task] = readTasksRaw(ctx);
		const contents = (task.notes ?? []).map((n) => n.content).sort();
		// BOTH notes must survive — the concurrent one is not dropped.
		expect(contents).toEqual(["from other writer", "mine"]);
	});

	raceIt("note.delete removes the target but keeps a concurrently-added note", async (ctx) => {
		const data = await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		const project = seed(ctx, [makeTask(ctx, { id: "task-1", notes: [makeNote("to-delete", "delete me")] })]);

		injectAfterLoad.set(ctx.projectId, async () => {
			await data.updateTask(project, "task-1", {
				notes: [makeNote("to-delete", "delete me"), makeNote("concurrent", "keep me")],
			});
		});

		const resp = await handleRequest(makeRequest("note.delete", { projectId: ctx.projectId, taskId: "task-1", noteId: "to-delete" }));
		expect(resp.ok).toBe(true);

		const [task] = readTasksRaw(ctx);
		const ids = (task.notes ?? []).map((n) => n.id);
		expect(ids).not.toContain("to-delete");
		expect(ids).toContain("concurrent");
	});

	raceIt("note.add evicts the oldest note once the task is at the retention cap", async (ctx) => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");
		const { MAX_TASK_NOTES_KEPT } = await import("../../shared/types");

		const full = Array.from({ length: MAX_TASK_NOTES_KEPT }, (_, i) => makeNote(`n${i}`, `note ${i}`));
		seed(ctx, [makeTask(ctx, { id: "task-1", notes: full })]);

		const resp = await handleRequest(makeRequest("note.add", { projectId: ctx.projectId, taskId: "task-1", content: "newest" }));
		expect(resp.ok).toBe(true);

		const [task] = readTasksRaw(ctx);
		const notes = task.notes ?? [];
		expect(notes).toHaveLength(MAX_TASK_NOTES_KEPT);
		// Oldest gone, everything after it kept in order, newest at the end.
		expect(notes.map((n) => n.id)).not.toContain("n0");
		expect(notes[0].id).toBe("n1");
		expect(notes[notes.length - 1].content).toBe("newest");
	});

	raceIt("note.add trims a task that is already over the cap from before the limit existed", async (ctx) => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");
		const { MAX_TASK_NOTES_KEPT } = await import("../../shared/types");

		const over = Array.from({ length: MAX_TASK_NOTES_KEPT + 93 }, (_, i) => makeNote(`n${i}`, `note ${i}`));
		seed(ctx, [makeTask(ctx, { id: "task-1", notes: over })]);

		expect((await handleRequest(makeRequest("note.add", { projectId: ctx.projectId, taskId: "task-1", content: "newest" }))).ok).toBe(true);

		const notes = readTasksRaw(ctx)[0].notes ?? [];
		expect(notes).toHaveLength(MAX_TASK_NOTES_KEPT);
		expect(notes[notes.length - 1].content).toBe("newest");
	});

	raceIt("note.add still appends a note with no concurrency (happy path)", async (ctx) => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed(ctx, [makeTask(ctx, { id: "task-1", notes: [makeNote("existing", "already here")] })]);

		const resp = await handleRequest(makeRequest("note.add", { projectId: ctx.projectId, taskId: "task-1", content: "new note" }));
		expect(resp.ok).toBe(true);

		const [task] = readTasksRaw(ctx);
		expect((task.notes ?? []).map((n) => n.content)).toEqual(["already here", "new note"]);
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
		const neighbourProject = seed(ctx, [makeTask(ctx, { id: "task-1", notes: [] })]);

		injectAfterLoad.set(ctx.projectId, async () => {
			neighbourSuspended();
			await neighbourStalled;
			await neighbourData.updateTask(neighbourProject, "task-1", {
				notes: [makeNote("concurrent", "from other writer")],
			});
		});
		// Deliberately not awaited — this is the neighbour dying with a write pending.
		const abandoned = neighbourHandle(makeRequest("note.add", { projectId: ctx.projectId, taskId: "task-1", content: "mine" }));
		await neighbourReachedStall;

		// The next test starts while the neighbour is still suspended.
		const next = freshCtx();
		const { handleRequest } = await import("../cli-socket-server");
		seed(next, [makeTask(next, { id: "task-1", notes: [makeNote("existing", "already here")] })]);

		// The corpse finishes its write now, inside the next test's window.
		releaseNeighbour();
		await abandoned.catch(() => undefined);

		const resp = await handleRequest(makeRequest("note.add", { projectId: next.projectId, taskId: "task-1", content: "new note" }));
		expect(resp.ok).toBe(true);

		const [task] = readTasksRaw(next);
		expect((task.notes ?? []).map((n) => n.content)).toEqual(["already here", "new note"]);
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
			const corpseProject = seed(ctx, [makeTask(ctx, { id: "task-1", notes: [] })]);
			injectAfterLoad.set(ctx.projectId, async () => {
				await data.updateTask(corpseProject, "task-1", { notes: [makeNote("concurrent", "from other writer")] });
			});
			await handleRequest(makeRequest("note.add", { projectId: ctx.projectId, taskId: "task-1", content: "mine" }));
		})();

		const next = freshCtx();
		const { handleRequest: nextHandle } = await import("../cli-socket-server");
		seed(next, [makeTask(next, { id: "task-1", notes: [makeNote("existing", "already here")] })]);

		releaseCorpse();
		await corpse.catch(() => undefined);

		const resp = await nextHandle(makeRequest("note.add", { projectId: next.projectId, taskId: "task-1", content: "new note" }));
		expect(resp.ok).toBe(true);

		expect((readTasksRaw(next)[0].notes ?? []).map((n) => n.content)).toEqual(["already here", "new note"]);
		// The corpse's own project still shows its work — it ran, it just landed elsewhere.
		expect((readTasksRaw(ctx)[0].notes ?? []).map((n) => n.content).sort()).toEqual(["from other writer", "mine"]);
	});
});
