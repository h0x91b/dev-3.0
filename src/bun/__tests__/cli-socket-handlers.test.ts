import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { Project, Task, CliRequest, TaskNote } from "../../shared/types";

// ---- Mocks ----

vi.mock("../data", () => ({
	loadProjects: vi.fn(),
	loadVirtualProjects: vi.fn(() => Promise.resolve([])),
	getProject: vi.fn(),
	loadTasks: vi.fn(),
	getTask: vi.fn(),
	addTask: vi.fn(),
	updateTask: vi.fn(),
	setTaskPriority: vi.fn(),
	updateTaskWith: vi.fn(),
	updateProject: vi.fn(),
	updateProjectWith: vi.fn(),
}));

vi.mock("../git", () => ({
	createWorktree: vi.fn(),
	removeWorktree: vi.fn(),
}));

vi.mock("../shared-images", () => ({
	SharedImageError: class SharedImageError extends Error {},
	saveSharedImage: vi.fn((_projectPath: string, src: string, caption?: string) => ({
		id: `img-${src}`,
		storedPath: `/wt/shared-images/${src.split("/").pop()}`,
		originalPath: src,
		name: src.split("/").pop() ?? src,
		mime: "image/png",
		bytes: 1,
		createdAt: 1,
		...(caption ? { caption } : {}),
	})),
	pruneSharedImages: vi.fn((existing: unknown[] | undefined, incoming: unknown[]) => ({
		kept: [...(existing ?? []), ...incoming],
		dropped: [],
	})),
	deleteSharedImageFiles: vi.fn(),
}));

vi.mock("../shared-artifacts", () => ({
	SharedArtifactError: class SharedArtifactError extends Error {},
	saveSharedArtifact: vi.fn((_projectPath: string, htmlPath: string, imagePaths: string[], title?: string) => ({
		id: "artifact-1",
		kind: "html",
		title: title || "report",
		name: "report.html",
		storedPath: "/wt/shared-artifacts/artifact-1/report.html",
		originalPath: htmlPath,
		bytes: 10,
		createdAt: 1,
		assets: imagePaths.map((path) => ({
			name: path.split("/").pop(),
			storedPath: `/wt/shared-artifacts/artifact-1/${path.split("/").pop()}`,
			originalPath: path,
			mime: "image/png",
			bytes: 1,
		})),
	})),
	pruneSharedArtifacts: vi.fn((existing: unknown[] | undefined, incoming: unknown[]) => ({
		kept: [...(existing ?? []), ...incoming],
		dropped: [],
	})),
	deleteSharedArtifactFiles: vi.fn(),
}));

vi.mock("../pty-server", () => ({
	destroySession: vi.fn(),
	getTmuxLayout: vi.fn(async () => ({ sessionName: "dev3-task1234", exists: false, windows: [], panes: [] })),
}));

vi.mock("../user-activity", () => ({
	getUserIdleSeconds: vi.fn(async () => 7),
}));

vi.mock("../rpc-handlers/tmux-pty", () => ({
	runDevServer: vi.fn(),
	stopDevServer: vi.fn(),
	restartDevServer: vi.fn(),
	getDevServerStatus: vi.fn(),
}));

vi.mock("../rpc-handlers", () => {
	const ACTIVE = ["in-progress", "user-questions", "review-by-user", "review-by-ai"];
	return {
		isActive: vi.fn((status: string) => ACTIVE.includes(status)),
		activateTask: vi.fn(),
		moveTask: vi.fn(),
		runCleanupScript: vi.fn(),
		emitTaskSound: vi.fn(),
		getPushMessage: vi.fn(() => null),
		triggerColumnAgentIfNeeded: vi.fn(),
		notifyWatchedTaskStatusChange: vi.fn(),
		notifyFromCliDesktop: vi.fn(),
		isAppForeground: vi.fn(() => false),
		getActiveContext: vi.fn(() => ({ projectId: null, taskId: null })),
	};
});

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/test-dev3",
}));

vi.mock("../socket-backpressure", () => ({
	flushAndEnd: vi.fn(),
	drainSocket: vi.fn(),
	pendingWrites: new Map(),
}));

vi.mock("../settings", () => ({
	loadSettings: vi.fn(() => ({ updateChannel: "stable", taskDropPosition: "top" })),
	saveSettings: vi.fn(),
}));

vi.mock("../vents", () => ({
	addVent: vi.fn(() => ({ fileName: "2026-06-15_14-30_x.md", path: "/tmp/v/2026-06-15_14-30_x.md", name: "x" })),
}));

vi.mock("../remote-access-server", () => ({
	getAccessUrl: vi.fn(async () => "http://10.0.0.5:41234/?token=fresh"),
	getServerPort: vi.fn(() => 0),
	getStaticCode: vi.fn(() => null),
}));

