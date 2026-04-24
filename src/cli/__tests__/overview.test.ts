import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleOverview } from "../commands/overview";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
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

const FAKE_TASK: Task = {
	id: "aaaaaaaa-1111-2222-3333-444444444444",
	seq: 42,
	projectId: "proj-001",
	title: "Fix the login bug",
	description: "Users report 500 on login",
	overview: "Login flow returns 500 after cookie refresh; root cause traced to JWT expiry handling.",
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

// ─── overview set ────────────────────────────────────────────────────────────

describe("overview set", () => {
	it("sets overview with positional text", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleOverview("set", args(["Short summary of the task"]), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "overview.set", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
			overview: "Short summary of the task",
		});
		expect(stdoutOutput).toContain("Overview set");
		expect(stdoutOutput).toContain("aaaaaaaa");
	});

	it("trims whitespace before sending", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleOverview("set", args(["   padded summary   "]), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.overview).toBe("padded summary");
	});

	it("rejects empty overview", async () => {
		await expect(
			handleOverview("set", args([""]), SOCKET, CTX),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Usage:");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects whitespace-only overview", async () => {
		await expect(
			handleOverview("set", args(["   "]), SOCKET, CTX),
		).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects overview over 500 chars", async () => {
		const tooLong = "A".repeat(501);
		await expect(
			handleOverview("set", args([tooLong]), SOCKET, CTX),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Overview too long");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("accepts overview at exactly 500 chars", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));
		const exact = "A".repeat(500);

		await handleOverview("set", args([exact]), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalled();
	});

	it("auto-detects taskId and projectId from context", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleOverview("set", args(["summary"]), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe(CTX.taskId);
		expect(params.projectId).toBe(CTX.projectId);
	});

	it("--task flag overrides context", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleOverview("set", args(["summary"], { task: "bbbbbbbb-2222-3333-4444-555555555555" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("bbbbbbbb-2222-3333-4444-555555555555");
	});

	it("resolves 8-char --task short ID to full UUID", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		const shortId = FAKE_TASK.id.slice(0, 8);
		await handleOverview("set", args(["summary"], { task: shortId }), SOCKET, CTX);

		const sentTaskId = (mockSend.mock.calls[0]![2]! as Record<string, unknown>).taskId;
		expect(sentTaskId).toBe(FAKE_TASK.id);
	});

	it("exits when no taskId and no context", async () => {
		await expect(
			handleOverview("set", args(["summary"]), SOCKET, null),
		).rejects.toThrow("EXIT_3");
	});

	it("exits on server error", async () => {
		mockSend.mockResolvedValue(errResp("Task not found"));

		await expect(
			handleOverview("set", args(["summary"]), SOCKET, CTX),
		).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Task not found");
	});
});

// ─── overview show ───────────────────────────────────────────────────────────

describe("overview show", () => {
	it("prints overview when present", async () => {
		mockSend.mockResolvedValue(
			okResp({
				overview: "The saved summary.",
				userOverview: null,
				description: "Raw request.",
			}),
		);

		await handleOverview("show", args(), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "overview.show", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("The saved summary.");
		expect(stdoutOutput).not.toContain("no overview set");
		expect(stdoutOutput).not.toContain("user-edited");
	});

	it("prints user-edited version and hides AI version when user overrides", async () => {
		mockSend.mockResolvedValue(
			okResp({
				overview: "AI-written summary.",
				userOverview: "My hand-written version.",
				description: "Raw request.",
			}),
		);

		await handleOverview("show", args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("user-edited");
		expect(stdoutOutput).toContain("My hand-written version.");
		// AI version is surfaced so agents know their edits aren't lost
		expect(stdoutOutput).toContain("AI overview (currently hidden by user edit)");
		expect(stdoutOutput).toContain("AI-written summary.");
	});

	it("does not repeat AI section when user override equals AI overview", async () => {
		mockSend.mockResolvedValue(
			okResp({
				overview: "Same text.",
				userOverview: "Same text.",
				description: "Raw request.",
			}),
		);

		await handleOverview("show", args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("user-edited");
		expect(stdoutOutput).not.toContain("AI overview (currently hidden");
	});

	it("prints hint + description fallback when overview missing", async () => {
		mockSend.mockResolvedValue(
			okResp({
				overview: null,
				userOverview: null,
				description: "The original user request text.",
			}),
		);

		await handleOverview("show", args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("no overview set");
		expect(stdoutOutput).toContain("The original user request text.");
	});

	it("handles empty description gracefully", async () => {
		mockSend.mockResolvedValue(
			okResp({ overview: null, userOverview: null, description: "" }),
		);

		await handleOverview("show", args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("no overview set");
	});

	it("exits when no context and no --task", async () => {
		await expect(
			handleOverview("show", args(), SOCKET, null),
		).rejects.toThrow("EXIT_3");
	});

	it("exits on server error", async () => {
		mockSend.mockResolvedValue(errResp("Task not found"));

		await expect(
			handleOverview("show", args(), SOCKET, CTX),
		).rejects.toThrow("EXIT_1");
	});
});

// ─── overview clear ──────────────────────────────────────────────────────────

describe("overview clear", () => {
	it("clears overview", async () => {
		mockSend.mockResolvedValue(okResp({ ...FAKE_TASK, overview: null }));

		await handleOverview("clear", args(), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "overview.clear", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("Overview cleared");
		expect(stdoutOutput).toContain("aaaaaaaa");
	});

	it("exits when no context and no --task", async () => {
		await expect(
			handleOverview("clear", args(), SOCKET, null),
		).rejects.toThrow("EXIT_3");
	});

	it("exits on server error", async () => {
		mockSend.mockResolvedValue(errResp("Task not found"));

		await expect(
			handleOverview("clear", args(), SOCKET, CTX),
		).rejects.toThrow("EXIT_1");
	});
});

// ─── unknown subcommand ──────────────────────────────────────────────────────

describe("overview (unknown subcommand)", () => {
	it("exits with usage error for unknown subcommand", async () => {
		await expect(
			handleOverview("edit", args(), SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Unknown subcommand");
	});

	it("exits with usage error when no subcommand", async () => {
		await expect(
			handleOverview(undefined, args(), SOCKET, null),
		).rejects.toThrow("EXIT_3");
	});
});
