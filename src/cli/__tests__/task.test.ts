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
		expect(stdoutOutput).toContain("In Progress");
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