vi.mock("../cloudflare-tunnel", () => ({
	getTunnelUrl: vi.fn(() => null),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readdirSync: vi.fn(() => []),
	unlinkSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

import * as data from "../data";
import * as git from "../git";
import * as pty from "../pty-server";
import { activateTask, moveTask, runCleanupScript, emitTaskSound, getPushMessage, triggerColumnAgentIfNeeded, notifyFromCliDesktop, isAppForeground, getActiveContext } from "../rpc-handlers";
import { loadSettings } from "../settings";
import { runDevServer, stopDevServer, restartDevServer, getDevServerStatus } from "../rpc-handlers/tmux-pty";
import { flushAndEnd } from "../socket-backpressure";
import { existsSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import { addVent } from "../vents";
import { getServerPort } from "../remote-access-server";
import { saveSharedImage } from "../shared-images";
import { saveSharedArtifact } from "../shared-artifacts";

const { handleRequest, getSocketPath, startSocketServer, stopSocketServer } = await import(
	"../cli-socket-server"
);

// ---- Helpers ----

function makeProject(overrides?: Partial<Project>): Project {
	return {
		id: "proj-1",
		name: "Test Project",
		path: "/tmp/test-project",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "task-abc12345-1111-2222-3333-444444444444",
		seq: 1,
		projectId: "proj-1",
		title: "Test task",
		description: "A test task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		branchName: "dev3/task-test",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeRequest(method: string, params: Record<string, unknown> = {}): CliRequest {
	return { id: "req-1", method, params };
}

// ---- Tests ----

beforeEach(() => {
	vi.clearAllMocks();
});

describe("remote.accessUrl", () => {
	it("errors when no remote-access server is bound (serverPort 0)", async () => {
		vi.mocked(getServerPort).mockReturnValue(0);
		const resp = await handleRequest(makeRequest("remote.accessUrl"));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("not running");
	});

	it("returns a fresh access URL when the server is running", async () => {
		vi.mocked(getServerPort).mockReturnValue(41234);
		const resp = await handleRequest(makeRequest("remote.accessUrl"));
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({
			url: "http://10.0.0.5:41234/?token=fresh",
			port: 41234,
			tunnelUrl: null,
			staticCode: null,
		});
	});
});

describe("handleRequest dispatch", () => {
	it("returns error for unknown method", async () => {
		const resp = await handleRequest(makeRequest("unknown.method"));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Unknown method");
		expect(resp.id).toBe("req-1");
	});

	it("returns ok with data for valid method", async () => {
		const projects = [makeProject()];
		vi.mocked(data.loadProjects).mockResolvedValue(projects);

		const resp = await handleRequest(makeRequest("projects.list"));
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(projects);
	});

	it("catches handler errors and returns error response", async () => {
		vi.mocked(data.loadProjects).mockRejectedValue(new Error("DB failed"));

		const resp = await handleRequest(makeRequest("projects.list"));
		expect(resp.ok).toBe(false);
		expect(resp.error).toBe("DB failed");
	});

	it("handles non-Error throws gracefully", async () => {
		vi.mocked(data.loadProjects).mockRejectedValue("string error");

		const resp = await handleRequest(makeRequest("projects.list"));
		expect(resp.ok).toBe(false);
		expect(resp.error).toBe("string error");
	});
});

describe("task.agentHook", () => {
	function mockAtomicHookUpdate(project: Project, initialTask: Task): void {
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([initialTask]);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator: any) => {
			const { updates, result } = await mutator(initialTask);
			return { task: { ...initialTask, ...updates }, result };
		});
	}

	it("moves a resumed turn to in-progress", async () => {
		const project = makeProject();
		const task = makeTask({ status: "review-by-user" });
		mockAtomicHookUpdate(project, task);

		const response = await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id,
			projectId: project.id,
			event: "UserPromptSubmit",
		}));

		expect((response.data as Task).status).toBe("in-progress");
	});

	it("moves an approval request to user-questions", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		mockAtomicHookUpdate(project, task);

		const response = await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id,
			projectId: project.id,
			event: "PermissionRequest",
		}));

		expect((response.data as Task).status).toBe("user-questions");
	});

	it("returns to in-progress after an approved tool finishes", async () => {
		const project = makeProject();
		const task = makeTask({ status: "user-questions" });
		mockAtomicHookUpdate(project, task);

		const response = await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id,
			projectId: project.id,
			event: "PostToolUse",
		}));

		expect((response.data as Task).status).toBe("in-progress");
	});

	it("restores review-by-ai after a review agent approval finishes", async () => {
		const project = makeProject({ autoReviewEnabled: true });
		let storedTask = makeTask({ status: "review-by-ai" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockImplementation(async () => [storedTask]);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator: any) => {
			const { updates, result } = await mutator(storedTask);
			storedTask = { ...storedTask, ...updates };
			return { task: storedTask, result };
		});

		await handleRequest(makeRequest("task.agentHook", {
			taskId: storedTask.id,
			projectId: project.id,
			event: "PermissionRequest",
			sessionId: "review-session",
		}));
		const response = await handleRequest(makeRequest("task.agentHook", {
			taskId: storedTask.id,
			projectId: project.id,
			event: "PostToolUse",
			sessionId: "review-session",
		}));

		expect((response.data as Task).status).toBe("review-by-ai");
	});

	it("moves a normal Stop directly to review-by-user", async () => {
		const project = makeProject({ autoReviewEnabled: false });
		const task = makeTask({ status: "in-progress" });
		mockAtomicHookUpdate(project, task);

		const response = await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id,
			projectId: project.id,
			event: "Stop",
		}));

		expect((response.data as Task).status).toBe("review-by-user");
		expect(data.updateTaskWith).toHaveBeenCalledOnce();
	});

	it("moves a primary-agent Stop to review-by-ai when auto-review is enabled", async () => {
		const project = makeProject({ autoReviewEnabled: true });
		const task = makeTask({ status: "in-progress" });
		mockAtomicHookUpdate(project, task);

		const response = await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id,
			projectId: project.id,
			event: "Stop",
		}));

		expect((response.data as Task).status).toBe("review-by-ai");
	});

	it("moves a review-agent Stop to review-by-user in one atomic mutation", async () => {
		const project = makeProject({ autoReviewEnabled: true });
		const task = makeTask({ status: "review-by-ai" });
		mockAtomicHookUpdate(project, task);

		const response = await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id,
			projectId: project.id,
			event: "Stop",
		}));

		expect((response.data as Task).status).toBe("review-by-user");
	});

	it("does not overwrite an explicit user-questions status on Stop", async () => {
		const project = makeProject({ autoReviewEnabled: true });
		const task = makeTask({ status: "user-questions" });
		mockAtomicHookUpdate(project, task);

		const response = await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id,
			projectId: project.id,
			event: "Stop",
		}));

		expect((response.data as Task).status).toBe("user-questions");
	});

	it("starts the automatic review agent after the atomic Stop transition", async () => {
		const project = makeProject({ autoReviewEnabled: true });
		const task = makeTask({ status: "in-progress" });
		mockAtomicHookUpdate(project, task);

		await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id,
			projectId: project.id,
			event: "Stop",
		}));

		expect(triggerColumnAgentIfNeeded).toHaveBeenCalledOnce();
	});

	it("rejects unknown lifecycle events", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const response = await handleRequest(makeRequest("task.agentHook", {
			taskId: task.id,
			projectId: project.id,
			event: "FutureEvent",
		}));

		expect(response.error).toContain("Unsupported Codex hook event");
	});

	function mockStatefulHookUpdate(project: Project, initial: Task): { get: () => Task } {
		let stored = initial;
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockImplementation(async () => [stored]);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_p, _t, mutator: any) => {
			const { updates, result } = await mutator(stored);
			stored = { ...stored, ...updates };
			return { task: stored, result };
		});
		return { get: () => stored };
	}

	type Pane = NonNullable<Task["sessionState"]>["panes"][number];
	const codexPane = (paneId: string | null, sessionId: string | null): Pane =>
		({ paneId, agentCmd: "codex", sessionId, agentId: null, configId: null });

	it("captures the Codex session id onto the pane matching $TMUX_PANE", async () => {
		const project = makeProject();
		const store = mockStatefulHookUpdate(project, makeTask({
			status: "in-progress",
			sessionState: { panes: [codexPane("%1", null), codexPane("%2", null)] },
		}));

		await handleRequest(makeRequest("task.agentHook", {
			taskId: store.get().id,
			projectId: project.id,
			event: "SessionStart",
			sessionId: "codex-sess-2",
			paneId: "%2",
		}));

		const panes = store.get().sessionState?.panes ?? [];
		expect(panes[0]?.sessionId).toBeNull();
		expect(panes[1]?.sessionId).toBe("codex-sess-2");
	});

	it("adopts the lone null-paneId (main) pane when no stored paneId matches", async () => {
		const project = makeProject();
		const store = mockStatefulHookUpdate(project, makeTask({
			status: "in-progress",
			sessionState: { panes: [codexPane(null, null)] },
		}));

		await handleRequest(makeRequest("task.agentHook", {
			taskId: store.get().id,
			projectId: project.id,
			event: "UserPromptSubmit",
			sessionId: "codex-main",
			paneId: "%7",
		}));

		const main = store.get().sessionState?.panes?.[0];
		expect(main?.paneId).toBe("%7");
		expect(main?.sessionId).toBe("codex-main");
	});

	it("does not capture when paneId is ambiguous (multiple null-paneId panes)", async () => {
		const project = makeProject();
		const store = mockStatefulHookUpdate(project, makeTask({
			status: "in-progress",
			sessionState: { panes: [codexPane(null, null), codexPane(null, null)] },
		}));

		await handleRequest(makeRequest("task.agentHook", {
			taskId: store.get().id,
			projectId: project.id,
			event: "SessionStart",
			sessionId: "codex-x",
			paneId: "%9",
		}));

		const panes = store.get().sessionState?.panes ?? [];
		expect(panes.every((p) => p.sessionId === null)).toBe(true);
	});
});

describe("projects.list", () => {
	it("returns all projects", async () => {
		const projects = [makeProject({ id: "p1" }), makeProject({ id: "p2" })];
		vi.mocked(data.loadProjects).mockResolvedValue(projects);

		const resp = await handleRequest(makeRequest("projects.list"));
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(projects);
	});

	it("merges virtual (Operations) boards into the list", async () => {
		const git = makeProject({ id: "p1" });
		const ops = makeProject({ id: "ops", kind: "virtual", builtin: true });
		vi.mocked(data.loadProjects).mockResolvedValue([git]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([ops]);

		const resp = await handleRequest(makeRequest("projects.list"));
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual([git, ops]);
	});
});

describe("tasks.list", () => {
	it("errors when projectId is missing", async () => {
		const resp = await handleRequest(makeRequest("tasks.list"));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("projectId is required");
	});

	it("returns all tasks for a project", async () => {
		const project = makeProject();
		const tasks = [makeTask({ id: "t1" }), makeTask({ id: "t2" })];
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue(tasks);

		const resp = await handleRequest(makeRequest("tasks.list", { projectId: "proj-1" }));
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(tasks);
	});

	it("filters tasks by status", async () => {
		const project = makeProject();
		const tasks = [
			makeTask({ id: "t1", status: "todo" }),
			makeTask({ id: "t2", status: "in-progress" }),
		];
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue(tasks);

		const resp = await handleRequest(
			makeRequest("tasks.list", { projectId: "proj-1", status: "todo" }),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual([tasks[0]]);
	});

	it("errors on invalid status", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([]);

		const resp = await handleRequest(
			makeRequest("tasks.list", { projectId: "proj-1", status: "bogus" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Invalid status: bogus");
	});
});

describe("task.update — priority", () => {
	it("rejects a garbage priority value", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: "task-abc12345", projectId: "proj-1", priority: "urgent" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Invalid priority");
		expect(data.setTaskPriority).not.toHaveBeenCalled();
	});

	it("accepts a case-insensitive priority and writes it group-wide", async () => {
		const project = makeProject();
		const task = makeTask();
		const changed = [makeTask({ priority: "P0" }), makeTask({ id: "task-sibling-uuid", priority: "P0" })];
		const pushFn = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.setTaskPriority).mockResolvedValue(changed);
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: "task-abc12345", projectId: "proj-1", priority: "p0" }),
		);
		expect(resp.ok).toBe(true);
		expect(data.setTaskPriority).toHaveBeenCalledWith(project, task.id, "P0");
		// Pushes an update for every changed task in the group.
		expect(pushFn).toHaveBeenCalledTimes(2);
		expect((resp.data as { task: Task }).task.priority).toBe("P0");
	});

	it("errors when nothing (no title/description/priority) is provided", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: "task-abc12345", projectId: "proj-1" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Nothing to update");
	});
});

