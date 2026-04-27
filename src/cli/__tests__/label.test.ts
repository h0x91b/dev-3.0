import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleLabel } from "../commands/label";
import type { ParsedArgs } from "../args";
import type { CliContext } from "../context";
import type { CliResponse, Task } from "../../shared/types";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

let stderrOutput: string;

const SOCKET = "/tmp/test.sock";

const CTX: CliContext = {
	projectId: "proj-001",
	taskId: "aaaaaaaa-1111-2222-3333-444444444444",
	socketPath: SOCKET,
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
	labelIds: ["lbl-1"],
	createdAt: "2026-03-01T10:00:00Z",
	updatedAt: "2026-03-01T12:00:00Z",
};

function args(positional: string[] = [], flags: Record<string, string> = {}): ParsedArgs {
	return { positional, flags };
}

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

beforeEach(() => {
	stderrOutput = "";
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderrOutput += String(chunk);
		return true;
	});
	vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => {
		throw new Error(`EXIT_${_code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("label set task targeting", () => {
	it("uses --task-id flag as an explicit task target", async () => {
		mockSend.mockResolvedValue(okResp(FAKE_TASK));

		await handleLabel("set", args(["lbl-1"], { "task-id": "bbbbbbbb", project: "proj-001" }), SOCKET, null);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBe("bbbbbbbb");
	});

	it("rejects unknown flags instead of falling back to context", async () => {
		await expect(
			handleLabel("set", args(["lbl-1"], { taskk: "bbbbbbbb" }), SOCKET, CTX),
		).rejects.toThrow("EXIT_3");

		expect(stderrOutput).toContain("Unknown option");
		expect(stderrOutput).toContain("--taskk");
		expect(mockSend).not.toHaveBeenCalled();
	});
});
