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

	it("shows the custom title (customTitle), not the auto-generated title", async () => {
		const taskWithCustomTitle: Task = {
			...TASKS[0],
			id: "cccccccc-1111-2222-3333-444444444444",
			seq: 3,
			title: "Bug (from bug-hunt review): the raw auto-generated description blob",
			customTitle: "Fix custom title display",
		};
		mockSend.mockResolvedValue(okResp([taskWithCustomTitle]));

		await handleTasks("list", { positional: [], flags: { project: "proj-001" } }, SOCKET, null);

		expect(stdoutOutput).toContain("Fix custom title display");
		expect(stdoutOutput).not.toContain("Bug (from bug-hunt review)");
	});

	it("does not mutate or persist task fields (read-only render)", async () => {
		const original: Task = {
			...TASKS[0],
			id: "dddddddd-1111-2222-3333-444444444444",
			seq: 4,
			title: "auto-generated title",
			customTitle: "custom title",
			titleEditedByUser: true,
		};
		const snapshot = JSON.stringify(original);
		mockSend.mockResolvedValue(okResp([original]));

		await handleTasks("list", { positional: [], flags: { project: "proj-001" } }, SOCKET, null);

		// Listing is purely a read — the task object must be byte-identical after.
		expect(JSON.stringify(original)).toBe(snapshot);
		// No write RPC should ever be issued by `tasks list`.
		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "tasks.list", { projectId: "proj-001" });
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

		// Use a full-length (>=36 char) id so expandShortProjectId returns it
		// verbatim. Short ids scan the on-disk projects.json, where a 1-char "p"
		// could prefix-match a leftover project from a sibling test file.
		const fullId = "proj-default-list-0000-0000-000000000000";
		await handleTasks(undefined, { positional: [], flags: { project: fullId } }, SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "tasks.list", { projectId: fullId });
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

	it("truncates results to --limit count (keeps the newest)", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: { project: "proj-001", limit: "1" } }, SOCKET, null);

		// Newest-first ordering means --limit 1 keeps seq 2 (the newer task).
		expect(stdoutOutput).toContain("Second task");
		expect(stdoutOutput).not.toContain("First task");
	});

	it("prints a footer showing the visible window and total", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: { project: "proj-001" } }, SOCKET, null);

		expect(stdoutOutput).toContain("Showing 1-2 of 2.");
	});

	it("orders newest first (highest seq) regardless of server order", async () => {
		// Server returns ascending; CLI must flip to descending by seq.
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: { project: "proj-001" } }, SOCKET, null);

		const firstIdx = stdoutOutput.indexOf("bbbbbbbb"); // seq 2
		const secondIdx = stdoutOutput.indexOf("aaaaaaaa"); // seq 1
		expect(firstIdx).toBeGreaterThan(-1);
		expect(secondIdx).toBeGreaterThan(-1);
		expect(firstIdx).toBeLessThan(secondIdx);
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

// ─── tasks list: default limit + --offset paging ─────────────────────────────

function makeTasks(count: number): Task[] {
	return Array.from({ length: count }, (_, i) => ({
		...TASKS[0],
		id: `t${String(i).padStart(8, "0")}-1111-2222-3333-444444444444`,
		seq: i + 1,
		title: `task number ${i + 1}`,
	}));
}

describe("tasks list default limit", () => {
	it("shows only the newest 50 tasks when --limit is omitted", async () => {
		mockSend.mockResolvedValue(okResp(makeTasks(60)));

		await handleTasks("list", { positional: [], flags: { project: "proj-001" } }, SOCKET, null);

		// Newest is seq 60; oldest in window is seq 11 (60 down to 11 = 50 rows).
		expect(stdoutOutput).toContain("task number 60");
		expect(stdoutOutput).toContain("task number 11");
		expect(stdoutOutput).not.toContain("task number 10");
		expect(stdoutOutput).toContain("Showing 1-50 of 60.");
		expect(stdoutOutput).toContain("Next page: --offset 50");
	});

	it("does not paginate when total fits in the default page", async () => {
		mockSend.mockResolvedValue(okResp(makeTasks(3)));

		await handleTasks("list", { positional: [], flags: { project: "proj-001" } }, SOCKET, null);

		expect(stdoutOutput).toContain("Showing 1-3 of 3.");
		expect(stdoutOutput).not.toContain("Next page");
	});
});

describe("tasks list --offset paging", () => {
	it("skips the first N tasks (after newest-first sort)", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: { project: "proj-001", offset: "1" } }, SOCKET, null);

		// Offset 1 skips the newest (seq 2), leaving seq 1.
		expect(stdoutOutput).toContain("First task");
		expect(stdoutOutput).not.toContain("Second task");
		expect(stdoutOutput).toContain("Showing 2-2 of 2.");
	});

	it("combines --offset with --limit for a middle window", async () => {
		mockSend.mockResolvedValue(okResp(makeTasks(10)));

		await handleTasks("list", { positional: [], flags: { project: "proj-001", offset: "2", limit: "3" } }, SOCKET, null);

		// Newest-first: seq 10,9,8 (offset 2 → start at seq 8), 3 rows → 8,7,6.
		expect(stdoutOutput).toContain("task number 8");
		expect(stdoutOutput).toContain("task number 6");
		expect(stdoutOutput).not.toContain("task number 9");
		expect(stdoutOutput).not.toContain("task number 5");
		expect(stdoutOutput).toContain("Showing 3-5 of 10.");
		expect(stdoutOutput).toContain("Next page: --offset 5 --limit 3");
	});

	it("reports when offset is past the end", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: { project: "proj-001", offset: "5" } }, SOCKET, null);

		expect(stdoutOutput).toContain("No tasks at offset 5 (2 total).");
	});

	it("accepts --offset 0 as the first page", async () => {
		mockSend.mockResolvedValue(okResp(TASKS));

		await handleTasks("list", { positional: [], flags: { project: "proj-001", offset: "0" } }, SOCKET, null);

		expect(stdoutOutput).toContain("Showing 1-2 of 2.");
	});

	it("rejects non-numeric --offset before sending to server", async () => {
		await expect(
			handleTasks("list", { positional: [], flags: { project: "proj-001", offset: "abc" } }, SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--offset");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects negative --offset", async () => {
		await expect(
			handleTasks("list", { positional: [], flags: { project: "proj-001", offset: "-1" } }, SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});
});
