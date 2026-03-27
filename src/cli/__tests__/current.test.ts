import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task, CliResponse } from "../../shared/types";

// Mock all external dependencies
vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

vi.mock("../context", () => ({
	detectContext: vi.fn(),
	detectContextDiagnostics: vi.fn(() => "mock diagnostics"),
	readProjectDirect: vi.fn(),
	readTaskDirect: vi.fn(),
}));

vi.mock("../../shared/build-info.generated", () => ({
	BUILD_TIME: "Sat, 28 Mar 2026 · 00:00:00",
	BUILD_COMMIT: "deadbeef",
	BUILD_VERSION: "test",
}));

import { handleCurrent } from "../commands/current";
import { sendRequest } from "../socket-client";
import { detectContext, readProjectDirect, readTaskDirect } from "../context";

const mockSend = vi.mocked(sendRequest);
const mockDetect = vi.mocked(detectContext);
const mockReadProject = vi.mocked(readProjectDirect);
const mockReadTask = vi.mocked(readTaskDirect);

let stdoutOutput: string;
let stderrOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const SOCKET = "/tmp/test.sock";

const FAKE_TASK: Task = {
	id: "aaaaaaaa-1111-2222-3333-444444444444",
	seq: 7,
	projectId: "proj-001",
	title: "Implement auth",
	description: "Add JWT auth to the API endpoints",
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

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
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
	mockDetect.mockReset();
	mockReadProject.mockReset();
	mockReadTask.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

describe("handleCurrent", () => {
	it("exits with error when not in a worktree", async () => {
		mockDetect.mockReturnValue(null);

		await expect(handleCurrent(SOCKET)).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("not inside a dev3 worktree");
	});

	// ─── Online mode (socket available) ──────────────────────────────────────

	describe("online mode", () => {
		it("fetches live data via socket and prints task details", async () => {
			mockDetect.mockReturnValue({
				projectId: "proj-001",
				taskId: "aaaaaaaa-1111-2222-3333-444444444444",
				socketPath: SOCKET,
			});
			mockSend.mockResolvedValue(okResp(FAKE_TASK));
			mockReadProject.mockReturnValue({ id: "proj-001", name: "My Project", path: "/dev/proj" });

			await handleCurrent(SOCKET);

			expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.show", {
				taskId: "aaaaaaaa-1111-2222-3333-444444444444",
				projectId: "proj-001",
			});
			expect(stdoutOutput).toContain("My Project");
			expect(stdoutOutput).toContain("Implement auth");
			expect(stdoutOutput).toContain("Agent is Working");
			expect(stdoutOutput).toContain("dev3/task-aaaaaaaa");
		});

		it("shows custom title from live task data when present", async () => {
			mockDetect.mockReturnValue({
				projectId: "proj-001",
				taskId: FAKE_TASK.id,
				socketPath: SOCKET,
			});
			mockSend.mockResolvedValue(okResp({
				...FAKE_TASK,
				customTitle: "Test 1",
			}));
			mockReadProject.mockReturnValue({ id: "proj-001", name: "My Project", path: "/dev/proj" });

			await handleCurrent(SOCKET);

			expect(stdoutOutput).toContain("Test 1");
			expect(stdoutOutput).not.toContain("Implement auth");
		});

		it("shows description when different from title", async () => {
			mockDetect.mockReturnValue({
				projectId: "proj-001",
				taskId: FAKE_TASK.id,
				socketPath: SOCKET,
			});
			mockSend.mockResolvedValue(okResp(FAKE_TASK));
			mockReadProject.mockReturnValue(null);

			await handleCurrent(SOCKET);

			expect(stdoutOutput).toContain("Description:");
			expect(stdoutOutput).toContain("Add JWT auth");
		});

		it("uses short project ID when project not found in files", async () => {
			mockDetect.mockReturnValue({
				projectId: "proj-001",
				taskId: FAKE_TASK.id,
				socketPath: SOCKET,
			});
			mockSend.mockResolvedValue(okResp(FAKE_TASK));
			mockReadProject.mockReturnValue(null);

			await handleCurrent(SOCKET);

			expect(stdoutOutput).toContain("proj-001");
		});

		it("falls back to offline mode when socket request fails", async () => {
			mockDetect.mockReturnValue({
				projectId: "proj-001",
				taskId: FAKE_TASK.id,
				socketPath: SOCKET,
			});
			mockSend.mockRejectedValue(new Error("Connection refused"));
			mockReadProject.mockReturnValue({ id: "proj-001", name: "My Project", path: "/dev/proj" });
			mockReadTask.mockReturnValue({
				id: FAKE_TASK.id,
				title: "Implement auth",
				status: "in-progress",
				seq: 7,
			});

			await handleCurrent(SOCKET);

			expect(stdoutOutput).toContain("(offline)");
			expect(stdoutOutput).toContain("Implement auth");
		});

		it("falls back to offline mode when server returns error", async () => {
			mockDetect.mockReturnValue({
				projectId: "proj-001",
				taskId: FAKE_TASK.id,
				socketPath: SOCKET,
			});
			mockSend.mockResolvedValue({ id: "test", ok: false, error: "not found" });
			mockReadProject.mockReturnValue(null);
			mockReadTask.mockReturnValue(null);

			await handleCurrent(SOCKET);

			// Should not crash, just show offline with minimal info
			expect(stdoutOutput).toContain("(offline)");
		});
	});

	// ─── Offline mode (no socket) ────────────────────────────────────────────

	describe("offline mode", () => {
		it("reads data files directly when no socket", async () => {
			mockDetect.mockReturnValue({
				projectId: "proj-001",
				taskId: FAKE_TASK.id,
				socketPath: "",
			});
			mockReadProject.mockReturnValue({ id: "proj-001", name: "My Project", path: "/dev/proj" });
			mockReadTask.mockReturnValue({
				id: FAKE_TASK.id,
				seq: 7,
				title: "Implement auth",
				status: "in-progress",
				branchName: "dev3/task-aaaaaaaa",
				worktreePath: "/tmp/wt",
			});

			await handleCurrent(null);

			expect(stdoutOutput).toContain("My Project");
			expect(stdoutOutput).toContain("Implement auth");
			expect(stdoutOutput).toContain("Agent is Working");
			expect(stdoutOutput).toContain("(offline)");
			// Should NOT call sendRequest
			expect(mockSend).not.toHaveBeenCalled();
		});

		it("shows custom title from offline task data when present", async () => {
			mockDetect.mockReturnValue({
				projectId: "proj-001",
				taskId: FAKE_TASK.id,
				socketPath: "",
			});
			mockReadProject.mockReturnValue({ id: "proj-001", name: "My Project", path: "/dev/proj" });
			mockReadTask.mockReturnValue({
				...FAKE_TASK,
				customTitle: "Test 1",
			});

			await handleCurrent(null);

			expect(stdoutOutput).toContain("Test 1");
			expect(stdoutOutput).not.toContain("Implement auth");
		});

		it("shows minimal info when task data not available offline", async () => {
			mockDetect.mockReturnValue({
				projectId: "proj-001",
				taskId: "missing-task-id",
				socketPath: "",
			});
			mockReadProject.mockReturnValue(null);
			mockReadTask.mockReturnValue(null);

			await handleCurrent(null);

			expect(stdoutOutput).toContain("proj-001");
			expect(stdoutOutput).toContain("missing-task-id");
			expect(stdoutOutput).toContain("(offline)");
		});

		it("shows description in offline mode when available", async () => {
			mockDetect.mockReturnValue({
				projectId: "proj-001",
				taskId: FAKE_TASK.id,
				socketPath: "",
			});
			mockReadProject.mockReturnValue(null);
			mockReadTask.mockReturnValue({
				id: FAKE_TASK.id,
				title: "Auth task",
				description: "This is a longer description of the auth task",
				status: "todo",
			});

			await handleCurrent(null);

			expect(stdoutOutput).toContain("Description:");
			expect(stdoutOutput).toContain("longer description");
		});
	});
});