describe("task.create — priority", () => {
	it("passes an explicit priority through to addTask", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", priority: "P1" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(task);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.create", { projectId: "proj-1", title: "Urgent", priority: "P1" }),
		);
		expect(resp.ok).toBe(true);
		expect(data.addTask).toHaveBeenCalledWith(project, "Urgent", "todo", { priority: "P1" });
	});

	it("rejects a garbage priority on create", async () => {
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		const resp = await handleRequest(
			makeRequest("task.create", { projectId: "proj-1", title: "X", priority: "P9" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Invalid priority");
	});
});

describe("task.show", () => {
	it("errors when taskId is missing", async () => {
		const resp = await handleRequest(makeRequest("task.show"));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("taskId is required");
	});

	it("uses getTask when projectId is given", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const resp = await handleRequest(
			makeRequest("task.show", { taskId: "task-abc12345", projectId: "proj-1" }),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(task);
		expect(data.getTask).toHaveBeenCalledWith(project, "task-abc12345");
	});

	it("resolves task across projects when no projectId given", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("task.show", { taskId: "task-abc12345" }),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(task);
	});

	it("resolves a task that lives on a virtual (Operations) board", async () => {
		// No git projects — the task only exists on a virtual board, which must be scanned.
		const ops = makeProject({ id: "ops", kind: "virtual", builtin: true });
		const task = makeTask({ id: "task-abc12345" });
		vi.mocked(data.loadProjects).mockResolvedValue([]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([ops]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(makeRequest("task.show", { taskId: "task-abc12345" }));
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(task);
	});

	it("matches by prefix across projects", async () => {
		const project = makeProject();
		const task = makeTask({ id: "task-abc12345-full-uuid" });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("task.show", { taskId: "task-abc1" }),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(task);
	});

	it("rejects short prefix (less than 8 chars)", async () => {
		const project = makeProject();
		const task = makeTask({ id: "task-abc12345-full-uuid" });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("task.show", { taskId: "task-ab" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Task not found");
	});

	it("errors on ambiguous prefix across projects", async () => {
		const project = makeProject();
		const task1 = makeTask({ id: "task-abc12345-aaaa-uuid" });
		const task2 = makeTask({ id: "task-abc12345-bbbb-uuid", seq: 2 });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task1, task2]);

		const resp = await handleRequest(
			makeRequest("task.show", { taskId: "task-abc12345" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Ambiguous");
	});

	it("errors when task not found across projects", async () => {
		vi.mocked(data.loadProjects).mockResolvedValue([makeProject()]);
		vi.mocked(data.loadTasks).mockResolvedValue([]);

		const resp = await handleRequest(
			makeRequest("task.show", { taskId: "nonexistent" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Task not found");
	});

	it("skips projects with broken task files during cross-project resolution", async () => {
		const p1 = makeProject({ id: "p1" });
		const p2 = makeProject({ id: "p2" });
		const task = makeTask();
		vi.mocked(data.loadProjects).mockResolvedValue([p1, p2]);
		vi.mocked(data.loadTasks)
			.mockRejectedValueOnce(new Error("corrupt"))
			.mockResolvedValueOnce([task]);

		const resp = await handleRequest(
			makeRequest("task.show", { taskId: task.id }),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(task);
	});
});

describe("devServer.*", () => {
	it("starts a dev server for a task in the current project", async () => {
		const project = makeProject();
		const task = makeTask({ id: "task-abc12345-1111-2222-3333-444444444444" });
		const status = { taskId: task.id, running: true, devSessionName: "dev3-dev-task-abc1" };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(runDevServer).mockResolvedValue(status as any);

		const resp = await handleRequest(makeRequest("devServer.start", {
			projectId: "proj-1",
			taskId: "task-abc1",
		}));

		expect(resp.ok).toBe(true);
		expect(runDevServer).toHaveBeenCalledWith({ taskId: task.id, projectId: project.id });
		expect(resp.data).toEqual(status);
	});

	it("stops a dev server by resolving task across projects", async () => {
		const project = makeProject();
		const task = makeTask({ id: "task-abc12345-1111-2222-3333-444444444444" });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(stopDevServer).mockResolvedValue({ taskId: task.id, running: false } as any);

		const resp = await handleRequest(makeRequest("devServer.stop", {
			taskId: "task-abc1",
		}));

		expect(resp.ok).toBe(true);
		expect(stopDevServer).toHaveBeenCalledWith({ taskId: task.id, projectId: project.id });
	});

	it("restarts via restartDevServer (stop → delay → start), not a bare start", async () => {
		const project = makeProject();
		const task = makeTask({ id: "task-abc12345-1111-2222-3333-444444444444" });
		const status = { taskId: task.id, running: true, devSessionName: "dev3-dev-task-abc1" };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(restartDevServer).mockResolvedValue(status as any);

		const resp = await handleRequest(makeRequest("devServer.restart", {
			projectId: "proj-1",
			taskId: "task-abc1",
		}));

		expect(resp.ok).toBe(true);
		expect(restartDevServer).toHaveBeenCalledWith({ taskId: task.id, projectId: project.id });
		expect(runDevServer).not.toHaveBeenCalled();
		expect(resp.data).toEqual(status);
	});

	it("returns current dev server status", async () => {
		const project = makeProject();
		const task = makeTask();
		const status = { taskId: task.id, running: false, ports: [] };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getDevServerStatus).mockResolvedValue(status as any);

		const resp = await handleRequest(makeRequest("devServer.status", {
			projectId: "proj-1",
			taskId: task.id,
		}));

		expect(resp.ok).toBe(true);
		expect(getDevServerStatus).toHaveBeenCalledWith({ taskId: task.id, projectId: project.id });
		expect(resp.data).toEqual(status);
	});
});

describe("task.create", () => {
	it("errors when projectId is missing", async () => {
		const resp = await handleRequest(makeRequest("task.create", { title: "New" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("projectId is required");
	});

	it("errors when title is missing", async () => {
		const resp = await handleRequest(makeRequest("task.create", { projectId: "proj-1" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("title is required");
	});

	it("creates task with title only (no description) and pushes message", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo" });
		const pushFn = vi.fn();

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(task);
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(
			makeRequest("task.create", { projectId: "proj-1", title: "New task" }),
		);
		expect(resp.ok).toBe(true);
		expect(data.addTask).toHaveBeenCalledWith(project, "New task", "todo");
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", { projectId: "proj-1", task });
	});

	it("creates task with description and sets customTitle", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo" });
		const updatedTask = makeTask({ status: "todo", customTitle: "Short title" });
		const pushFn = vi.fn();

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(
			makeRequest("task.create", {
				projectId: "proj-1",
				title: "Short title",
				description: "Long detailed description\nwith multiple lines",
			}),
		);
		expect(resp.ok).toBe(true);
		expect(data.addTask).toHaveBeenCalledWith(project, "Long detailed description\nwith multiple lines", "todo");
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { customTitle: "Short title" });
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", { projectId: "proj-1", task: updatedTask });
	});

	it("does not crash when pushMessage is null", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(task);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.create", { projectId: "proj-1", title: "New task" }),
		);
		expect(resp.ok).toBe(true);
	});
});

describe("ui.show-image", () => {
	function wireShowImage(project: Project, task: Task, pushFn: ReturnType<typeof vi.fn>) {
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(pushFn as never);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => Promise<{ updates: Partial<Task>; result: unknown }>)(task);
			return { task: { ...task, ...updates }, result } as never;
		});
	}

	it("stores images, pushes taskUpdated + cliShowImage", async () => {
		const project = makeProject();
		const task = makeTask({ seq: 12 });
		const pushFn = vi.fn();
		wireShowImage(project, task, pushFn);

		const resp = await handleRequest(
			makeRequest("ui.show-image", { taskId: task.id, projectId: project.id, paths: ["/tmp/a.png", "/tmp/b.png"] }),
		);

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: true, stored: 2, taskId: task.id });
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: project.id }));
		expect(pushFn).toHaveBeenCalledWith(
			"cliShowImage",
			expect.objectContaining({ taskId: task.id, newCount: 2, taskSeq: task.seq, projectName: project.name }),
		);
	});

	it("focus mode: persists (taskUpdated) but suppresses cliShowImage", async () => {
		const project = makeProject();
		const task = makeTask();
		const pushFn = vi.fn();
		wireShowImage(project, task, pushFn);
		vi.mocked(loadSettings).mockReturnValueOnce({ focusMode: true } as never);

		const resp = await handleRequest(
			makeRequest("ui.show-image", { taskId: task.id, projectId: project.id, paths: ["/tmp/a.png"] }),
		);

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: false, suppressed: true, stored: 1 });
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", expect.anything());
		expect(pushFn).not.toHaveBeenCalledWith("cliShowImage", expect.anything());
	});

	it("accepts the images:[{path,caption}] shape and threads per-image captions", async () => {
		const project = makeProject();
		const task = makeTask({ seq: 3 });
		const pushFn = vi.fn();
		wireShowImage(project, task, pushFn);
		const saveSpy = vi.mocked(saveSharedImage);
		saveSpy.mockClear();

		const resp = await handleRequest(
			makeRequest("ui.show-image", {
				taskId: task.id,
				projectId: project.id,
				images: [
					{ path: "/tmp/a.png", caption: "before" },
					{ path: "/tmp/b.png", caption: "after" },
				],
			}),
		);

		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: true, stored: 2 });
		expect(saveSpy).toHaveBeenCalledWith(project.path, "/tmp/a.png", "before");
		expect(saveSpy).toHaveBeenCalledWith(project.path, "/tmp/b.png", "after");
		const cliPush = pushFn.mock.calls.find((c) => c[0] === "cliShowImage");
		expect(cliPush?.[1].images).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ originalPath: "/tmp/a.png", caption: "before" }),
				expect.objectContaining({ originalPath: "/tmp/b.png", caption: "after" }),
			]),
		);
	});

	it("errors when no paths are given", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(makeRequest("ui.show-image", { taskId: task.id, projectId: project.id, paths: [] }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("At least one image path is required");
	});
});

