import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleNote } from "../commands/note";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { Task, TaskNote, CliResponse } from "../../shared/types";

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

const FAKE_NOTE: TaskNote = {
	id: "nnnnnnnn-1111-2222-3333-444444444444",
	content: "Found a race condition in auth",
	source: "ai",
	createdAt: "2026-03-02T10:00:00Z",
	updatedAt: "2026-03-02T10:00:00Z",
};

const FAKE_TASK: Task = {
	id: "aaaaaaaa-1111-2222-3333-444444444444",
	seq: 42,
	projectId: "proj-001",
	title: "Fix the login bug",
	description: "Users report 500 on login",
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
	notes: [FAKE_NOTE],
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

// ─── note add ─────────────────────────────────────────────────────────────────

describe("note add", () => {
	it("adds note with positional content", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleNote("add", args(["Found a race condition"]), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "note.add", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
			content: "Found a race condition",
			source: "ai",
		});
		expect(stdoutOutput).toContain("Added note");
		expect(stdoutOutput).toContain("nnnnnnnn");
	});

	it("adds note with --content flag", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleNote("add", args([], { content: "Note via flag" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.content).toBe("Note via flag");
	});

	it("defaults source to ai", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleNote("add", args(["test"]), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.source).toBe("ai");
	});

	it("accepts --source user", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleNote("add", args(["user note"], { source: "user" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.source).toBe("user");
	});

	it("rejects invalid --source", async () => {
		await expect(
			handleNote("add", args(["note"], { source: "bot" }), SOCKET, CTX),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Invalid --source");
	});

	it("auto-detects taskId and projectId from context", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleNote("add", args(["test note"]), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe(CTX.taskId);
		expect(params.projectId).toBe(CTX.projectId);
	});

	it("--project flag overrides context", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleNote("add", args(["test"], { project: "other-proj" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.projectId).toBe("other-proj");
	});

	it("uses --task flag when no context", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleNote(
			"add",
			args(["test"], { task: "bbbbbbbb", project: "proj-001" }),
			SOCKET,
			null,
		);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("bbbbbbbb");
	});

	it("uses --task-id flag when no context", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleNote(
			"add",
			args(["test"], { "task-id": "cccccccc", project: "proj-001" }),
			SOCKET,
			null,
		);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("cccccccc");
	});

	it("exits when no content", async () => {
		await expect(
			handleNote("add", args(), SOCKET, CTX),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Content is required");
	});

	it("exits when no taskId and no context", async () => {
		await expect(
			handleNote("add", args(["content"]), SOCKET, null),
		).rejects.toThrow("EXIT_3");
	});

	it("exits on server error", async () => {
		mockSend.mockResolvedValue(errResp("Task not found"));

		await expect(
			handleNote("add", args(["test"]), SOCKET, CTX),
		).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Task not found");
	});

	it("prints note short ID and source in output", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleNote("add", args(["test"]), SOCKET, CTX);

		expect(stdoutOutput).toContain("[ai]");
		expect(stdoutOutput).toContain("aaaaaaaa"); // task short ID
	});
});

// ─── note list ────────────────────────────────────────────────────────────────

