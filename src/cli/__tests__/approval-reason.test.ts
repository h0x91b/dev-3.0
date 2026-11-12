/**
 * `--reason`: every approval-gated command forwards it to the app, and the
 * CLI refuses a reason the dialog could not show whole.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTask } from "../commands/task";
import { handleAgent } from "../commands/agent";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";
import { CLI_EXIT_CODE_USAGE_ERROR } from "../../shared/cli-exit-codes";
import { APPROVAL_REASON_MAX_LENGTH } from "../../shared/approval-reason";

vi.mock("../stdin", () => ({ readStdin: vi.fn() }));
vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
vi.mock("../launch-approval", () => ({
	launchApprovalTimeoutMs: vi.fn(async () => 600_000),
	launchAndPrepareTimeoutMs: vi.fn(async () => 600_000),
	withWaitHeartbeat: <T>(wait: Promise<T>) => wait,
}));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

const SOCKET = "/tmp/test.sock";
const OWN_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const OTHER_ID = "bbbbbbbb-1111-2222-3333-444444444444";
const CTX: CliContext = { projectId: "proj-001", taskId: OWN_ID, socketPath: SOCKET };
const REASON = "Moving it off the Claude account that hit its weekly limit.";
const USAGE_EXIT = `EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`;

function ok(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function args(positional: string[] = [], flags: Record<string, string> = {}): ParsedArgs {
	return { positional, flags };
}

async function exitCode(run: Promise<void>): Promise<string> {
	return run.then(() => "EXIT_0", (err: Error) => err.message);
}

function paramsOf(method: string): Record<string, unknown> | undefined {
	return mockSend.mock.calls.find((call) => call[1] === method)?.[2] as Record<string, unknown> | undefined;
}

let spies: Array<{ mockRestore: () => void }>;

beforeEach(() => {
	spies = [
		vi.spyOn(process.stdout, "write").mockImplementation(() => true),
		vi.spyOn(process.stderr, "write").mockImplementation(() => true),
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
			throw new Error(`EXIT_${code ?? 0}`);
		}),
	];
	mockSend.mockReset();
});

afterEach(() => {
	for (const spy of spies) spy.mockRestore();
});

describe("--reason on approval-gated commands", () => {
	it("task hibernate forwards the reason", async () => {
		mockSend.mockResolvedValue(ok({ outcome: "hibernated", taskId: OTHER_ID, seq: 12, freedRssBytes: null }));
		await handleTask("hibernate", args([OTHER_ID], { reason: `  ${REASON}  ` }), SOCKET, CTX);
		expect(paramsOf("task.hibernate")).toEqual({ taskId: OTHER_ID, projectId: "proj-001", sourceTaskId: OWN_ID, reason: REASON });
	});

	it("task wake forwards the reason", async () => {
		mockSend.mockResolvedValue(ok({ outcome: "woke-shell", taskId: OTHER_ID, seq: 12, backend: "tmux" }));
		await handleTask("wake", args([OTHER_ID], { shell: "true", reason: REASON }), SOCKET, CTX);
		expect(paramsOf("task.wake")).toMatchObject({ taskId: OTHER_ID, mode: "shell", reason: REASON });
	});

	it("completing another task sends the reason and names the asking task", async () => {
		mockSend.mockResolvedValue(ok({ approved: true, task: { id: OTHER_ID, status: "completed" } }));
		await handleTask("move", args([OTHER_ID], { status: "completed", reason: REASON }), SOCKET, CTX);
		expect(paramsOf("task.requestCompletion")).toEqual({ taskId: OTHER_ID, projectId: "proj-001", reason: REASON, sourceTaskId: OWN_ID });
	});

	it("a completion without a reason sends exactly what it did before", async () => {
		mockSend.mockResolvedValue(ok({ approved: true, task: { id: OTHER_ID, status: "completed" } }));
		await handleTask("move", args([OTHER_ID], { status: "completed" }), SOCKET, CTX);
		expect(paramsOf("task.requestCompletion")).toEqual({ taskId: OTHER_ID, projectId: "proj-001" });
	});

	it.each(["cancelled", "todo"])("--status %s forwards the reason", async (status) => {
		mockSend.mockResolvedValue(ok({ approved: true, task: { id: OTHER_ID, status } }));
		await handleTask("move", args([OTHER_ID], { status, reason: REASON }), SOCKET, CTX);
		const method = status === "cancelled" ? "task.requestCancellation" : "task.requestReset";
		expect(paramsOf(method)).toMatchObject({ reason: REASON, sourceTaskId: OWN_ID });
	});

	it("starting another task forwards the reason with the launch", async () => {
		mockSend.mockResolvedValue(ok({ approved: false }));
		await exitCode(handleTask("move", args([OTHER_ID], { status: "in-progress", reason: REASON }), SOCKET, CTX));
		expect(paramsOf("task.move")).toMatchObject({ taskId: OTHER_ID, newStatus: "in-progress", sourceTaskId: OWN_ID, reason: REASON });
	});

	it("task create --scratch --run forwards the reason", async () => {
		mockSend.mockResolvedValue(ok({ approved: false }));
		await exitCode(handleTask("create", args([], { scratch: "true", run: "true", reason: REASON }), SOCKET, CTX));
		expect(paramsOf("task.createScratchAndRun")).toMatchObject({ sourceTaskId: OWN_ID, reason: REASON });
	});

	it("refuses --reason on a plain task create", async () => {
		expect(await exitCode(handleTask("create", args(["Some title"], { reason: REASON }), SOCKET, CTX))).toBe(USAGE_EXIT);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("agent spawn and agent resume forward the reason", async () => {
		mockSend.mockResolvedValue(ok({ approved: false }));
		await exitCode(handleAgent("spawn", args([], { task: OTHER_ID, reason: REASON }), SOCKET, CTX));
		expect(paramsOf("agent.spawn")).toMatchObject({ taskId: OTHER_ID, reason: REASON });
		mockSend.mockResolvedValue(ok({ outcome: "declined", taskId: OTHER_ID, seq: 12 }));
		await exitCode(handleAgent("resume", args([], { task: OTHER_ID, reason: REASON }), SOCKET, CTX));
		expect(paramsOf("agent.resume")).toMatchObject({ taskId: OTHER_ID, reason: REASON });
	});

	it.each([
		["valueless", "true"],
		["blank", "   "],
		["over the cap", "x".repeat(APPROVAL_REASON_MAX_LENGTH + 1)],
	])("refuses a %s reason before asking the app", async (_label, reason) => {
		expect(await exitCode(handleTask("hibernate", args([OTHER_ID], { reason }), SOCKET, CTX))).toBe(USAGE_EXIT);
		expect(await exitCode(handleTask("move", args([OTHER_ID], { status: "completed", reason }), SOCKET, CTX))).toBe(USAGE_EXIT);
		expect(mockSend).not.toHaveBeenCalled();
	});
});