describe("ui.show-artifact", () => {
	it("stores HTML plus images and pushes taskUpdated + cliShowArtifact", async () => {
		const project = makeProject();
		const task = makeTask({ seq: 14 });
		const pushFn = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(pushFn as never);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => Promise<{ updates: Partial<Task>; result: unknown }>)(task);
			return { task: { ...task, ...updates }, result } as never;
		});

		const response = await handleRequest(makeRequest("ui.show-artifact", {
			taskId: task.id,
			projectId: project.id,
			htmlPath: "/tmp/report.html",
			imagePaths: ["/tmp/chart.png"],
			title: "Metrics",
		}));

		expect(response.ok).toBe(true);
		expect(saveSharedArtifact).toHaveBeenCalledWith(project.path, "/tmp/report.html", ["/tmp/chart.png"], "Metrics");
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: project.id }));
		expect(pushFn).toHaveBeenCalledWith(
			"cliShowArtifact",
			expect.objectContaining({ taskId: task.id, newCount: 1, taskSeq: task.seq }),
		);
	});

	it("rejects a missing HTML path", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		const response = await handleRequest(makeRequest("ui.show-artifact", { taskId: task.id, projectId: project.id }));
		expect(response.ok).toBe(false);
		expect(response.error).toContain("HTML artifact path is required");
	});
});

describe("ui control (notify / attention / state)", () => {
	it("ui.notify: pushes a cliToast without a task", async () => {
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(makeRequest("ui.notify", { message: "hello", level: "info" }));
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: true, mode: "toast", taskId: null });
		expect(pushFn).toHaveBeenCalledWith("cliToast", {
			taskId: null,
			projectId: null,
			message: "hello",
			level: "info",
		});
	});

	it("ui.notify: resolves the task so the toast is clickable", async () => {
		const project = makeProject();
		const task = makeTask();
		const pushFn = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(
			makeRequest("ui.notify", { message: "done", level: "success", taskId: task.id, projectId: project.id }),
		);
		expect(resp.ok).toBe(true);
		expect(pushFn).toHaveBeenCalledWith(
			"cliToast",
			expect.objectContaining({
				taskId: task.id,
				projectId: project.id,
				message: "done",
				level: "success",
				taskSeq: task.seq,
				projectName: project.name,
			}),
		);
	});

	it("ui.notify: --desktop fires a native notification via notifyFromCliDesktop", async () => {
		const project = makeProject();
		const task = makeTask({ seq: 7 });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("ui.notify", { message: "needs you", desktop: true, taskId: task.id, projectId: project.id }),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: true, mode: "desktop", taskId: task.id });
		expect(notifyFromCliDesktop).toHaveBeenCalledWith(
			expect.objectContaining({
				task: expect.objectContaining({ id: task.id }),
				body: "needs you",
				projectName: project.name,
			}),
		);
	});

	it("ui.notify: --desktop without a task errors", async () => {
		const resp = await handleRequest(makeRequest("ui.notify", { message: "x", desktop: true }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("requires a task");
	});

	it("ui.notify: rejects an invalid level", async () => {
		const resp = await handleRequest(makeRequest("ui.notify", { message: "x", level: "warning" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Invalid level");
	});

	it("ui.notify: rejects an empty message", async () => {
		const resp = await handleRequest(makeRequest("ui.notify", { message: "   " }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("message is required");
	});

	it("ui.notify: focus mode suppresses the toast (no push)", async () => {
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(loadSettings).mockReturnValueOnce({ focusMode: true } as never);

		const resp = await handleRequest(makeRequest("ui.notify", { message: "hi" }));
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: false, suppressed: true });
		expect(pushFn).not.toHaveBeenCalled();
	});

	it("ui.attention: focus mode suppresses the badge (no push)", async () => {
		const project = makeProject();
		const task = makeTask();
		const pushFn = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(loadSettings).mockReturnValueOnce({ focusMode: true } as never);

		const resp = await handleRequest(makeRequest("ui.attention", { taskId: task.id, projectId: project.id, reason: "x" }));
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: false, suppressed: true });
		expect(pushFn).not.toHaveBeenCalled();
	});

	it("ui.attention: pushes cliAttention for the resolved task", async () => {
		const project = makeProject();
		const task = makeTask();
		const pushFn = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(
			makeRequest("ui.attention", { taskId: task.id, projectId: project.id, reason: "PR ready" }),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ delivered: true, taskId: task.id });
		expect(pushFn).toHaveBeenCalledWith("cliAttention", { taskId: task.id, reason: "PR ready" });
	});

	it("ui.state: reports foreground and active context", async () => {
		vi.mocked(isAppForeground).mockReturnValue(true);
		vi.mocked(getActiveContext).mockReturnValue({ projectId: "proj-1", taskId: "task-9" });

		const resp = await handleRequest(makeRequest("ui.state"));
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual({
			appRunning: true,
			foreground: true,
			activeProjectId: "proj-1",
			activeTaskId: "task-9",
			userIdleSeconds: 7,
			tmux: null,
		});
	});

	it("ui.state: includes the tmux layout when a taskId is given", async () => {
		vi.mocked(isAppForeground).mockReturnValue(false);
		vi.mocked(getActiveContext).mockReturnValue({ projectId: null, taskId: null });

		const resp = await handleRequest(makeRequest("ui.state", { taskId: "task-abc" }));
		expect(resp.ok).toBe(true);
		expect((resp.data as { tmux: unknown }).tmux).toMatchObject({ sessionName: "dev3-task1234", exists: false });
	});
});

describe("task.update", () => {
	it("errors when taskId is missing", async () => {
		const resp = await handleRequest(makeRequest("task.update"));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("taskId is required");
	});

	it("errors when nothing to update", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: task.id, projectId: "proj-1" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Nothing to update");
	});

	it("updates title with projectId", async () => {
		const project = makeProject();
		const task = makeTask();
		const updated = { ...task, customTitle: "Updated" };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: task.id, projectId: "proj-1", title: "Updated" }),
		);
		expect(resp.ok).toBe(true);
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { customTitle: "Updated" });
	});

	it("auto-generates title from description", async () => {
		const project = makeProject();
		const task = makeTask();
		const updated = { ...task, description: "Long desc", title: "Long desc" };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: task.id, projectId: "proj-1", description: "Long desc" }),
		);
		expect(resp.ok).toBe(true);
		const call = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(call.description).toBe("Long desc");
		expect(call.title).toBeDefined();
	});

	it("clears the scratch flag when the description becomes a real task prompt", async () => {
		const project = makeProject();
		const task = makeTask({ scratch: true, description: "Scratch — 15:50" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({
			...task,
			description: "Plan HTML artifacts",
			scratch: false,
		});
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", {
				taskId: task.id,
				projectId: "proj-1",
				description: "Plan HTML artifacts",
			}),
		);

		expect(resp.ok).toBe(true);
		expect(vi.mocked(data.updateTask).mock.calls[0][2]).toEqual(expect.objectContaining({
			description: "Plan HTML artifacts",
			scratch: false,
		}));
	});

	it("does not auto-generate title when explicit title provided", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, customTitle: "Explicit", description: "Desc" });
		vi.mocked(getPushMessage).mockReturnValue(null);

		await handleRequest(
			makeRequest("task.update", {
				taskId: task.id,
				projectId: "proj-1",
				title: "Explicit",
				description: "Desc",
			}),
		);
		const call = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(call.customTitle).toBe("Explicit");
	});

	it("resolves task across projects when no projectId", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, title: "New" });
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: task.id, title: "New" }),
		);
		expect(resp.ok).toBe(true);
	});

	it("errors when task not found", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([]);

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: "nope", projectId: "proj-1", title: "X" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Task not found");
	});

	it("clears customTitle when title is empty string", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "Old custom" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, customTitle: null });
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: task.id, projectId: "proj-1", title: "" }),
		);
		expect(resp.ok).toBe(true);
		const call = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(call.customTitle).toBeNull();
	});

	it("does not recompute auto-title from description when task has customTitle", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "My custom title" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, description: "New desc" });
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: task.id, projectId: "proj-1", description: "New desc" }),
		);
		expect(resp.ok).toBe(true);
		const call = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(call.description).toBe("New desc");
		expect(call.title).toBeUndefined();
	});

	// Issue #564 — agent following its skill must not overwrite a title the user
	// already set via the UI. The CLI is the agent-facing entry point; refuse to
	// overwrite the title when titleEditedByUser is true, unless --force is passed.
	it("preserves user-edited title when --title is provided without --force", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "User-set title", titleEditedByUser: true });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", {
				taskId: task.id,
				projectId: "proj-1",
				title: "Agent-proposed rename",
			}),
		);
		expect(resp.ok).toBe(true);
		// updateTask must NOT be called — nothing to write.
		expect(data.updateTask).not.toHaveBeenCalled();
		const result = resp.data as { task: Task; titlePreserved: boolean };
		expect(result.titlePreserved).toBe(true);
		expect(result.task.customTitle).toBe("User-set title");
	});

	// Re-opened #583 — a customTitle set by a previous agent (titleEditedByUser
	// is false) is NOT protected, otherwise the title gets frozen forever on
	// whatever the first agent wrote. Later agents must be able to rewrite it.
	it("overwrites agent-set customTitle (titleEditedByUser=false) without --force", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "Old agent title", titleEditedByUser: false });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, customTitle: "New agent title" });
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", {
				taskId: task.id,
				projectId: "proj-1",
				title: "New agent title",
			}),
		);
		expect(resp.ok).toBe(true);
		const call = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(call.customTitle).toBe("New agent title");
		// CLI must never claim a user edit — only the UI rename RPC sets that flag.
		expect(call.titleEditedByUser).toBeUndefined();
		const result = resp.data as { task: Task; titlePreserved: boolean };
		expect(result.titlePreserved).toBe(false);
	});

	it("overwrites user-edited title when --force is set", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "User-set title", titleEditedByUser: true });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, customTitle: "Agent override" });
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", {
				taskId: task.id,
				projectId: "proj-1",
				title: "Agent override",
				force: true,
			}),
		);
		expect(resp.ok).toBe(true);
		const call = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(call.customTitle).toBe("Agent override");
		const result = resp.data as { task: Task; titlePreserved: boolean };
		expect(result.titlePreserved).toBe(false);
	});

	it("still allows --title to clear customTitle (--title \"\") without --force, and drops the user-edit flag", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "User-set title", titleEditedByUser: true });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, customTitle: null, titleEditedByUser: false });
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: task.id, projectId: "proj-1", title: "" }),
		);
		expect(resp.ok).toBe(true);
		const call = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(call.customTitle).toBeNull();
		expect(call.titleEditedByUser).toBe(false);
	});

	it("returns task in new envelope shape", async () => {
		const project = makeProject();
		const task = makeTask();
		const updated = { ...task, customTitle: "Updated" };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: task.id, projectId: "proj-1", title: "Updated" }),
		);
		expect(resp.ok).toBe(true);
		const result = resp.data as { task: Task; titlePreserved: boolean };
		expect(result.task.id).toBe(task.id);
		expect(result.titlePreserved).toBe(false);
	});
});

