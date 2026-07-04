import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { CliRequest, Project, Task, TaskNote } from "../../shared/types";

const tempHome = mkdtempSync(join(tmpdir(), "dev3-note-race-"));
const dev3Home = join(tempHome, ".dev3.0");
const originalHome = process.env.HOME;

const PROJECT_PATH = "/tmp/note-race-project";
const PROJECT_SLUG = "tmp-note-race-project";

// Injected once, right after a handler reads its (now stale) task snapshot —
// simulates a concurrent note write landing in the window between the resolve
// read and the per-task update.
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
		name: "Note Race Project",
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

function seed(tasks: Task[]): Project {
	const project = makeProject();
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

describe("cli-socket note.add / note.delete — lost-update race", () => {
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

	it("note.add does not clobber a note added concurrently after the snapshot read", async () => {
		const data = await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		const project = seed([makeTask({ id: "task-1", notes: [] })]);

		// Concurrent write: another note lands between the handler's resolve read
		// and its own update.
		injectAfterLoad = async () => {
			await data.updateTask(project, "task-1", { notes: [makeNote("concurrent", "from other writer")] });
		};

		const resp = await handleRequest(makeRequest("note.add", { projectId: "proj-1", taskId: "task-1", content: "mine" }));
		expect(resp.ok).toBe(true);

		const [task] = readTasksRaw();
		const contents = (task.notes ?? []).map((n) => n.content).sort();
		// BOTH notes must survive — the concurrent one is not dropped.
		expect(contents).toEqual(["from other writer", "mine"]);
	});

	it("note.delete removes the target but keeps a concurrently-added note", async () => {
		const data = await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		const project = seed([makeTask({ id: "task-1", notes: [makeNote("to-delete", "delete me")] })]);

		injectAfterLoad = async () => {
			await data.updateTask(project, "task-1", {
				notes: [makeNote("to-delete", "delete me"), makeNote("concurrent", "keep me")],
			});
		};

		const resp = await handleRequest(makeRequest("note.delete", { projectId: "proj-1", taskId: "task-1", noteId: "to-delete" }));
		expect(resp.ok).toBe(true);

		const [task] = readTasksRaw();
		const ids = (task.notes ?? []).map((n) => n.id);
		expect(ids).not.toContain("to-delete");
		expect(ids).toContain("concurrent");
	});

	it("note.add still appends a note with no concurrency (happy path)", async () => {
		await import("../data");
		const { handleRequest } = await import("../cli-socket-server");

		seed([makeTask({ id: "task-1", notes: [makeNote("existing", "already here")] })]);

		const resp = await handleRequest(makeRequest("note.add", { projectId: "proj-1", taskId: "task-1", content: "new note" }));
		expect(resp.ok).toBe(true);

		const [task] = readTasksRaw();
		expect((task.notes ?? []).map((n) => n.content)).toEqual(["already here", "new note"]);
	});
});
