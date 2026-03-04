import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { Project, Task, CliRequest, TaskNote } from "../../shared/types";

// ---- Mocks ----

vi.mock("../data", () => ({
	loadProjects: vi.fn(),
	getProject: vi.fn(),
	loadTasks: vi.fn(),
	getTask: vi.fn(),
	addTask: vi.fn(),
	updateTask: vi.fn(),
}));

vi.mock("../git", () => ({
	createWorktree: vi.fn(),
	removeWorktree: vi.fn(),
}));

vi.mock("../pty-server", () => ({
	destroySession: vi.fn(),
}));

vi.mock("../rpc-handlers", () => {
	const ACTIVE = ["in-progress", "user-questions", "review-by-user", "review-by-ai"];
	return {
		isActive: vi.fn((status: string) => ACTIVE.includes(status)),
		launchTaskPty: vi.fn(),
		runCleanupScript: vi.fn(),
		getPushMessage: vi.fn(() => null),
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

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readdirSync: vi.fn(() => []),
	unlinkSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

import * as data from "../data";
import * as git from "../git";
import * as pty from "../pty-server";
import { launchTaskPty, runCleanupScript, getPushMessage } from "../rpc-handlers";
import { existsSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";

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

describe("projects.list", () => {
	it("returns all projects", async () => {
		const projects = [makeProject({ id: "p1" }), makeProject({ id: "p2" })];
		vi.mocked(data.loadProjects).mockResolvedValue(projects);

		const resp = await handleRequest(makeRequest("projects.list"));
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual(projects);
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

	it("creates task and pushes message", async () => {
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
		const updated = { ...task, title: "Updated" };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.update", { taskId: task.id, projectId: "proj-1", title: "Updated" }),
		);
		expect(resp.ok).toBe(true);
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { title: "Updated" });
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

	it("does not auto-generate title when explicit title provided", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, title: "Explicit", description: "Desc" });
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
		expect(call.title).toBe("Explicit");
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

	it("adds note with default source ai", async () => {
		const project = makeProject();
		const task = makeTask({ notes: [] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(task);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("note.add", { taskId: task.id, projectId: "proj-1", content: "Hello" }),
		);
		expect(resp.ok).toBe(true);
		const updateCall = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(updateCall.notes).toHaveLength(1);
		expect(updateCall.notes![0].content).toBe("Hello");
		expect(updateCall.notes![0].source).toBe("ai");
	});

	it("adds note with explicit source", async () => {
		const project = makeProject();
		const task = makeTask({ notes: [] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(task);
		vi.mocked(getPushMessage).mockReturnValue(null);

		await handleRequest(
			makeRequest("note.add", {
				taskId: task.id,
				projectId: "proj-1",
				content: "From user",
				source: "user",
			}),
		);
		const updateCall = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(updateCall.notes![0].source).toBe("user");
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
		vi.mocked(data.updateTask).mockResolvedValue(task);
		vi.mocked(getPushMessage).mockReturnValue(null);

		await handleRequest(
			makeRequest("note.add", { taskId: task.id, projectId: "proj-1", content: "New" }),
		);
		const updateCall = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(updateCall.notes).toHaveLength(2);
		expect(updateCall.notes![0]).toEqual(existingNote);
		expect(updateCall.notes![1].content).toBe("New");
	});

	it("resolves across projects when no projectId", async () => {
		const project = makeProject();
		const task = makeTask({ notes: [] });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(task);
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
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, notes: [] });
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("note.delete", {
				taskId: task.id,
				projectId: "proj-1",
				noteId: "note-full-uuid-1234",
			}),
		);
		expect(resp.ok).toBe(true);
		const updateCall = vi.mocked(data.updateTask).mock.calls[0][2];
		expect(updateCall.notes).toHaveLength(0);
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
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, notes: [] });
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("note.delete", { taskId: task.id, projectId: "proj-1", noteId: "note-abcd" }),
		);
		expect(resp.ok).toBe(true);
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
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, notes: [] });
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("note.delete", { taskId: task.id, noteId: "note-cross" }),
		);
		expect(resp.ok).toBe(true);
	});
});

describe("task.move", () => {
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
		const resp = await handleRequest(
			makeRequest("task.move", { taskId: "t1", newStatus: "bogus" }),
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("Invalid status: bogus");
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
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { status: "review-by-user" });
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
		vi.mocked(git.createWorktree).mockResolvedValue(wtResult);
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
		expect(git.createWorktree).toHaveBeenCalledWith(project, task);
		expect(launchTaskPty).toHaveBeenCalledWith(
			project,
			task, // NOT reopen, so original task (with description)
			"/tmp/new-wt",
			undefined,
			undefined,
			true,
		);
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, {
			status: "in-progress",
			worktreePath: "/tmp/new-wt",
			branchName: "dev3/task-new",
		});
	});

	it("reopen (completed → in-progress): launches with empty description", async () => {
		const project = makeProject();
		const task = makeTask({ status: "completed", description: "Old desc" });
		const wtResult = { worktreePath: "/tmp/reopen-wt", branchName: "dev3/reopen" };

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.createWorktree).mockResolvedValue(wtResult);
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

		// Should pass task with empty description for reopen
		const launchCall = vi.mocked(launchTaskPty).mock.calls[0];
		expect(launchCall[1].description).toBe("");
	});

	it("active → completed: destroys PTY, runs cleanup, removes worktree", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		const updated = { ...task, status: "completed" as const, worktreePath: null, branchName: null };

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "completed",
			}),
		);

		expect(resp.ok).toBe(true);
		expect(pty.destroySession).toHaveBeenCalledWith(task.id);
		expect(runCleanupScript).toHaveBeenCalledWith(task, project);
		expect(git.removeWorktree).toHaveBeenCalledWith(project, task);
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, {
			status: "completed",
			worktreePath: null,
			branchName: null,
		});
	});

	it("active → cancelled: same cleanup flow", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		const updated = { ...task, status: "cancelled" as const, worktreePath: null, branchName: null };

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: "proj-1",
				newStatus: "cancelled",
			}),
		);

		expect(resp.ok).toBe(true);
		expect(pty.destroySession).toHaveBeenCalled();
		expect(runCleanupScript).toHaveBeenCalled();
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
