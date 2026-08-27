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
/** Every call needs a subject now, so the helper supplies one unless a test overrides it. */
const SUBJECT = "test subject";
function args(positional: string[] = [], flags: Record<string, string> = {}): ParsedArgs {
	return { positional, flags: { subject: SUBJECT, ...flags } };
}
/** Verbatim flags — for the tests that are ABOUT the subject being absent or wrong. */
function rawArgs(positional: string[] = [], flags: Record<string, string> = {}): ParsedArgs {
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
			subject: SUBJECT,
			projectId: CTX.projectId,
			sourceTaskId: CTX.taskId,
		});
		expect(stdoutOutput).toContain("Message queued");
	});

	it("says the whole message is held, not that the agent is reading it now", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, taskId: CTX.taskId, projectId: CTX.projectId }));
		await handleMessage(args(["continue please"]), SOCKET, CTX);
		expect(stdoutOutput).toContain("15s of quiet");
		// The human window is its own, longer number — a sender that expects 15s while
		// the user is typing would chase a peer that is not late at all.
		expect(stdoutOutput).toContain("60s if the user has been typing");
		expect(stdoutOutput).not.toContain("Message sent");
	});

	it("attaches the worktree task as the sender when messaging another task", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, taskId: "other", projectId: CTX.projectId }));
		await handleMessage(args(["ping"], { task: "seq:42" }), SOCKET, CTX);
		const [, , params] = mockSend.mock.calls[0]!;
		expect(params!.taskId).toBe("seq:42");
		expect(params!.sourceTaskId).toBe(CTX.taskId);
	});

	it("omits the sender when there is no worktree context", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, taskId: "other", projectId: "p" }));
		await handleMessage(args(["ping"], { task: "seq:42" }), SOCKET, null);
		const [, , params] = mockSend.mock.calls[0]!;
		expect(params).not.toHaveProperty("sourceTaskId");
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

describe("message — --subject is mandatory", () => {
	// The error path IS the feature: every agent alive has the habit of sending
	// without a subject, so this is the message they will actually meet.
	it("refuses a message with no subject, with its own exit code", async () => {
		await expect(handleMessage(rawArgs(["ping"], { task: "seq:490" }), SOCKET, CTX)).rejects.toThrow("EXIT_17");
		expect(mockSend).not.toHaveBeenCalled();
		expect(stderrOutput).toContain("dev3 message needs --subject");
	});

	it("teaches the shape: the limit, a good example, a bad one, and the corrected command", async () => {
		await expect(
			handleMessage(rawArgs(["CI is green on all four shards"], { task: "seq:490" }), SOCKET, CTX),
		).rejects.toThrow("EXIT_17");
		expect(stderrOutput).toContain("about 6 words");
		expect(stderrOutput).toContain("80 characters at most");
		expect(stderrOutput).toContain('good:  --subject "PR 1577 merged, main green"');
		expect(stderrOutput).toContain('bad:   --subject "Seq 1722 -> Coordinator: PR 1577 merged"');
		// The corrected command keeps the caller's own target flags and their text.
		expect(stderrOutput).toContain('dev3 message --task seq:490 --subject');
		expect(stderrOutput).toContain('"CI is green on all four shards"');
	});

	it("suggests a subject taken from the body, with the sender's self-address stripped", async () => {
		await expect(
			handleMessage(rawArgs(["Seq 1722 -> Coordinator: PR 1577 merged, main green"], {}), SOCKET, CTX),
		).rejects.toThrow("EXIT_17");
		expect(stderrOutput).toContain('Suggested from your own text');
		expect(stderrOutput).toContain('"PR 1577 merged, main green"');
	});

	it("does not paste a long body back into the corrected command", async () => {
		const long = "x".repeat(400);
		await expect(handleMessage(rawArgs([long], {}), SOCKET, CTX)).rejects.toThrow("EXIT_17");
		expect(stderrOutput).toContain('"<your text>"');
		expect(stderrOutput).not.toContain("x".repeat(80));
	});

	it("treats a bare --subject with no value as missing", async () => {
		await expect(handleMessage(rawArgs(["ping"], { subject: "true" }), SOCKET, CTX)).rejects.toThrow("EXIT_17");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("treats a whitespace-only subject as missing", async () => {
		await expect(handleMessage(rawArgs(["ping"], { subject: "   \t " }), SOCKET, CTX)).rejects.toThrow("EXIT_17");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects an over-limit subject instead of truncating it", async () => {
		const tooLong = "a".repeat(81);
		await expect(handleMessage(rawArgs(["ping"], { subject: tooLong }), SOCKET, CTX)).rejects.toThrow("EXIT_17");
		expect(stderrOutput).toContain("--subject is too long: 81 characters");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("accepts a subject exactly at the limit", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, taskId: CTX.taskId, projectId: CTX.projectId }));
		const exact = "a".repeat(80);
		await handleMessage(rawArgs(["ping"], { subject: exact }), SOCKET, CTX);
		expect(mockSend.mock.calls[0]?.[2]?.subject).toBe(exact);
	});

	it("collapses a multi-line subject into the one line it is", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, taskId: CTX.taskId, projectId: CTX.projectId }));
		await handleMessage(rawArgs(["ping"], { subject: "  CI green\n  on   main " }), SOCKET, CTX);
		expect(mockSend.mock.calls[0]?.[2]?.subject).toBe("CI green on main");
	});

	it("carries the subject on the scheduled form too", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: CTX.taskId, pending: 1 }));
		await handleMessage(args(["later"], { in: "30m" }), SOCKET, CTX);
		const [, method, params] = mockSend.mock.calls[0]!;
		expect(method).toBe("message.schedule");
		expect(params!.subject).toBe(SUBJECT);
	});

	it("refuses a scheduled message with no subject", async () => {
		await expect(handleMessage(rawArgs(["later"], { in: "30m" }), SOCKET, CTX)).rejects.toThrow("EXIT_17");
		expect(mockSend).not.toHaveBeenCalled();
	});
});