describe("note.add", () => {
	it("errors when taskId is missing", async () => {
		const resp = await handleRequest(makeRequest("note.add", { content: "hi" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("taskId is required");
	});

	it("errors when content is missing", async () => {
		const resp = await handleRequest(makeRequest("note.add", { taskId: "t1" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("content is required");
	});

	// note.add now recomputes the notes array inside the per-task lock via
	// updateTaskWith (avoids the lost-update race), so the tests wire that mutator
	// and assert on the resulting task instead of a pre-lock updateTask snapshot.
	function wireUpdateTaskWith(task: Task): void {
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => Promise<{ updates: Partial<Task>; result: unknown }>)(task);
			return { task: { ...task, ...updates }, result } as never;
		});
	}

	it("adds note with default source ai", async () => {
		const project = makeProject();
		const task = makeTask({ notes: [] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		wireUpdateTaskWith(task);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("note.add", { taskId: task.id, projectId: "proj-1", content: "Hello" }),
		);
		expect(resp.ok).toBe(true);
		const notes = (resp.data as Task).notes ?? [];
		expect(notes).toHaveLength(1);
		expect(notes[0].content).toBe("Hello");
		expect(notes[0].source).toBe("ai");
	});

	it("adds note with explicit source", async () => {
		const project = makeProject();
		const task = makeTask({ notes: [] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		wireUpdateTaskWith(task);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("note.add", {
				taskId: task.id,
				projectId: "proj-1",
				content: "From user",
				source: "user",
			}),
		);
		const notes = (resp.data as Task).notes ?? [];
		expect(notes[0].source).toBe("user");
	});

	it("appends to existing notes", async () => {
		const existingNote: TaskNote = {
			id: "note-existing",
			content: "Old note",
			source: "user",
			createdAt: "2025-01-01T00:00:00Z",
			updatedAt: "2025-01-01T00:00:00Z",
		};
		const project = makeProject();
		const task = makeTask({ notes: [existingNote] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		wireUpdateTaskWith(task);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("note.add", { taskId: task.id, projectId: "proj-1", content: "New" }),
		);
		const notes = (resp.data as Task).notes ?? [];
		expect(notes).toHaveLength(2);
		expect(notes[0]).toEqual(existingNote);
		expect(notes[1].content).toBe("New");
	});

	it("resolves across projects when no projectId", async () => {
		const project = makeProject();
		const task = makeTask({ notes: [] });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		wireUpdateTaskWith(task);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("note.add", { taskId: task.id, content: "Cross-project" }),
		);
		expect(resp.ok).toBe(true);
	});
});

describe("note.list", () => {
	it("errors when taskId is missing", async () => {
		const resp = await handleRequest(makeRequest("note.list"));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("taskId is required");
	});

	it("returns notes with projectId", async () => {
		const notes: TaskNote[] = [
			{ id: "n1", content: "A", source: "ai", createdAt: "", updatedAt: "" },
		];
		const project = makeProject();
		const task = makeTask({ notes });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const resp = await handleRequest(
			makeRequest("note.list", { taskId: task.id, projectId: "proj-1" }),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(notes);
	});

	it("returns empty array when no notes", async () => {
		const project = makeProject();
		const task = makeTask({ notes: undefined });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const resp = await handleRequest(
			makeRequest("note.list", { taskId: task.id, projectId: "proj-1" }),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual([]);
	});

	it("resolves across projects when no projectId", async () => {
		const project = makeProject();
		const task = makeTask({ notes: [] });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("note.list", { taskId: task.id }),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual([]);
	});
});

describe("note.delete", () => {
	it("errors when taskId is missing", async () => {
		const resp = await handleRequest(makeRequest("note.delete", { noteId: "n1" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("taskId is required");
	});

	it("errors when noteId is missing", async () => {
		const resp = await handleRequest(makeRequest("note.delete", { taskId: "t1" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("noteId is required");
	});

	// note.delete recomputes the surviving notes inside the per-task lock via
	// updateTaskWith, so success-path tests wire that mutator against the seeded task.
	function wireUpdateTaskWith(task: Task): void {
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await (mutator as (t: Task) => Promise<{ updates: Partial<Task>; result: unknown }>)(task);
			return { task: { ...task, ...updates }, result } as never;
		});
	}

	it("deletes note by full ID", async () => {
		const note: TaskNote = {
			id: "note-full-uuid-1234",
			content: "To delete",
			source: "ai",
			createdAt: "",
			updatedAt: "",
		};
		const project = makeProject();
		const task = makeTask({ notes: [note] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		wireUpdateTaskWith(task);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("note.delete", {
				taskId: task.id,
				projectId: "proj-1",
				noteId: "note-full-uuid-1234",
			}),
		);
		expect(resp.ok).toBe(true);
		expect((resp.data as Task).notes).toHaveLength(0);
	});

	it("deletes note by prefix", async () => {
		const note: TaskNote = {
			id: "note-abcd-1234-5678",
			content: "To delete",
			source: "ai",
			createdAt: "",
			updatedAt: "",
		};
		const project = makeProject();
		const task = makeTask({ notes: [note] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		wireUpdateTaskWith(task);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("note.delete", { taskId: task.id, projectId: "proj-1", noteId: "note-abcd" }),
		);
		expect(resp.ok).toBe(true);
	});

	it("errors on ambiguous note prefix", async () => {
		const note1: TaskNote = { id: "note-abcd-1234-aaaa", content: "A", source: "ai", createdAt: "", updatedAt: "" };
		const note2: TaskNote = { id: "note-abcd-1234-bbbb", content: "B", source: "ai", createdAt: "", updatedAt: "" };
		const project = makeProject();
		const task = makeTask({ notes: [note1, note2] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("note.delete", { taskId: task.id, projectId: "proj-1", noteId: "note-abcd-1234" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Ambiguous");
	});

	it("errors when note not found", async () => {
		const project = makeProject();
		const task = makeTask({ notes: [] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("note.delete", { taskId: task.id, projectId: "proj-1", noteId: "nope" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Note not found");
	});

	it("resolves across projects when no projectId", async () => {
		const note: TaskNote = {
			id: "note-cross",
			content: "X",
			source: "ai",
			createdAt: "",
			updatedAt: "",
		};
		const project = makeProject();
		const task = makeTask({ notes: [note] });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		wireUpdateTaskWith(task);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("note.delete", { taskId: task.id, noteId: "note-cross" }),
		);
		expect(resp.ok).toBe(true);
	});
});

describe("task.move", () => {
	function mockDestructiveMoveTask(): void {
		vi.mocked(moveTask).mockImplementation(async ({ taskId, projectId, newStatus }: any) => {
			const project = await data.getProject(projectId);
			const tasks = await data.loadTasks(project);
			const task = tasks.find((candidate) => candidate.id === taskId);
			if (!task) throw new Error(`Task not found: ${taskId}`);

			emitTaskSound(newStatus as "completed" | "cancelled", task.id);
			try {
				pty.destroySession(task.id, task.tmuxSocket ?? undefined);
			} catch {}
			try {
				await runCleanupScript(task, project, {
					fromStatus: task.status,
					toStatus: newStatus,
				});
			} catch {}
			try {
				await git.removeWorktree(project, task);
			} catch {}

			return data.updateTask(project, task.id, {
				status: newStatus,
				worktreePath: null,
				branchName: null,
				customColumnId: null,
			}, { dropPosition: "top" });
		});
	}

	it("errors when taskId is missing", async () => {
		const resp = await handleRequest(makeRequest("task.move", { newStatus: "todo" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("taskId is required");
	});

	it("errors when newStatus is missing", async () => {
		const resp = await handleRequest(makeRequest("task.move", { taskId: "t1" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("newStatus is required");
	});

	it("errors on invalid status", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("task.move", { taskId: task.id, projectId: "proj-1", newStatus: "bogus" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Invalid status: \"bogus\"");
	});

	it("returns task unchanged when same status", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "in-progress",
			}),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(task);
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("allows only one concurrent --if-status move to win", async () => {
		const project = makeProject();
		let storedTask = makeTask({ status: "in-progress" });
		let loadCount = 0;
		let releaseLoads!: () => void;
		const loadsReady = new Promise<void>((resolve) => {
			releaseLoads = resolve;
		});
		let updateQueue = Promise.resolve();

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockImplementation(async () => {
			loadCount += 1;
			if (loadCount === 2) {
				releaseLoads();
			}
			await loadsReady;
			return [{ ...storedTask }];
		});
		vi.mocked(data.updateTask).mockImplementation(async (_project, _taskId, updates, options: any) => {
			const run = async () => {
				const allowedStatuses = typeof options?.ifStatus === "string"
					? options.ifStatus.split(",")
					: null;
				const blockedStatuses = typeof options?.ifStatusNot === "string"
					? options.ifStatusNot.split(",")
					: null;
				if (allowedStatuses && !allowedStatuses.includes(storedTask.status)) {
					return { ...storedTask };
				}
				if (blockedStatuses && blockedStatuses.includes(storedTask.status)) {
					return { ...storedTask };
				}
				storedTask = { ...storedTask, ...updates };
				return { ...storedTask };
			};
			const result = updateQueue.then(run);
			updateQueue = result.then(() => undefined, () => undefined);
			return result;
		});
		vi.mocked(getPushMessage).mockReturnValue(null);

		const [moveToReview, moveToQuestions] = await Promise.all([
			handleRequest(makeRequest("task.move", {
				taskId: storedTask.id,
				projectId: project.id,
				newStatus: "review-by-ai",
				ifStatus: "in-progress",
			})),
			handleRequest(makeRequest("task.move", {
				taskId: storedTask.id,
				projectId: project.id,
				newStatus: "user-questions",
				ifStatus: "in-progress",
			})),
		]);

		expect(moveToReview.ok).toBe(true);
		expect(moveToQuestions.ok).toBe(true);
		expect(new Set([
			(moveToReview.data as Task).status,
			(moveToQuestions.data as Task).status,
		])).toEqual(new Set([storedTask.status]));
		expect(["review-by-ai", "user-questions"]).toContain(storedTask.status);
	});

	it("errors on disallowed transition (todo cannot go to review-by-user)", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "review-by-user",
			}),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Cannot move task");
		expect(resp.error).toContain("Allowed:");
	});

	it("active → active: updates status only", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		const updated = { ...task, status: "review-by-user" as const };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "review-by-user",
			}),
		);
		expect(resp.ok).toBe(true);
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { status: "review-by-user", customColumnId: null }, { dropPosition: "top" });
		expect(git.createWorktree).not.toHaveBeenCalled();
		expect(pty.destroySession).not.toHaveBeenCalled();
	});

	it("inactive → active (todo → in-progress): creates worktree + PTY", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null, branchName: null });
		const wtResult = { worktreePath: "/tmp/new-wt", branchName: "dev3/task-new" };
		const updated = { ...task, status: "in-progress" as const, ...wtResult };

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(activateTask).mockResolvedValue(wtResult);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "in-progress",
			}),
		);

		expect(resp.ok).toBe(true);
		expect(activateTask).toHaveBeenCalledWith(project, task, { isReopen: false });
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, {
			status: "in-progress",
			worktreePath: "/tmp/new-wt",
			branchName: "dev3/task-new",
			customColumnId: null,
		}, { dropPosition: "top" });
	});

	it("reopen (completed → in-progress): calls activateTask with isReopen=true", async () => {
		const project = makeProject();
		const task = makeTask({ status: "completed", description: "Old desc" });
		const wtResult = { worktreePath: "/tmp/reopen-wt", branchName: "dev3/reopen" };

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(activateTask).mockResolvedValue(wtResult);
		vi.mocked(data.updateTask).mockResolvedValue({
			...task,
			status: "in-progress",
			...wtResult,
		});
		vi.mocked(getPushMessage).mockReturnValue(null);

		await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "in-progress",
			}),
		);

		expect(activateTask).toHaveBeenCalledWith(project, task, { isReopen: true });
	});

	it("reopen (cancelled → in-progress): calls activateTask with isReopen=true", async () => {
		const project = makeProject();
		const task = makeTask({ status: "cancelled", description: "Cancelled desc" });
		const wtResult = { worktreePath: "/tmp/reopen-wt", branchName: "dev3/reopen" };

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(activateTask).mockResolvedValue(wtResult);
		vi.mocked(data.updateTask).mockResolvedValue({
			...task,
			status: "in-progress",
			...wtResult,
		});
		vi.mocked(getPushMessage).mockReturnValue(null);

		await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "in-progress",
			}),
		);

		expect(activateTask).toHaveBeenCalledWith(project, task, { isReopen: true });
	});

	it("blocked guard (todo, --if-status-not todo): does NOT activate worktree, returns unchanged task", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null, branchName: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		// updateTask is the authoritative guard; if reached with a blocking guard
		// it would return the unchanged task. The pre-check must prevent activateTask.
		vi.mocked(data.updateTask).mockResolvedValue(task);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "in-progress",
				ifStatusNot: "todo",
			}),
		);

		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(task);
		expect(activateTask).not.toHaveBeenCalled();
	});

	it("passing guard (todo, --if-status-not completed): still activates worktree", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null, branchName: null });
		const wtResult = { worktreePath: "/tmp/new-wt", branchName: "dev3/task-new" };
		const updated = { ...task, status: "in-progress" as const, ...wtResult };

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(activateTask).mockResolvedValue(wtResult);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "in-progress",
				ifStatusNot: "completed",
			}),
		);

		expect(resp.ok).toBe(true);
		expect(activateTask).toHaveBeenCalledWith(project, task, { isReopen: false });
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, {
			status: "in-progress",
			worktreePath: "/tmp/new-wt",
			branchName: "dev3/task-new",
			customColumnId: null,
		}, { dropPosition: "top", ifStatusNot: "completed" });
	});

	it("blocked guard (completed → custom column, --if-status-not completed): does NOT reactivate worktree", async () => {
		const customColumn = {
			id: "col-1234abcd-0000-0000-0000-000000000000",
			name: "Review",
			color: "#3b82f6",
			llmInstruction: "",
		};
		const project = makeProject({ customColumns: [customColumn] });
		const task = makeTask({ status: "completed", worktreePath: null, branchName: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(task);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: customColumn.id,
				ifStatusNot: "completed",
			}),
		);

		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(task);
		expect(activateTask).not.toHaveBeenCalled();
	});

	it("active → completed: destroys PTY, runs cleanup, removes worktree", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		const updated = { ...task, status: "completed" as const, worktreePath: null, branchName: null };

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());
		mockDestructiveMoveTask();

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "completed",
			}),
		);

		expect(resp.ok).toBe(true);
		expect(pty.destroySession).toHaveBeenCalledWith(task.id, undefined);
		expect(runCleanupScript).toHaveBeenCalledWith(task, project, {
			fromStatus: "in-progress",
			toStatus: "completed",
		});
		expect(git.removeWorktree).toHaveBeenCalledWith(project, task);
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, {
			status: "completed",
			worktreePath: null,
			branchName: null,
			customColumnId: null,
		}, { dropPosition: "top" });
	});

	it("active → completed: emits renderer sound before cleanup starts", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		const updated = { ...task, status: "completed" as const, worktreePath: null, branchName: null };

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(null);
		mockDestructiveMoveTask();

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "completed",
			}),
		);

		expect(resp.ok).toBe(true);
		expect(vi.mocked(emitTaskSound).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(runCleanupScript).mock.invocationCallOrder[0],
		);
	});

	it("active → cancelled: same cleanup flow", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		const updated = { ...task, status: "cancelled" as const, worktreePath: null, branchName: null };

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(null);
		mockDestructiveMoveTask();

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "cancelled",
			}),
		);

		expect(resp.ok).toBe(true);
		expect(pty.destroySession).toHaveBeenCalled();
		expect(runCleanupScript).toHaveBeenCalledWith(task, project, {
			fromStatus: "in-progress",
			toStatus: "cancelled",
		});
		expect(git.removeWorktree).toHaveBeenCalled();
	});

	it("cleanup errors are swallowed during active → completed", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(pty.destroySession).mockImplementation(() => {
			throw new Error("PTY gone");
		});
		vi.mocked(runCleanupScript).mockRejectedValue(new Error("cleanup failed"));
		vi.mocked(git.removeWorktree).mockRejectedValue(new Error("worktree gone"));
		vi.mocked(data.updateTask).mockResolvedValue({
			...task,
			status: "completed",
			worktreePath: null,
			branchName: null,
		});
		vi.mocked(getPushMessage).mockReturnValue(null);
		mockDestructiveMoveTask();

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "completed",
			}),
		);
		expect(resp.ok).toBe(true);
	});

	it("resolves across projects when no projectId", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		const updated = { ...task, status: "review-by-user" as const };
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.move", { taskId: task.id, newStatus: "review-by-user" }),
		);
		expect(resp.ok).toBe(true);
	});

	it("task not found with projectId errors", async () => {
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue([]);

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: "nope",
				projectId: "proj-1",
				newStatus: "in-progress",
			}),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Task not found");
	});
});

