import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTasks } from "../commands/tasks";
import type { CliContext } from "../context";
import type { Task, CliResponse } from "../../shared/types";

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

const CTX: CliContext = {
	projectId: "proj-001",
	taskId: "task-001",
	socketPath: SOCKET,
};

const TASKS: Task[] = [
	{
		id: "aaaaaaaa-1111-2222-3333-444444444444",
		seq: 1,
		projectId: "proj-001",
		title: "First task",
		description: "",
		status: "todo",
		baseBranch: "main",
		branchName: null,
		worktreePath: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-03-01T10:00:00Z",
		updatedAt: "2026-03-01T10:00:00Z",
	},
	{
		id: "bbbbbbbb-1111-2222-3333-444444444444",
		seq: 2,
		projectId: "proj-001",
		title: "Second task with a very long title that exceeds sixty characters limit for display",
		description: "",
		status: "in-progress",
		baseBranch: "main",
		branchName: "dev3/task-bbbbbbbb",
		worktreePath: "/tmp/wt",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-03-01T11:00:00Z",
		updatedAt: "2026-03-01T12:00:00Z",
	},
];

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function errResp(error: string): CliResponse {
	return { id: "test-id", ok: false, error };
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

describe("tasks list", () => {
	it("lists tasks with explicit --project", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: { project: "proj-001" } }, SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "tasks.list", { projectId: "proj-001" });
		expect(stdoutOutput).toContain("SEQ");
		expect(stdoutOutput).toContain("First task");
		expect(stdoutOutput).toContain("To Do");
		expect(stdoutOutput).toContain("Agent is Working");
	});

	it("auto-detects projectId from context", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: {} }, SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "tasks.list", { projectId: CTX.projectId });
	});

	it("passes --status filter to server", async () => {
		mockSend.mockResolvedValue(okResp([TASKS[0]]));

		await handleTasks("list", { positional: [], flags: { project: "proj-001", status: "todo" } }, SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "tasks.list", {
			projectId: "proj-001",
			status: "todo",
		});
	});

	it("prints 'No tasks found' for empty list", async () => {
		mockSend.mockResolvedValue(okResp([]));

		await handleTasks("list", { positional: [], flags: { project: "proj-001" } }, SOCKET, null);

		expect(stdoutOutput).toContain("No tasks found");
	});

	it("truncates long titles at 60 chars", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: { project: "proj-001" } }, SOCKET, null);

		// The second task has a title > 60 chars, should be truncated with "..."
		expect(stdoutOutput).toContain("...");
	});

	it("shows short (8-char) task IDs", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: { project: "proj-001" } }, SOCKET, null);

		expect(stdoutOutput).toContain("aaaaaaaa");
		expect(stdoutOutput).toContain("bbbbbbbb");
		// Full UUIDs should NOT appear
		expect(stdoutOutput).not.toContain("aaaaaaaa-1111");
	});

	it("exits with usage error when --project missing and no context", async () => {
		await expect(
			handleTasks("list", { positional: [], flags: {} }, SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--project");
	});

	it("exits on server error", async () => {
		mockSend.mockResolvedValue(errResp("Project not found"));

		await expect(
			handleTasks("list", { positional: [], flags: { project: "bad" } }, SOCKET, null),
		).rejects.toThrow("EXIT_1");
	});

	it("defaults to 'list' when no subcommand", async () => {
		mockSend.mockResolvedValue(okResp([]));

		await handleTasks(undefined, { positional: [], flags: { project: "p" } }, SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "tasks.list", { projectId: "p" });
	});

	it("exits with error for unknown subcommand", async () => {
		await expect(
			handleTasks("delete", { positional: [], flags: {} }, SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Unknown subcommand");
	});
});

// ─── tasks list: status validation ───────────────────────────────────────────
// CLI doesn't validate --status value before sending to server.
// Invalid values should be caught early with a helpful error message.

describe("tasks list status validation", () => {
	it("rejects invalid --status values before sending to server", async () => {
		await expect(
			handleTasks("list", { positional: [], flags: { project: "proj-001", status: "garbage" } }, SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Invalid status");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects typo'd status (e.g. 'inprogress')", async () => {
		await expect(
			handleTasks("list", { positional: [], flags: { project: "proj-001", status: "inprogress" } }, SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});
});

// ─── tasks list: --limit support ─────────────────────────────────────────────

describe("tasks list --limit", () => {
	it("does not send limit to server (applied client-side)", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: { project: "proj-001", limit: "10" } }, SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "tasks.list", {
			projectId: "proj-001",
		});
	});

	it("truncates results to --limit count", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: { project: "proj-001", limit: "1" } }, SOCKET, null);

		expect(stdoutOutput).toContain("First task");
		expect(stdoutOutput).not.toContain("Second task");
	});

	it("shows all tasks when --limit exceeds task count", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: { project: "proj-001", limit: "100" } }, SOCKET, null);

		expect(stdoutOutput).toContain("First task");
		expect(stdoutOutput).toContain("bbbbbbbb");
	});
});

// ─── tasks list: --limit validation ─────────────────────────────────────────
// parseInt("abc", 10) returns NaN, parseInt("10abc", 10) returns 10.
// Both are wrong — the CLI should reject non-numeric and negative values
// instead of silently sending garbage to the server.

describe("tasks list --limit validation", () => {
	it("rejects non-numeric --limit (e.g. 'abc') before sending to server", async () => {
		await expect(
			handleTasks("list", { positional: [], flags: { project: "proj-001", limit: "abc" } }, SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--limit");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects negative --limit (e.g. '-5')", async () => {
		await expect(
			handleTasks("list", { positional: [], flags: { project: "proj-001", limit: "-5" } }, SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects partial number --limit (e.g. '10abc') — parseInt silently truncates", async () => {
		await expect(
			handleTasks("list", { positional: [], flags: { project: "proj-001", limit: "10abc" } }, SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});
});
