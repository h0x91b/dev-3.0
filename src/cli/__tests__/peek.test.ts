import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handlePeek } from "../commands/peek";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";
import type { TaskPeekSnapshot } from "../../shared/task-peek";

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
const TASK_ID = "aaaaaaaa-1111-2222-3333-444444444444";

const CTX: CliContext = { projectId: "proj-001", taskId: TASK_ID, socketPath: SOCKET };

function args(flags: Record<string, string> = {}): ParsedArgs {
	return { positional: [], flags };
}

function snapshot(extra: Partial<TaskPeekSnapshot> = {}): TaskPeekSnapshot {
	return {
		taskId: TASK_ID,
		seq: 42,
		title: "Fix auth race",
		status: "in-progress",
		backend: "tmux",
		observedAt: new Date().toISOString(),
		sessionPresent: true,
		unavailable: null,
		panes: [
			{ index: 1, paneId: "%1", label: "claude", alive: true, focused: true, lastOutputAt: new Date().toISOString(), lastOutputAgeMs: 0, granularity: "window" },
		],
		tail: { paneIndex: 1, paneId: "%1", lines: 1, text: "waiting for approval" },
		...extra,
	};
}

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
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
		throw new Error(`EXIT_${code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

describe("dev3 peek", () => {
	it("peeks at the worktree's own task when no --task is given", async () => {
		mockSend.mockResolvedValue(okResp(snapshot()));

		await handlePeek(args(), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.peek", expect.objectContaining({ taskId: TASK_ID }));
		expect(stdoutOutput).toContain("Task 42 · Fix auth race");
		expect(stdoutOutput).toContain("waiting for approval");
	});

	it("passes a seq reference through untouched", async () => {
		mockSend.mockResolvedValue(okResp(snapshot()));

		await handlePeek(args({ task: "seq:7" }), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.peek", expect.objectContaining({ taskId: "seq:7" }));
	});

	it("forwards pane and line selection", async () => {
		mockSend.mockResolvedValue(okResp(snapshot()));

		await handlePeek(args({ pane: "2", lines: "40" }), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.peek", expect.objectContaining({ pane: "2", lines: 40 }));
	});

	it("sends no pane or lines when the caller passed none", async () => {
		mockSend.mockResolvedValue(okResp(snapshot()));

		await handlePeek(args(), SOCKET, CTX);

		const params = mockSend.mock.calls[0][2] as Record<string, unknown>;
		expect(params).not.toHaveProperty("pane");
		expect(params).not.toHaveProperty("lines");
	});

	it("emits the raw snapshot with --json", async () => {
		const snap = snapshot();
		mockSend.mockResolvedValue(okResp(snap));

		await handlePeek(args({ json: "" }), SOCKET, CTX);

		expect(JSON.parse(stdoutOutput)).toEqual(snap);
	});

	it("prints the reason and stays successful when there is no terminal session", async () => {
		mockSend.mockResolvedValue(okResp(snapshot({
			sessionPresent: false,
			unavailable: { kind: "no-session", detail: "task is hibernated" },
			panes: [],
			tail: null,
		})));

		await handlePeek(args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("no terminal session — task is hibernated");
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("rejects a --lines value outside the supported range", async () => {
		await expect(handlePeek(args({ lines: "5000" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--lines must be a whole number from 1 to 1000");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects a non-numeric --lines value", async () => {
		await expect(handlePeek(args({ lines: "lots" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects an empty --pane value", async () => {
		await expect(handlePeek(args({ pane: "" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects unknown flags", async () => {
		await expect(handlePeek(args({ follow: "" }), SOCKET, CTX)).rejects.toThrow(/EXIT_3/);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("asks for --task when there is no task in context", async () => {
		await expect(handlePeek(args(), SOCKET, null)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("No task in context");
	});

	it("lets the app-not-running failure through so the CLI can exit 2", async () => {
		// `main.ts` maps this to CLI_EXIT_CODE_APP_NOT_RUNNING; the command must not
		// swallow it and print a peek-shaped answer instead.
		mockSend.mockRejectedValue(new Error("APP_NOT_RUNNING"));

		await expect(handlePeek(args(), SOCKET, CTX)).rejects.toThrow("APP_NOT_RUNNING");
		expect(stdoutOutput).toBe("");
	});

	it("looks across projects by default so a peer in another project resolves", async () => {
		mockSend.mockResolvedValue(okResp(snapshot()));

		await handlePeek(args({ task: "seq:7" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0][2] as Record<string, unknown>;
		expect(params).not.toHaveProperty("projectId");
	});

	it("scopes the lookup only when --project is explicit", async () => {
		mockSend.mockResolvedValue(okResp(snapshot()));

		await handlePeek(args({ task: "seq:7", project: "proj-001" }), SOCKET, CTX);

		expect(mockSend.mock.calls[0][2]).toMatchObject({ projectId: "proj-001" });
	});

	it("fails with the server's message when the task cannot be resolved", async () => {
		mockSend.mockResolvedValue({ id: "test-id", ok: false, error: "Task not found: seq:99" });

		await expect(handlePeek(args({ task: "seq:99" }), SOCKET, CTX)).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Task not found: seq:99");
	});
});