describe("message — --variant", () => {
	it("carries the index to the server alongside the seq ref", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: "bbbbbbbb-1111-2222-3333-444444444444" }));
		await handleMessage(args(["ping"], { task: "seq:490", variant: "1" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"message.send",
			expect.objectContaining({ taskId: "seq:490", variantIndex: 1 }),
		);
	});

	it("carries the index on the scheduled form too", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: "bbbbbbbb-1111-2222-3333-444444444444", pending: 1 }));
		await handleMessage(args(["ping"], { task: "seq:490", variant: "2", in: "30m" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"message.schedule",
			expect.objectContaining({ taskId: "seq:490", variantIndex: 2 }),
		);
	});

	it("omits the field entirely when the flag is absent", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: "bbbbbbbb-1111-2222-3333-444444444444" }));
		await handleMessage(args(["ping"], { task: "seq:490" }), SOCKET, CTX);
		expect(mockSend.mock.calls[0]?.[2]).not.toHaveProperty("variantIndex");
	});

	it("rejects --variant against a task id — it names one member already", async () => {
		await expect(
			handleMessage(args(["ping"], { task: "bbbbbbbb-1111-2222-3333-444444444444", variant: "1" }), SOCKET, CTX),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toMatch(/--task seq:<N> --variant/);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects --variant with no --task, where it would mean the worktree's own task", async () => {
		await expect(handleMessage(args(["ping"], { variant: "1" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects a bare --variant with no index", async () => {
		await expect(
			handleMessage(args(["ping"], { task: "seq:490", variant: "true" }), SOCKET, CTX),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toMatch(/--variant needs an index/);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects a non-numeric --variant", async () => {
		await expect(
			handleMessage(args(["ping"], { task: "seq:490", variant: "one" }), SOCKET, CTX),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toMatch(/Invalid --variant/);
		expect(mockSend).not.toHaveBeenCalled();
	});
});