describe("note list", () => {
	it("lists notes from context task", async () => {
		mockSend.mockResolvedValue(okResp([FAKE_NOTE]));

		await handleNote("list", args(), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "note.list", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("nnnnnnnn");
		expect(stdoutOutput).toContain("ai");
		expect(stdoutOutput).toContain("Found a race condition");
	});

	it("shows empty message when no notes", async () => {
		mockSend.mockResolvedValue(okResp([]));

		await handleNote("list", args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("No notes");
	});

	it("accepts explicit task ID as positional arg", async () => {
		mockSend.mockResolvedValue(okResp([]));

		await handleNote("list", args(["bbbbbbbb"]), SOCKET, null);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("bbbbbbbb");
	});

	it("uses --task-id flag when listing notes", async () => {
		mockSend.mockResolvedValue(okResp([]));

		await handleNote("list", args([], { "task-id": "cccccccc" }), SOCKET, null);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("cccccccc");
	});

	it("--project flag overrides context", async () => {
		mockSend.mockResolvedValue(okResp([]));

		await handleNote("list", args([], { project: "other-proj" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.projectId).toBe("other-proj");
	});

	it("exits when no taskId and no context", async () => {
		await expect(
			handleNote("list", args(), SOCKET, null),
		).rejects.toThrow("EXIT_3");
	});

	it("exits on server error", async () => {
		mockSend.mockResolvedValue(errResp("Task not found"));

		await expect(
			handleNote("list", args(), SOCKET, CTX),
		).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Task not found");
	});

	it("truncates long content in table", async () => {
		const longNote: TaskNote = {
			...FAKE_NOTE,
			content: "A".repeat(100),
		};
		mockSend.mockResolvedValue(okResp([longNote]));

		await handleNote("list", args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("…");
	});

	it("replaces newlines with spaces in table", async () => {
		const multilineNote: TaskNote = {
			...FAKE_NOTE,
			content: "Line one\nLine two\nLine three",
		};
		mockSend.mockResolvedValue(okResp([multilineNote]));

		await handleNote("list", args(), SOCKET, CTX);

		expect(stdoutOutput).not.toContain("\nLine two");
		expect(stdoutOutput).toContain("Line one Line two");
	});
});

// ─── note show ────────────────────────────────────────────────────────────────

describe("note show", () => {
	const MULTILINE_NOTE: TaskNote = {
		id: "abcd1234-1111-2222-3333-444444444444",
		content: "What happened: rewrote the parser.\nWhat's next: wire it into the RPC handler and add tests.",
		source: "ai",
		createdAt: "2026-03-02T10:00:00Z",
		updatedAt: "2026-03-02T10:00:00Z",
	};

	it("prints the full untruncated note body by 8-char prefix", async () => {
		mockSend.mockResolvedValue(okResp([MULTILINE_NOTE]));

		await handleNote("show", args(["abcd1234"]), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "note.list", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("abcd1234");
		expect(stdoutOutput).toContain("What happened: rewrote the parser.");
		expect(stdoutOutput).toContain("What's next: wire it into the RPC handler");
		expect(stdoutOutput).not.toContain("…");
	});

	it("errors when no note id given", async () => {
		await expect(handleNote("show", args([]), SOCKET, CTX)).rejects.toThrow(/EXIT_/);
		expect(stderrOutput).toContain("Usage: dev3 note show");
	});

	it("errors when note not found", async () => {
		mockSend.mockResolvedValue(okResp([MULTILINE_NOTE]));

		await expect(handleNote("show", args(["deadbeef"]), SOCKET, CTX)).rejects.toThrow(/EXIT_/);
		expect(stderrOutput).toContain("Note not found");
	});

	it("errors on ambiguous prefix", async () => {
		const a = { ...MULTILINE_NOTE, id: "ffff0000-aaaa" };
		const b = { ...MULTILINE_NOTE, id: "ffff0000-bbbb" };
		mockSend.mockResolvedValue(okResp([a, b]));

		await expect(handleNote("show", args(["ffff0000"]), SOCKET, CTX)).rejects.toThrow(/EXIT_/);
		expect(stderrOutput).toContain("Ambiguous note id");
	});
});

// ─── note delete ──────────────────────────────────────────────────────────────

describe("note delete", () => {
	it("deletes note by ID", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, notes: [] }));

		await handleNote("delete", args(["nnnnnnnn"]), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "note.delete", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
			noteId: "nnnnnnnn",
		});
		expect(stdoutOutput).toContain("Deleted note");
		expect(stdoutOutput).toContain("nnnnnnnn");
	});

	it("auto-detects taskId from context", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, notes: [] }));

		await handleNote("delete", args(["nnnnnnnn"]), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe(CTX.taskId);
	});

	it("uses --task flag when no context", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, notes: [] }));

		await handleNote(
			"delete",
			args(["nnnnnnnn"], { task: "bbbbbbbb", project: "proj-001" }),
			SOCKET,
			null,
		);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("bbbbbbbb");
	});

	it("uses --task-id flag when deleting a note", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, notes: [] }));

		await handleNote(
			"delete",
			args(["nnnnnnnn"], { "task-id": "cccccccc", project: "proj-001" }),
			SOCKET,
			null,
		);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("cccccccc");
	});

	it("--project flag overrides context", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, notes: [] }));

		await handleNote("delete", args(["nnnnnnnn"], { project: "other" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.projectId).toBe("other");
	});

	it("exits when no note ID given", async () => {
		await expect(
			handleNote("delete", args(), SOCKET, CTX),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Usage:");
	});

	it("exits when no taskId and no context", async () => {
		await expect(
			handleNote("delete", args(["nnnnnnnn"]), SOCKET, null),
		).rejects.toThrow("EXIT_3");
	});

	it("exits on server error", async () => {
		mockSend.mockResolvedValue(errResp("Note not found"));

		await expect(
			handleNote("delete", args(["badid"]), SOCKET, CTX),
		).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Note not found");
	});
});

