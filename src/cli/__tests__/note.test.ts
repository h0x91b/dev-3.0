import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleNote } from "../commands/note";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { Task, TaskNote, CliResponse } from "../../shared/types";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

vi.mock("../stdin", () => ({
	readStdin: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { readStdin } from "../stdin";
const mockSend = vi.mocked(sendRequest);
const mockReadStdin = vi.mocked(readStdin);

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
	mockReadStdin.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

const DELETED = { ...FAKE_TASK, notes: [] };

/** The params of the last request — what every targeting assertion reads. */
function lastParams(): Record<string, unknown> {
	return mockSend.mock.calls[mockSend.mock.calls.length - 1]![2]! as Record<string, unknown>;
}

// ─── note add ─────────────────────────────────────────────────────────────────

describe("note add", () => {
	it("adds a positional note to the context task with source ai, printing its short id, source and task", async () => {
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
		expect(stdoutOutput).toContain("[ai]");
		expect(stdoutOutput).toContain("aaaaaaaa"); // task short ID
	});

	it("takes the content from --content too, and preserves newlines", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleNote("add", args([], { content: "Note via flag" }), SOCKET, CTX);
		expect(lastParams().content).toBe("Note via flag");

		const multiline = "Line 1\nLine 2\nLine 3";
		await handleNote("add", args([multiline]), SOCKET, CTX);
		expect(lastParams().content).toBe(multiline);
	});

	it("reads --content - from stdin without altering Markdown, honouring --source user", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));
		const markdown = 'Decision:\n\n- Keep "quoted" Markdown.';
		mockReadStdin.mockResolvedValue(markdown);

		await handleNote("add", args([], { content: "-", source: "user" }), SOCKET, CTX);

		expect(mockReadStdin).toHaveBeenCalledOnce();
		expect(lastParams().content).toBe(markdown);
		expect(lastParams().source).toBe("user");
	});

	it("refuses missing, blank, doubled or split content and an invalid --source, before any request", async () => {
		const cases: Array<[string, string[], Record<string, string>, string?]> = [
			["no content", [], {}, "Content is required"],
			["whitespace-only positional", ["   "], {}, "Content"],
			["whitespace-only --content", [], { content: "   " }],
			["bare --content (would save \"true\")", [], { content: "true" }],
			["positional together with --content", ["short"], { content: "the long report" }, "given twice"],
			["unquoted words", ["only", "the", "first"], {}, "3 separate text arguments"],
			["invalid --source", ["note"], { source: "bot" }, "Invalid --source"],
		];
		for (const [name, positional, flags, message] of cases) {
			stderrOutput = "";
			await expect(handleNote("add", args(positional, flags), SOCKET, CTX), name).rejects.toThrow("EXIT_3");
			if (message) expect(stderrOutput, name).toContain(message);
		}
		expect(mockSend).not.toHaveBeenCalled();
		expect(mockReadStdin).not.toHaveBeenCalled();
	});
});

// ─── targeting: context, --task, --task-id, --project ────────────────────────
// Every subcommand resolves its task the same way: context by default, --task /
// --task-id (or a positional for `list`) override it, --project overrides the project.

describe("note task targeting", () => {
	it("add: --project overrides context, --task overrides context, and --task / --task-id work without context", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleNote("add", args(["test"], { project: "other-proj" }), SOCKET, CTX);
		expect(lastParams()).toMatchObject({ taskId: CTX.taskId, projectId: "other-proj" });

		await handleNote("add", args(["cross-task note"], { task: "different-id" }), SOCKET, CTX);
		expect(lastParams().taskId).toBe("different-id");

		await handleNote("add", args(["test"], { task: "bbbbbbbb", project: "proj-001" }), SOCKET, null);
		expect(lastParams().taskId).toBe("bbbbbbbb");

		await handleNote("add", args(["test"], { "task-id": "cccccccc", project: "proj-001" }), SOCKET, null);
		expect(lastParams().taskId).toBe("cccccccc");
	});

	it("list: a positional, --task-id or --task picks the task, and --project overrides context", async () => {
		mockSend.mockResolvedValue(okResp([]));

		await handleNote("list", args(["bbbbbbbb"]), SOCKET, null);
		expect(lastParams().taskId).toBe("bbbbbbbb");

		await handleNote("list", args([], { "task-id": "cccccccc" }), SOCKET, null);
		expect(lastParams().taskId).toBe("cccccccc");

		await handleNote("list", args([], { task: "different-id" }), SOCKET, CTX);
		expect(lastParams().taskId).toBe("different-id");

		await handleNote("list", args([], { project: "other-proj" }), SOCKET, CTX);
		expect(lastParams().projectId).toBe("other-proj");
	});

	it("delete: --task / --task-id work without context, --task overrides context, and --project overrides context", async () => {
		mockSend.mockResolvedValue(okResp(DELETED));

		await handleNote("delete", args(["nnnnnnnn"], { task: "bbbbbbbb", project: "proj-001" }), SOCKET, null);
		expect(lastParams().taskId).toBe("bbbbbbbb");

		await handleNote("delete", args(["nnnnnnnn"], { "task-id": "cccccccc", project: "proj-001" }), SOCKET, null);
		expect(lastParams().taskId).toBe("cccccccc");

		await handleNote("delete", args(["nnnnnnnn"], { task: "different-id" }), SOCKET, CTX);
		expect(lastParams().taskId).toBe("different-id");

		await handleNote("delete", args(["nnnnnnnn"], { project: "other" }), SOCKET, CTX);
		expect(lastParams().projectId).toBe("other");
	});

	// Same bug as task commands: `tasks list` shows 8-char IDs, but passing a
	// short ID via --task to note commands sent it as-is to the server, which
	// can't resolve it. The CLI expands short IDs to full UUIDs.
	it("resolves an 8-char task id to the full UUID on add (--task), list (positional) and delete (--task)", async () => {
		const shortId = FAKE_TASK.id.slice(0, 8); // "aaaaaaaa"

		mockSend.mockResolvedValue(okResp(FAKE_TASK));
		await handleNote("add", args(["test note"], { task: shortId }), SOCKET, CTX);
		expect(lastParams().taskId, "add").toBe(FAKE_TASK.id);

		mockSend.mockResolvedValue(okResp([]));
		await handleNote("list", args([shortId]), SOCKET, CTX);
		expect(lastParams().taskId, "list").toBe(FAKE_TASK.id);

		mockSend.mockResolvedValue(okResp(DELETED));
		await handleNote("delete", args(["nnnnnnnn"], { task: shortId }), SOCKET, CTX);
		expect(lastParams().taskId, "delete").toBe(FAKE_TASK.id);
	});
});