describe("label.list", () => {
	it("errors when projectId is missing", async () => {
		const resp = await handleRequest(makeRequest("label.list"));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("projectId is required");
	});

	it("returns labels from project", async () => {
		const labels = [
			{ id: "lbl-1", name: "bug", color: "#ef4444" },
			{ id: "lbl-2", name: "feature", color: "#14b8a6" },
		];
		vi.mocked(data.getProject).mockResolvedValue(makeProject({ labels }));

		const resp = await handleRequest(makeRequest("label.list", { projectId: "proj-1" }));
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(labels);
	});

	it("returns empty array when project has no labels", async () => {
		vi.mocked(data.getProject).mockResolvedValue(makeProject());

		const resp = await handleRequest(makeRequest("label.list", { projectId: "proj-1" }));
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual([]);
	});
});

describe("label.create", () => {
	// label.create now appends the label inside the project lock via
	// updateProjectWith (avoids the lost-update race), so tests wire that mutator
	// against the seeded project.
	function wireUpdateProjectWith(project: Project): void {
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await (mutator as (p: Project) => Promise<{ updates: Partial<Project>; result: unknown }>)(project);
			return { project: { ...project, ...updates }, result } as never;
		});
	}

	it("errors when projectId is missing", async () => {
		const resp = await handleRequest(makeRequest("label.create", { name: "bug" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("projectId is required");
	});

	it("errors when name is missing", async () => {
		const resp = await handleRequest(makeRequest("label.create", { projectId: "proj-1" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("name is required");
	});

	it("creates label with auto-assigned color", async () => {
		vi.mocked(data.getProject).mockResolvedValue(makeProject({ labels: [] }));
		wireUpdateProjectWith(makeProject({ labels: [] }));
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("label.create", { projectId: "proj-1", name: "bug" }),
		);
		expect(resp.ok).toBe(true);
		const label = resp.data as any;
		expect(label.name).toBe("bug");
		expect(label.color).toBe("#ef4444"); // First color from palette
		expect(label.id).toBeDefined();
	});

	it("creates label with custom color", async () => {
		vi.mocked(data.getProject).mockResolvedValue(makeProject({ labels: [] }));
		wireUpdateProjectWith(makeProject({ labels: [] }));
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("label.create", { projectId: "proj-1", name: "urgent", color: "#ff0000" }),
		);
		expect(resp.ok).toBe(true);
		const label = resp.data as any;
		expect(label.color).toBe("#ff0000");
	});

	it("skips colors already used by existing labels", async () => {
		const existing = [{ id: "lbl-1", name: "bug", color: "#ef4444" }];
		vi.mocked(data.getProject).mockResolvedValue(makeProject({ labels: existing }));
		wireUpdateProjectWith(makeProject({ labels: existing }));
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("label.create", { projectId: "proj-1", name: "feature" }),
		);
		expect(resp.ok).toBe(true);
		const label = resp.data as any;
		expect(label.color).toBe("#14b8a6"); // Second color (first was taken)
	});

	it("trims label name", async () => {
		vi.mocked(data.getProject).mockResolvedValue(makeProject({ labels: [] }));
		wireUpdateProjectWith(makeProject({ labels: [] }));
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("label.create", { projectId: "proj-1", name: "  bug  " }),
		);
		expect(resp.ok).toBe(true);
		expect((resp.data as any).name).toBe("bug");
	});
});