// ─── note: --id flag consistency with task commands ──────────────────────────
// Note commands use --task flag to target a specific task.
// Task commands should similarly support --id flag.
// These tests verify the INCONSISTENCY: note --task works but task --id doesn't.

describe("note vs task: flag consistency", () => {
	it("note add: --task flag overrides context (works correctly)", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleNote("add", args(["cross-task note"], { task: "different-id" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		// note commands handle this correctly — --task overrides context
		expect(params.taskId).toBe("different-id");
		expect(params.taskId).not.toBe(CTX.taskId);
	});

	it("note list: --task flag overrides context (works correctly)", async () => {
		mockSend.mockResolvedValue(okResp([]));

		await handleNote("list", args([], { task: "different-id" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("different-id");
	});

	it("note delete: --task flag overrides context (works correctly)", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, notes: [] }));

		await handleNote("delete", args(["nnnnnnnn"], { task: "different-id" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("different-id");
	});
});

// ─── note add: multiline content ─────────────────────────────────────────────

describe("note add multiline", () => {
	it("preserves newlines in note content", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		const multiline = "Line 1\nLine 2\nLine 3";
		await handleNote("add", args([multiline]), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.content).toBe(multiline);
		expect(params.content).toContain("\n");
	});
});

describe("note unknown flags", () => {
	it("rejects unknown flags instead of falling back to context", async () => {
		await expect(
			handleNote("add", args(["note"], { taskk: "bbbbbbbb" }), SOCKET, CTX),
		).rejects.toThrow("EXIT_3");

		expect(stderrOutput).toContain("Unknown option");
		expect(stderrOutput).toContain("--taskk");
		expect(mockSend).not.toHaveBeenCalled();
	});
});

// ─── short ID resolution ─────────────────────────────────────────────────────
// Same bug as task commands: `tasks list` shows 8-char IDs, but passing
// a short ID via --task to note commands sends it as-is to the server,
// which can't resolve it. The CLI should expand short IDs to full UUIDs.

describe("note add: short ID resolution via --task", () => {
	it("resolves 8-char --task ID to full UUID before sending to server", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		const shortId = FAKE_TASK.id.slice(0, 8); // "aaaaaaaa"
		await handleNote("add", args(["test note"], { task: shortId }), SOCKET, CTX);

		const sentTaskId = (mockSend.mock.calls[0]![2]! as Record<string, unknown>).taskId;
		expect(sentTaskId).toBe(FAKE_TASK.id); // full UUID, not "aaaaaaaa"
	});
});

describe("note list: short ID resolution via positional", () => {
	it("resolves 8-char positional task ID to full UUID", async () => {
		mockSend.mockResolvedValue(okResp([]));

		const shortId = FAKE_TASK.id.slice(0, 8);
		await handleNote("list", args([shortId]), SOCKET, CTX);

		const sentTaskId = (mockSend.mock.calls[0]![2]! as Record<string, unknown>).taskId;
		expect(sentTaskId).toBe(FAKE_TASK.id); // full UUID
	});
});

describe("note delete: short ID resolution via --task", () => {
	it("resolves 8-char --task ID to full UUID before sending to server", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, notes: [] }));

		const shortId = FAKE_TASK.id.slice(0, 8);
		await handleNote("delete", args(["nnnnnnnn"], { task: shortId }), SOCKET, CTX);

		const sentTaskId = (mockSend.mock.calls[0]![2]! as Record<string, unknown>).taskId;
		expect(sentTaskId).toBe(FAKE_TASK.id); // full UUID
	});
});

// ─── note add: whitespace validation ─────────────────────────────────────────
// Whitespace-only content ("   ") is truthy but meaningless.
// The CLI should reject it early instead of creating an empty-looking note.

describe("note add whitespace validation", () => {
	it("rejects whitespace-only positional content", async () => {
		await expect(
			handleNote("add", args(["   "]), SOCKET, CTX),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Content");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects whitespace-only --content flag", async () => {
		await expect(
			handleNote("add", args([], { content: "   " }), SOCKET, CTX),
		).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});
});

// ─── unknown subcommand ──────────────────────────────────────────────────────

describe("note (unknown subcommand)", () => {
	it("exits with usage error for unknown subcommand", async () => {
		await expect(
			handleNote("edit", args(), SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Unknown subcommand");
	});

	it("exits with usage error when no subcommand", async () => {
		await expect(
			handleNote(undefined, args(), SOCKET, null),
		).rejects.toThrow("EXIT_3");
	});
});
