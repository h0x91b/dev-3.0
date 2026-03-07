import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTask } from "../commands/task";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { Task, CliResponse } from "../../shared/types";

// Mock sendRequest so we never hit a real socket
vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

let stdoutOutput: string;
let stderrOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const SOCKET = "/tmp/test.sock";

const FAKE_TASK: Task = {
	id: "aaaaaaaa-1111-2222-3333-444444444444",
	seq: 42,
	projectId: "proj-001",
	title: "Fix the login bug",
	description: "Users report 500 on login with SSO enabled",
	status: "in-progress",
	baseBranch: "main",
	branchName: "dev3/task-aaaaaaaa",
	worktreePath: "/tmp/worktrees/proj/aaaaaaaa/worktree",
	groupId: null,
	variantIndex: null,
	agentId: null,
	configId: null,
	createdAt: "2026-03-01T10:00:00Z",
	updatedAt: "2026-03-01T12:00:00Z",
	movedAt: "2026-03-01T11:00:00Z",
};

const CTX: CliContext = {
	projectId: "proj-001",
	taskId: "aaaaaaaa-1111-2222-3333-444444444444",
	socketPath: SOCKET,
};

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function errResp(error: string): CliResponse {
	return { id: "test-id", ok: false, error };
}

function args(positional: string[] = [], flags: Record<string, string> = {}): ParsedArgs {
	return { positional, flags };
}