describe("label.delete", () => {
	it("errors when projectId is missing", async () => {
		const resp = await handleRequest(makeRequest("label.delete", { labelId: "lbl-1" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("projectId is required");
	});

	it("errors when labelId is missing", async () => {
		const resp = await handleRequest(makeRequest("label.delete", { projectId: "proj-1" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("labelId is required");
	});

	it("deletes label and removes from tasks", async () => {
		const labels = [
			{ id: "lbl-full-uuid-1234", name: "bug", color: "#ef4444" },
			{ id: "lbl-2", name: "feature", color: "#14b8a6" },
		];
		const project = makeProject({ labels });
		const taskWithLabel = makeTask({ id: "t1", labelIds: ["lbl-full-uuid-1234", "lbl-2"] });
		const taskWithout = makeTask({ id: "t2", labelIds: [] });

		vi.mocked(data.getProject).mockResolvedValue(project);
		// label removal now goes through the project lock (updateProjectWith) so a
		// concurrent label.create is not clobbered.
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await (mutator as (p: Project) => Promise<{ updates: Partial<Project>; result: unknown }>)(project);
			return { project: { ...project, ...updates }, result } as never;
		});
		vi.mocked(data.loadTasks).mockResolvedValue([taskWithLabel, taskWithout]);
		vi.mocked(data.updateTaskWith).mockResolvedValue({ task: taskWithLabel, result: undefined } as any);

		const resp = await handleRequest(
			makeRequest("label.delete", { projectId: "proj-1", labelId: "lbl-full-uuid-1234" }),
		);
		expect(resp.ok).toBe(true);
		// Should remove the deleted label from the project inside the lock. The mutator
		// recomputes from the CURRENT project, so surviving labels are preserved.
		const projMutator = vi.mocked(data.updateProjectWith).mock.calls[0][1];
		expect(await projMutator(project)).toEqual({
			updates: { labels: [labels[1]] },
			result: undefined,
		});
		// Should update affected task via the locked mutator (no lost-update race)
		expect(data.updateTaskWith).toHaveBeenCalledWith(project, "t1", expect.any(Function));
		// Should NOT update task that didn't have the label
		expect(data.updateTaskWith).toHaveBeenCalledTimes(1);
		// The mutator must recompute labelIds from the CURRENT task, not a stale snapshot
		const mutator = vi.mocked(data.updateTaskWith).mock.calls[0][2];
		expect(await mutator({ ...taskWithLabel, labelIds: ["lbl-full-uuid-1234", "lbl-2", "lbl-3"] } as any)).toEqual({
			updates: { labelIds: ["lbl-2", "lbl-3"] },
			result: undefined,
		});
	});

	it("matches label by prefix", async () => {
		const labels = [{ id: "lbl-abcd-1234-5678", name: "bug", color: "#ef4444" }];
		const project = makeProject({ labels });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await (mutator as (p: Project) => Promise<{ updates: Partial<Project>; result: unknown }>)(project);
			return { project: { ...project, ...updates }, result } as never;
		});
		vi.mocked(data.loadTasks).mockResolvedValue([]);

		const resp = await handleRequest(
			makeRequest("label.delete", { projectId: "proj-1", labelId: "lbl-abcd" }),
		);
		expect(resp.ok).toBe(true);
	});

	it("errors on ambiguous label prefix", async () => {
		const labels = [
			{ id: "lbl-abcd-1234-aaaa-5678", name: "bug", color: "#ef4444" },
			{ id: "lbl-abcd-1234-bbbb-5678", name: "feature", color: "#14b8a6" },
		];
		vi.mocked(data.getProject).mockResolvedValue(makeProject({ labels }));

		const resp = await handleRequest(
			makeRequest("label.delete", { projectId: "proj-1", labelId: "lbl-abcd-1234" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Ambiguous");
	});

	it("errors when label not found", async () => {
		vi.mocked(data.getProject).mockResolvedValue(makeProject({ labels: [] }));

		const resp = await handleRequest(
			makeRequest("label.delete", { projectId: "proj-1", labelId: "nope" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Label not found");
	});
});

describe("task.setLabels", () => {
	it("errors when taskId is missing", async () => {
		const resp = await handleRequest(
			makeRequest("task.setLabels", { projectId: "proj-1", labelIds: [] }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("taskId is required");
	});

	it("errors when projectId is missing", async () => {
		const resp = await handleRequest(
			makeRequest("task.setLabels", { taskId: "t1", labelIds: [] }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("projectId is required");
	});

	it("errors when labelIds is not an array", async () => {
		const resp = await handleRequest(
			makeRequest("task.setLabels", { taskId: "t1", projectId: "proj-1", labelIds: "not-array" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("labelIds must be an array");
	});

	it("sets labels on task", async () => {
		const project = makeProject({
			labels: [
				{ id: "lbl-1", name: "bug", color: "#ef4444" },
				{ id: "lbl-2", name: "feature", color: "#14b8a6" },
			],
		});
		const task = makeTask({ labelIds: [] });
		const updated = { ...task, labelIds: ["lbl-1", "lbl-2"] };

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.setLabels", {
				taskId: task.id,
				projectId: "proj-1",
				labelIds: ["lbl-1", "lbl-2"],
			}),
		);
		expect(resp.ok).toBe(true);
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, {
			labelIds: ["lbl-1", "lbl-2"],
		});
	});

	it("rejects unknown label IDs instead of persisting garbage", async () => {
		const project = makeProject({
			labels: [{ id: "lbl-real", name: "bug", color: "#ef4444" }],
		});
		const task = makeTask({ labelIds: [] });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTask).mockResolvedValue(task);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.setLabels", {
				taskId: task.id,
				projectId: "proj-1",
				labelIds: ["lbl-real", "deadbeef-does-not-exist"],
			}),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Label not found");
		expect(resp.error).toContain("deadbeef-does-not-exist");
		// Nothing is persisted when validation fails.
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("resolves short label ID prefixes to full UUIDs", async () => {
		const labels = [
			{ id: "aaaa1111-2222-3333-4444-555555555555", name: "bug", color: "#ef4444" },
			{ id: "bbbb1111-2222-3333-4444-555555555555", name: "feature", color: "#14b8a6" },
		];
		const project = makeProject({ labels });
		const task = makeTask({ labelIds: [] });
		const updated = { ...task, labelIds: labels.map((l) => l.id) };

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.setLabels", {
				taskId: task.id,
				projectId: "proj-1",
				labelIds: ["aaaa1111", "bbbb1111"], // short prefixes
			}),
		);
		expect(resp.ok).toBe(true);
		// Should resolve to full UUIDs
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, {
			labelIds: [
				"aaaa1111-2222-3333-4444-555555555555",
				"bbbb1111-2222-3333-4444-555555555555",
			],
		});
	});

	it("errors on ambiguous label prefix in setLabels", async () => {
		const labels = [
			{ id: "aaaa1111-2222-3333-4444-aaaaaaaaaaaa", name: "bug", color: "#ef4444" },
			{ id: "aaaa1111-2222-3333-4444-bbbbbbbbbbbb", name: "feature", color: "#14b8a6" },
		];
		const project = makeProject({ labels });
		vi.mocked(data.getProject).mockResolvedValue(project);

		const resp = await handleRequest(
			makeRequest("task.setLabels", {
				taskId: "task-abc12345-1111-2222-3333-444444444444",
				projectId: "proj-1",
				labelIds: ["aaaa1111-2222-3333"],
			}),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Ambiguous");
	});

	it("clears labels when empty array provided", async () => {
		const project = makeProject();
		const task = makeTask({ labelIds: ["lbl-1"] });
		const updated = { ...task, labelIds: [] };

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.setLabels", {
				taskId: task.id,
				projectId: "proj-1",
				labelIds: [],
			}),
		);
		expect(resp.ok).toBe(true);
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { labelIds: [] });
	});
});

describe("startSocketServer", () => {
	beforeAll(() => {
		(globalThis as any).Bun.listen = vi.fn();
	});

	it("creates sockets directory and sets socketPath", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);

		const path = startSocketServer();

		expect(mkdirSync).toHaveBeenCalledWith("/tmp/test-dev3/sockets", { recursive: true });
		expect(path).toContain("/tmp/test-dev3/sockets/");
		expect(path).toContain(".sock");
		expect(getSocketPath()).toBe(path);
	});

	it("removes leftover socket file if it exists", () => {
		vi.mocked(existsSync).mockImplementation((p: any) => {
			// SOCKETS_DIR does not exist (skip stale cleanup) but socketPath does
			if (String(p).endsWith(".sock")) return true;
			return false;
		});
		vi.mocked(readdirSync).mockReturnValue([]);

		startSocketServer();

		expect(unlinkSync).toHaveBeenCalled();
	});

	it("cleans up stale sockets for dead processes", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number, _signal?: string | number) => {
			if (pid === 99999) throw new Error("ESRCH");
			return true;
		});

		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readdirSync).mockReturnValue([
			"99999.sock",
			"not-a-pid.sock",
			"readme.txt",
		] as any);

		startSocketServer();

		// Should have tried to check process 99999
		expect(killSpy).toHaveBeenCalledWith(99999, 0);
		// Should have removed the stale socket
		expect(unlinkSync).toHaveBeenCalledWith("/tmp/test-dev3/sockets/99999.sock");

		killSpy.mockRestore();
	});

	it("keeps sockets for alive processes", () => {
		// Use a PID different from current process to avoid collision with socketPath cleanup
		const alivePid = 77777;
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readdirSync).mockReturnValue([`${alivePid}.sock`] as any);

		startSocketServer();

		// Should have checked if process is alive (no throw = alive)
		expect(killSpy).toHaveBeenCalledWith(alivePid, 0);
		// Should NOT have removed the socket for the alive process via stale cleanup
		const unlinkCalls = vi.mocked(unlinkSync).mock.calls.map((c) => String(c[0]));
		const staleCalls = unlinkCalls.filter((p) => p.includes(`${alivePid}.sock`));
		expect(staleCalls).toHaveLength(0);

		killSpy.mockRestore();
	});

	it("buffers a large request split across socket data events", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);
		startSocketServer();

		const listenCalls = vi.mocked((globalThis as any).Bun.listen).mock.calls;
		const listenOptions = listenCalls[listenCalls.length - 1][0];
		const socketHandlers = listenOptions.socket;
		const socket = {};
		const project = makeProject();
		const task = makeTask({ status: "todo" });
		const description = `Line of markdown content.\n`.repeat(600);
		const request = JSON.stringify(makeRequest("task.create", {
			projectId: project.id,
			title: "Large description",
			description,
		})) + "\n";
		const splitAt = Math.floor(request.length / 2);

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(task);

		await socketHandlers.data(socket, Buffer.from(request.slice(0, splitAt), "utf-8"));
		expect(flushAndEnd).not.toHaveBeenCalled();

		await socketHandlers.data(socket, Buffer.from(request.slice(splitAt), "utf-8"));

		expect(data.addTask).toHaveBeenCalledWith(project, description.trim(), "todo");
		const flushCalls = vi.mocked(flushAndEnd).mock.calls;
		const response = flushCalls[flushCalls.length - 1][1] as string;
		expect(JSON.parse(response.trim())).toMatchObject({ id: "req-1", ok: true });
	});

	it("returns a clear error when a CLI request exceeds the payload limit", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);
		startSocketServer();

		const listenCalls = vi.mocked((globalThis as any).Bun.listen).mock.calls;
		const listenOptions = listenCalls[listenCalls.length - 1][0];
		const socketHandlers = listenOptions.socket;
		const socket = {};
		const oversizedRequest = "x".repeat(1024 * 1024 + 1);

		await socketHandlers.data(socket, Buffer.from(oversizedRequest, "utf-8"));

		const flushCalls = vi.mocked(flushAndEnd).mock.calls;
		const response = flushCalls[flushCalls.length - 1][1] as string;
		expect(JSON.parse(response.trim())).toMatchObject({
			id: "unknown",
			ok: false,
			error: "Payload exceeded 1024 KB limit, current size 1025 KB",
		});
	});
});

