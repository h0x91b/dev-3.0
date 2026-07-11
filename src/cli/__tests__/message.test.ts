import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleMessage } from "../commands/message";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";

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

describe("message — immediate (bare form)", () => {
	it("sends immediately with the in-context task attached", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, taskId: CTX.taskId, projectId: CTX.projectId }));
		await handleMessage(args(["continue please"]), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "message.send", {
			taskId: CTX.taskId,
			text: "continue please",
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("Message sent");
	});

	it("reports a delivery failure as a command error", async () => {
		mockSend.mockResolvedValue(errResp("no live agent"));
		await expect(handleMessage(args(["hi"]), SOCKET, CTX)).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("no live agent");
	});
});

describe("message — scheduled", () => {
	it("schedules with --in and computes a future ISO time", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: CTX.taskId, pending: 1 }));
		await handleMessage(args(["later thing"], { in: "30m" }), SOCKET, CTX);
		const [, method, params] = mockSend.mock.calls[0]!;
		expect(method).toBe("message.schedule");
		expect(params!.text).toBe("later thing");
		expect(new Date(params!.at as string).getTime()).toBeGreaterThan(Date.now());
		expect(stdoutOutput).toContain("Message scheduled");
	});

	it("schedules with --at a wall-clock time", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: CTX.taskId, pending: 1 }));
		await handleMessage(args(["at thing"], { at: "23:59" }), SOCKET, CTX);
		const [, method, params] = mockSend.mock.calls[0]!;
		expect(method).toBe("message.schedule");
		expect(typeof params!.at).toBe("string");
	});

	it("rejects both --in and --at", async () => {
		await expect(handleMessage(args(["x"], { in: "30m", at: "14:00" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toMatch(/either --in or --at/i);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects an invalid --in duration", async () => {
		await expect(handleMessage(args(["x"], { in: "soon" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toMatch(/invalid --in/i);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects an invalid --at time", async () => {
		await expect(handleMessage(args(["x"], { at: "99:99" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toMatch(/invalid --at/i);
		expect(mockSend).not.toHaveBeenCalled();
	});
});

describe("message — validation", () => {
	it("rejects empty text", async () => {
		await expect(handleMessage(args([]), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects when no task is in context", async () => {
		const ctxNoTask = { projectId: null, taskId: null, socketPath: SOCKET } as unknown as CliContext;
		await expect(handleMessage(args(["x"]), SOCKET, ctxNoTask)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toMatch(/no task in context/i);
		expect(mockSend).not.toHaveBeenCalled();
	});
});