beforeEach(() => {
	stdoutOutput = "";
	stderrOutput = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdoutOutput += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderrOutput += String(chunk);
		return true;
	});
	exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => {
		throw new Error(`EXIT_${_code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

// ─── task show ───────────────────────────────────────────────────────────────

describe("task show", () => {
	it("shows task by explicit ID", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.show", {
			taskId: "aaaaaaaa",
		});
		expect(stdoutOutput).toContain("Fix the login bug");
		expect(stdoutOutput).toContain("Agent is Working");
	});

	it("auto-detects taskId from context when no ID given", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("show", args(), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.show", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
		});
	});

	it("auto-detects projectId from context", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("show", args(["aaaaaaaa"]), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.projectId).toBe(CTX.projectId);
	});

	it("--project flag overrides context projectId", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("show", args(["aaaaaaaa"], { project: "other-proj" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.projectId).toBe("other-proj");
	});

	it("exits with usage error when no ID and no context", async () => {
		await expect(handleTask("show", args(), SOCKET, null)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Usage:");
	});

	it("exits with error on server failure", async () => {
		mockSend.mockResolvedValue(errResp("Task not found"));

		await expect(handleTask("show", args(["bad"]), SOCKET, null)).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Task not found");
	});

	it("prints description when different from title", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);

		expect(stdoutOutput).toContain("Description:");
		expect(stdoutOutput).toContain("Users report 500");
	});

	it("skips description when same as title", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, description: FAKE_TASK.title }));

		await handleTask("show", args(["aaaaaaaa"]), SOCKET, null);

		expect(stdoutOutput).not.toContain("Description:");
	});
});

// ─── task create ─────────────────────────────────────────────────────────────

describe("task create", () => {
	const createdTask: Task = { ...FAKE_TASK, status: "todo", seq: 43, title: "New task" };

	it("creates task with explicit --project and --title", async () => {
		mockSend.mockResolvedValue(okResp(createdTask));

		await handleTask(
			"create",
			args([], { project: "proj-001", title: "New task" }),
			SOCKET,
			null,
		);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.create", {
			projectId: "proj-001",
			title: "New task",
		});
		expect(stdoutOutput).toContain("Created task");
		expect(stdoutOutput).toContain("New task");
	});

	it("auto-detects projectId from context", async () => {
		mockSend.mockResolvedValue(okResp(createdTask));

		await handleTask("create", args([], { title: "New task" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.projectId).toBe(CTX.projectId);
	});

	it("exits with usage error when --project missing and no context", async () => {
		await expect(
			handleTask("create", args([], { title: "New task" }), SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--project");
	});

	it("exits with usage error when --title missing", async () => {
		await expect(
			handleTask("create", args([], { project: "proj-001" }), SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--title");
	});

	it("prints created task summary with seq and short ID", async () => {
		mockSend.mockResolvedValue(okResp(createdTask));

		await handleTask("create", args([], { project: "proj-001", title: "New task" }), SOCKET, null);

		expect(stdoutOutput).toContain("seq 43");
		expect(stdoutOutput).toContain("aaaaaaaa"); // first 8 chars
	});
});

// ─── task update ─────────────────────────────────────────────────────────────

describe("task update", () => {
	it("updates title with explicit task ID", async () => {
		const updated = { ...FAKE_TASK, title: "Updated title" };
		mockSend.mockResolvedValue(okResp(updated));

		await handleTask(
			"update",
			args(["aaaaaaaa"], { title: "Updated title" }),
			SOCKET,
			null,
		);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.update", {
			taskId: "aaaaaaaa",
			title: "Updated title",
		});
		expect(stdoutOutput).toContain("Updated task");
		expect(stdoutOutput).toContain("Updated title");
	});

	it("auto-detects taskId from context", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("update", args([], { title: "New title" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe(CTX.taskId);
		expect(params.projectId).toBe(CTX.projectId);
	});

	it("updates description", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask(
			"update",
			args(["aaaaaaaa"], { description: "New description" }),
			SOCKET,
			null,
		);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.description).toBe("New description");
	});

	it("updates both title and description at once", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask(
			"update",
			args(["aaaaaaaa"], { title: "T", description: "D" }),
			SOCKET,
			null,
		);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.title).toBe("T");
		expect(params.description).toBe("D");
	});

	it("exits when neither --title nor --description given", async () => {
		await expect(
			handleTask("update", args(["aaaaaaaa"]), SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--title");
		expect(stderrOutput).toContain("--description");
	});

	it("exits when no task ID and no context", async () => {
		await expect(
			handleTask("update", args([], { title: "T" }), SOCKET, null),
		).rejects.toThrow("EXIT_3");
	});

	it("--project flag overrides context projectId", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask(
			"update",
			args([], { title: "T", project: "other" }),
			SOCKET,
			CTX,
		);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.projectId).toBe("other");
	});
});

// ─── task move ───────────────────────────────────────────────────────────────

describe("task move", () => {
	it("moves task to new status with explicit ID", async () => {
		const moved = { ...FAKE_TASK, status: "review-by-ai" as const };
		mockSend.mockResolvedValue(okResp(moved));

		await handleTask(
			"move",
			args(["aaaaaaaa"], { status: "review-by-ai" }),
			SOCKET,
			null,
		);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.move", {
			taskId: "aaaaaaaa",
			newStatus: "review-by-ai",
		});
		expect(stdoutOutput).toContain("Moved task");
		expect(stdoutOutput).toContain("Review by AI");
	});

	it("auto-detects taskId from context", async () => {
		const moved = { ...FAKE_TASK, status: "user-questions" as const };
		mockSend.mockResolvedValue(okResp(moved));

		await handleTask("move", args([], { status: "user-questions" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe(CTX.taskId);
		expect(params.projectId).toBe(CTX.projectId);
		expect(params.newStatus).toBe("user-questions");
	});

	it("auto-detects projectId from context", async () => {
		const moved = { ...FAKE_TASK, status: "review-by-user" as const };
		mockSend.mockResolvedValue(okResp(moved));

		await handleTask("move", args(["aaaaaaaa"], { status: "review-by-user" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.projectId).toBe(CTX.projectId);
	});

	it("--project flag overrides context projectId", async () => {
		const moved = { ...FAKE_TASK, status: "todo" as const };
		mockSend.mockResolvedValue(okResp(moved));

		await handleTask(
			"move",
			args(["aaaaaaaa"], { status: "todo", project: "other" }),
			SOCKET,
			CTX,
		);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.projectId).toBe("other");
	});

	it("exits when --status missing", async () => {
		await expect(
			handleTask("move", args(["aaaaaaaa"]), SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--status");
	});

	it("exits when no task ID and no context", async () => {
		await expect(
			handleTask("move", args([], { status: "todo" }), SOCKET, null),
		).rejects.toThrow("EXIT_3");
	});

	it("blocks completed status (destroys worktree)", async () => {
		await expect(
			handleTask("move", args(["aaaaaaaa"], { status: "completed" }), SOCKET, null),
		).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Cannot move to");
		expect(stderrOutput).toContain("destroys the worktree");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("blocks cancelled status (destroys worktree)", async () => {
		await expect(
			handleTask("move", args(["aaaaaaaa"], { status: "cancelled" }), SOCKET, null),
		).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Cannot move to");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("exits on server error (e.g. invalid transition)", async () => {
		mockSend.mockResolvedValue(errResp("Invalid status transition"));

		await expect(
			handleTask("move", args(["aaaaaaaa"], { status: "todo" }), SOCKET, null),
		).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Invalid status transition");
	});

	it("prints arrow notation with status label", async () => {
		const moved = { ...FAKE_TASK, status: "review-by-ai" as const };
		mockSend.mockResolvedValue(okResp(moved));

		await handleTask("move", args(["aaaaaaaa"], { status: "review-by-ai" }), SOCKET, null);

		expect(stdoutOutput).toMatch(/→.*Review by AI/);
	});
});

// ─── --id flag support ───────────────────────────────────────────────────────
// The CLI should accept --id <taskId> as an alternative to positional arg.
// This lets agents update/show/move ANY task, not just the current one.

describe("task show --id flag", () => {
	it("uses --id flag when no positional arg given", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("show", args([], { id: "bbbbbbbb" }), SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.show", {
			taskId: "bbbbbbbb",
		});
	});

	it("--id flag takes priority over context taskId", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("show", args([], { id: "bbbbbbbb" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("bbbbbbbb");
	});

	it("positional arg takes priority over --id flag", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("show", args(["cccccccc"], { id: "bbbbbbbb" }), SOCKET, null);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("cccccccc");
	});
});

describe("task update --id flag", () => {
	it("uses --id flag when no positional arg given", async () => {
		const updated = { ...FAKE_TASK, title: "Updated" };
		mockSend.mockResolvedValue(okResp(updated));

		await handleTask("update", args([], { id: "bbbbbbbb", title: "Updated" }), SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.update", {
			taskId: "bbbbbbbb",
			title: "Updated",
		});
	});

	it("--id flag takes priority over context taskId", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("update", args([], { id: "bbbbbbbb", title: "T" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("bbbbbbbb");
	});

	it("--id flag should NOT silently fall back to context", async () => {
		// If --id is provided, the request must use that ID, never the context task
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask("update", args([], { id: "different-task", title: "T" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).not.toBe(CTX.taskId);
		expect(params.taskId).toBe("different-task");
	});
});

describe("task move --id flag", () => {
	it("uses --id flag when no positional arg given", async () => {
		const moved = { ...FAKE_TASK, status: "todo" as const };
		mockSend.mockResolvedValue(okResp(moved));

		await handleTask("move", args([], { id: "bbbbbbbb", status: "todo" }), SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.move", {
			taskId: "bbbbbbbb",
			newStatus: "todo",
		});
	});

	it("--id flag takes priority over context taskId", async () => {
		const moved = { ...FAKE_TASK, status: "todo" as const };
		mockSend.mockResolvedValue(okResp(moved));

		await handleTask("move", args([], { id: "bbbbbbbb", status: "todo" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("bbbbbbbb");
	});
});

// ─── task create --description ───────────────────────────────────────────────
// create should support --description to set initial description

describe("task create --description", () => {
	const createdTask: Task = { ...FAKE_TASK, status: "todo", seq: 50, title: "With desc", description: "Full description here" };

	it("sends description to server when --description is provided", async () => {
		mockSend.mockResolvedValue(okResp(createdTask));

		await handleTask(
			"create",
			args([], { project: "proj-001", title: "With desc", description: "Full description here" }),
			SOCKET,
			null,
		);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.create", {
			projectId: "proj-001",
			title: "With desc",
			description: "Full description here",
		});
	});

	it("works without --description (backward compat)", async () => {
		mockSend.mockResolvedValue(okResp(createdTask));

		await handleTask(
			"create",
			args([], { project: "proj-001", title: "No desc" }),
			SOCKET,
			null,
		);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params).not.toHaveProperty("description");
	});
});

// ─── task move: status validation ────────────────────────────────────────────
// The CLI blocks "completed" and "cancelled" only. Unknown values (potential
// custom column IDs) are forwarded to the server, which validates them.

describe("task move status validation", () => {
	it("forwards unknown status values to the server (may be a custom column ID)", async () => {
		mockSend.mockResolvedValue({ id: "r", ok: false, error: "Invalid status: \"garbage\"" });
		await expect(
			handleTask("move", args(["aaaaaaaa"], { status: "garbage" }), SOCKET, null),
		).rejects.toThrow("EXIT_1");
		expect(mockSend).toHaveBeenCalled();
	});

	it("forwards typo'd status to the server (e.g. 'in_progress' instead of 'in-progress')", async () => {
		mockSend.mockResolvedValue({ id: "r", ok: false, error: "Invalid status: \"in_progress\"" });
		await expect(
			handleTask("move", args(["aaaaaaaa"], { status: "in_progress" }), SOCKET, null),
		).rejects.toThrow("EXIT_1");
		expect(mockSend).toHaveBeenCalled();
	});

	it("rejects empty string status", async () => {
		await expect(
			handleTask("move", args(["aaaaaaaa"], { status: "" }), SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});
});

// ─── task create: cross-project ──────────────────────────────────────────────

describe("task create cross-project", () => {
	const createdTask = {
		...FAKE_TASK,
		status: "todo" as const,
		seq: 50,
		projectId: "other-proj",
	};

	it("--project flag allows creating task in a different project", async () => {
		mockSend.mockResolvedValue(okResp(createdTask));

		await handleTask(
			"create",
			args([], { project: "other-proj", title: "Cross-project task" }),
			SOCKET,
			CTX,
		);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.projectId).toBe("other-proj");
		// context projectId should NOT override explicit --project
		expect(params.projectId).not.toBe(CTX.projectId);
	});
});

// ─── task update: no project, no context ─────────────────────────────────────
// When updating a foreign task by explicit ID without --project and without
// context, the request should still work (server resolves by task ID alone),
// but projectId should not be silently injected from a wrong context.

describe("task update foreign task without project", () => {
	it("sends request without projectId when updating by explicit ID, no context", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleTask(
			"update",
			args(["bbbbbbbb"], { title: "Foreign update" }),
			SOCKET,
			null,
		);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("bbbbbbbb");
		expect(params).not.toHaveProperty("projectId");
	});
});

// ─── short ID resolution ─────────────────────────────────────────────────────
// `tasks list` displays 8-char short IDs (t.id.slice(0, 8)).
// When the user copies that ID and uses it with task show/update/move,
// the CLI must resolve it to the full UUID before sending to the server.
// Currently the CLI passes the 8-char string as-is, and the server returns
// "Task not found" because it only matches on full UUIDs.
//
// We observed this bug live:
//   $ dev3 task show --id 5f01f223
//   error: Task not found: 5f01f223

describe("task show: short ID resolution", () => {
	it("resolves 8-char short ID to full UUID before sending to server", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		const shortId = FAKE_TASK.id.slice(0, 8); // "aaaaaaaa"
		await handleTask("show", args([shortId]), SOCKET, CTX);

		const sentId = (mockSend.mock.calls[0]![2]! as Record<string, unknown>).taskId;
		// The server should receive the FULL UUID, not the 8-char prefix
		expect(sentId).toBe(FAKE_TASK.id);
	});
});

describe("task update: short ID resolution", () => {
	it("resolves 8-char short ID to full UUID before sending to server", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		const shortId = FAKE_TASK.id.slice(0, 8);
		await handleTask("update", args([shortId], { title: "Updated" }), SOCKET, CTX);

		const sentId = (mockSend.mock.calls[0]![2]! as Record<string, unknown>).taskId;
		expect(sentId).toBe(FAKE_TASK.id);
	});
});

describe("task move: short ID resolution", () => {
	it("resolves 8-char short ID to full UUID before sending to server", async () => {
		const moved = { ...FAKE_TASK, status: "todo" as const };
		mockSend.mockResolvedValue(okResp(moved));

		const shortId = FAKE_TASK.id.slice(0, 8);
		await handleTask("move", args([shortId], { status: "todo" }), SOCKET, CTX);

		const sentId = (mockSend.mock.calls[0]![2]! as Record<string, unknown>).taskId;
		expect(sentId).toBe(FAKE_TASK.id);
	});
});

// ─── whitespace validation ───────────────────────────────────────────────────
// Whitespace-only strings are truthy ("   ".length > 0), so they pass basic
// `if (!title)` checks. But creating a task with "   " as the title or updating
// to a whitespace-only value is never intentional — it's always a user error
// that should be caught early.

describe("task create whitespace validation", () => {
	it("rejects whitespace-only --title", async () => {
		await expect(
			handleTask("create", args([], { project: "proj-001", title: "   " }), SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--title");
		expect(mockSend).not.toHaveBeenCalled();
	});
});

describe("task update whitespace validation", () => {
	it("rejects whitespace-only --title when it's the only update field", async () => {
		await expect(
			handleTask("update", args(["aaaaaaaa"], { title: "   " }), SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects whitespace-only --description when it's the only update field", async () => {
		await expect(
			handleTask("update", args(["aaaaaaaa"], { description: "   " }), SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});
});

// ─── unknown subcommand ──────────────────────────────────────────────────────

describe("task (unknown subcommand)", () => {
	it("exits with usage error for unknown subcommand", async () => {
		await expect(
			handleTask("deploy", args(), SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Unknown subcommand");
	});

	it("exits with usage error when no subcommand", async () => {
		await expect(
			handleTask(undefined, args(), SOCKET, null),
		).rejects.toThrow("EXIT_3");
	});
});