describe("stopSocketServer", () => {
	it("removes socket file when it exists", () => {
		// First start the server so socketPath is set
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);
		(globalThis as any).Bun.listen = vi.fn();
		startSocketServer();

		vi.clearAllMocks();
		vi.mocked(existsSync).mockReturnValue(true);

		stopSocketServer();
		expect(unlinkSync).toHaveBeenCalled();
	});

	it("does nothing when socket file does not exist", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);
		(globalThis as any).Bun.listen = vi.fn();
		startSocketServer();

		vi.clearAllMocks();
		vi.mocked(existsSync).mockReturnValue(false);

		stopSocketServer();
		expect(unlinkSync).not.toHaveBeenCalled();
	});
});

describe("vent.add", () => {
	it("records a vent and returns its filename (always on, no opt-in)", async () => {
		const resp = await handleRequest(makeRequest("vent.add", { name: "tmux split broken", content: "details here" }));

		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual({ fileName: "2026-06-15_14-30_x.md" });
		expect(addVent).toHaveBeenCalledWith("tmux split broken", "details here");
	});

	it("rejects empty name", async () => {
		const resp = await handleRequest(makeRequest("vent.add", { name: "", content: "c" }));
		expect(resp.ok).toBe(false);
		expect(addVent).not.toHaveBeenCalled();
	});

	it("rejects empty content", async () => {
		const resp = await handleRequest(makeRequest("vent.add", { name: "n", content: "" }));
		expect(resp.ok).toBe(false);
		expect(addVent).not.toHaveBeenCalled();
	});
});