// ─── note list ────────────────────────────────────────────────────────────────

describe("note list", () => {
	it("lists notes from the context task, or says there are none", async () => {
		mockSend.mockResolvedValue(okResp([FAKE_NOTE]));

		await handleNote("list", args(), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "note.list", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("nnnnnnnn");
		expect(stdoutOutput).toContain("ai");
		expect(stdoutOutput).toContain("Found a race condition");

		mockSend.mockResolvedValue(okResp([]));
		await handleNote("list", args(), SOCKET, CTX);
		expect(stdoutOutput).toContain("No notes");
	});

	it("truncates long content and replaces newlines with spaces in the table", async () => {
		mockSend.mockResolvedValue(okResp([
			{ ...FAKE_NOTE, content: "A".repeat(100) },
			{ ...FAKE_NOTE, id: "mmmmmmmm-1111", content: "Line one\nLine two\nLine three" },
		]));

		await handleNote("list", args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("…");
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

	it("errors with no note id, an unknown id, and an ambiguous prefix", async () => {
		await expect(handleNote("show", args([]), SOCKET, CTX)).rejects.toThrow(/EXIT_/);
		expect(stderrOutput).toContain("Usage: dev3 note show");

		mockSend.mockResolvedValue(okResp([MULTILINE_NOTE]));
		await expect(handleNote("show", args(["deadbeef"]), SOCKET, CTX)).rejects.toThrow(/EXIT_/);
		expect(stderrOutput).toContain("Note not found");

		const a = { ...MULTILINE_NOTE, id: "ffff0000-aaaa" };
		const b = { ...MULTILINE_NOTE, id: "ffff0000-bbbb" };
		mockSend.mockResolvedValue(okResp([a, b]));
		await expect(handleNote("show", args(["ffff0000"]), SOCKET, CTX)).rejects.toThrow(/EXIT_/);
		expect(stderrOutput).toContain("Ambiguous note id");
	});
});

// ─── note delete ──────────────────────────────────────────────────────────────

describe("note delete", () => {
	it("deletes a note by ID from the context task", async () => {
		mockSend.mockResolvedValue(okResp(DELETED));

		await handleNote("delete", args(["nnnnnnnn"]), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "note.delete", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
			noteId: "nnnnnnnn",
		});
		expect(stdoutOutput).toContain("Deleted note");
		expect(stdoutOutput).toContain("nnnnnnnn");
	});
});

// ─── errors shared by every subcommand ───────────────────────────────────────

describe("note errors", () => {
	it("exits 3 with no task and no context, no note id, an unknown flag, or a missing/unknown subcommand", async () => {
		const cases: Array<[string, string | undefined, ParsedArgs, CliContext | null, string?]> = [
			["add without a task", "add", args(["content"]), null],
			["list without a task", "list", args(), null],
			["delete without a task", "delete", args(["nnnnnnnn"]), null],
			["delete without a note id", "delete", args(), CTX, "Usage:"],
			// An unknown flag must not fall back to context.
			["unknown flag", "add", args(["note"], { taskk: "bbbbbbbb" }), CTX, "Unknown option: --taskk"],
			["unknown subcommand", "edit", args(), null, "Unknown subcommand"],
			["no subcommand", undefined, args(), null],
		];
		for (const [name, sub, parsed, context, message] of cases) {
			stderrOutput = "";
			await expect(handleNote(sub, parsed, SOCKET, context), name).rejects.toThrow("EXIT_3");
			if (message) expect(stderrOutput, name).toContain(message);
		}
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("exits 1 with the server's error on add, list and delete", async () => {
		const cases: Array<[string, ParsedArgs, string]> = [
			["add", args(["test"]), "Task not found"],
			["list", args(), "Task not found"],
			["delete", args(["badid"]), "Note not found"],
		];
		for (const [sub, parsed, error] of cases) {
			stderrOutput = "";
			mockSend.mockResolvedValue(errResp(error));
			await expect(handleNote(sub, parsed, SOCKET, CTX), sub).rejects.toThrow("EXIT_1");
			expect(stderrOutput, sub).toContain(error);
		}
	});
});
