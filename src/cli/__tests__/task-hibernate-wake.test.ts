/**
 * `dev3 task hibernate` / `dev3 task wake`: who asks decides whether the app
 * shows a dialog (sourceTaskId), and every refusal has its own exit code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTask } from "../commands/task";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";
import { CLI_EXIT_CODE_HIBERNATE_DECLINED, CLI_EXIT_CODE_HIBERNATE_NOTHING_TO_FREE, CLI_EXIT_CODE_LAUNCH_DECLINED, CLI_EXIT_CODE_RESUME_ALREADY_RUNNING, CLI_EXIT_CODE_TASK_NOT_HIBERNATED, CLI_EXIT_CODE_USAGE_ERROR } from "../../shared/cli-exit-codes";

vi.mock("../stdin", () => ({ readStdin: vi.fn() }));
vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
vi.mock("../launch-approval", () => ({ launchApprovalTimeoutMs: vi.fn(async () => 600_000) }));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

const SOCKET = "/tmp/test.sock";
const OWN_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const OTHER_ID = "bbbbbbbb-1111-2222-3333-444444444444";
const CTX: CliContext = { projectId: "proj-001", taskId: OWN_ID, socketPath: SOCKET };

let stdoutOutput: string;
let stderrOutput: string;
let spies: Array<{ mockRestore: () => void }>;

function ok(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function args(positional: string[] = [], flags: Record<string, string> = {}): ParsedArgs {
	return { positional, flags };
}

async function exitCode(run: Promise<void>): Promise<string> {
	return run.then(() => "EXIT_0", (err: Error) => err.message);
}

beforeEach(() => {
	stdoutOutput = "";
	stderrOutput = "";
	spies = [
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdoutOutput += String(chunk);
			return true;
		}),
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderrOutput += String(chunk);
			return true;
		}),
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
			throw new Error(`EXIT_${code ?? 0}`);
		}),
	];
	mockSend.mockReset();
});

afterEach(() => {
	for (const spy of spies) spy.mockRestore();
});

describe("task hibernate", () => {
	it("hibernates directly outside any worktree, sending no requester", async () => {
		mockSend.mockResolvedValue(ok({ outcome: "hibernated", taskId: OTHER_ID, seq: 12, freedRssBytes: 300 * 1024 * 1024 }));
		await handleTask("hibernate", args([OTHER_ID]), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.hibernate", { taskId: OTHER_ID }, { timeoutMs: 600_000 });
		expect(stdoutOutput).toContain("Hibernated task #12, about 300 MB freed");
	});

	it("names the asking task from a worktree, and warns when it is this session", async () => {
		mockSend.mockResolvedValue(ok({ outcome: "hibernated", taskId: OWN_ID, seq: 3, freedRssBytes: null }));
		await handleTask("hibernate", args(), SOCKET, CTX);
		expect(mockSend.mock.calls[0][2]).toEqual({ taskId: OWN_ID, projectId: "proj-001", sourceTaskId: OWN_ID });
		expect(stderrOutput).toContain("THIS task");
	});

	it("exits with its own code when there is nothing to free", async () => {
		mockSend.mockResolvedValue(ok({ outcome: "nothing-to-free", taskId: OTHER_ID, seq: 12, reason: "already-hibernated", message: "The task is already hibernated." }));
		expect(await exitCode(handleTask("hibernate", args([OTHER_ID]), SOCKET, CTX))).toBe(`EXIT_${CLI_EXIT_CODE_HIBERNATE_NOTHING_TO_FREE}`);
		expect(stderrOutput).toContain("already hibernated");
	});

	it("exits with its own code when the user declines", async () => {
		mockSend.mockResolvedValue(ok({ outcome: "declined", taskId: OTHER_ID, seq: 12 }));
		expect(await exitCode(handleTask("hibernate", args([OTHER_ID]), SOCKET, CTX))).toBe(`EXIT_${CLI_EXIT_CODE_HIBERNATE_DECLINED}`);
		expect(stderrOutput).toContain("Nothing was stopped");
	});

	// `--json seq:12` parses as json="seq:12" with NO positional left, which
	// would fall back to the worktree's own task and kill THIS session.
	it("refuses a valueless flag that swallowed the id", async () => {
		expect(await exitCode(handleTask("hibernate", args([], { json: "seq:12" }), SOCKET, CTX))).toBe(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
		expect(stderrOutput).toContain("--json takes no value");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("prints the outcome as JSON with --json", async () => {
		const outcome = { outcome: "hibernated", taskId: OTHER_ID, seq: 12, freedRssBytes: null };
		mockSend.mockResolvedValue(ok(outcome));
		await handleTask("hibernate", args([OTHER_ID], { json: "true" }), SOCKET, null);
		expect(JSON.parse(stdoutOutput)).toEqual(outcome);
	});
});

describe("task wake", () => {
	it("requires exactly one of --resume or --shell", async () => {
		expect(await exitCode(handleTask("wake", args([OTHER_ID]), SOCKET, null))).toBe(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
		expect(await exitCode(handleTask("wake", args([OTHER_ID], { resume: "true", shell: "true" }), SOCKET, null))).toBe(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
		expect(await exitCode(handleTask("wake", args([OTHER_ID], { shell: "true", "allow-agent-latest": "true" }), SOCKET, null))).toBe(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it.each(["resume", "shell", "allow-agent-latest", "json"])("refuses --%s when it swallowed the id", async (flag) => {
		expect(await exitCode(handleTask("wake", args([], { [flag]: "seq:12", shell: flag === "shell" ? "seq:12" : "true" }), SOCKET, CTX))).toBe(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
		expect(stderrOutput).toContain(`--${flag} takes no value`);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("wakes with a plain shell", async () => {
		mockSend.mockResolvedValue(ok({ outcome: "woke-shell", taskId: OTHER_ID, seq: 12, backend: "tmux" }));
		await handleTask("wake", args([OTHER_ID], { shell: "true" }), SOCKET, CTX);
		expect(mockSend.mock.calls[0][2]).toEqual({ taskId: OTHER_ID, projectId: "proj-001", sourceTaskId: OWN_ID, mode: "shell" });
		expect(stdoutOutput).toContain("Woke task #12 with a plain shell");
	});

	it("reports --resume exactly like dev3 agent resume", async () => {
		mockSend.mockResolvedValue(ok({ outcome: "resume", resume: { outcome: "already-running", taskId: OTHER_ID, seq: 12, backend: "tmux" } }));
		expect(await exitCode(handleTask("wake", args([OTHER_ID], { resume: "true" }), SOCKET, null))).toBe(`EXIT_${CLI_EXIT_CODE_RESUME_ALREADY_RUNNING}`);
		expect(mockSend.mock.calls[0][2]).toEqual({ taskId: OTHER_ID, mode: "resume", allowAgentLatest: false });
	});

	it("exits with its own code for a task that is not hibernated", async () => {
		mockSend.mockResolvedValue(ok({ outcome: "not-hibernated", taskId: OTHER_ID, seq: 12 }));
		expect(await exitCode(handleTask("wake", args([OTHER_ID], { shell: "true" }), SOCKET, null))).toBe(`EXIT_${CLI_EXIT_CODE_TASK_NOT_HIBERNATED}`);
	});

	it("exits like a declined launch when the user declines a shell wake", async () => {
		mockSend.mockResolvedValue(ok({ outcome: "declined", taskId: OTHER_ID, seq: 12 }));
		expect(await exitCode(handleTask("wake", args([OTHER_ID], { shell: "true" }), SOCKET, CTX))).toBe(`EXIT_${CLI_EXIT_CODE_LAUNCH_DECLINED}`);
	});
});
