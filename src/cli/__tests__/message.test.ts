import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleMessage, unreachableAppVerdict } from "../commands/message";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";
import { encodeAgentHandle } from "../../shared/agent-handle";

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
	mockReadStdin.mockReset();
	// The suite may itself run inside a tmux pane; only the tests about panes set one.
	vi.stubEnv("TMUX_PANE", "");
	vi.stubEnv("DEV3_PANE_ID", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
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

	it("hands the app its own pane and pid on the immediate form too, so a reply can find this agent", async () => {
		vi.stubEnv("TMUX_PANE", "%3");
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "held", taskId: "other", projectId: CTX.projectId }));
		await handleMessage(args(["ping"], { task: "seq:42" }), SOCKET, CTX);
		expect(mockSend.mock.calls[0]![2]).toMatchObject({ sourceTaskId: CTX.taskId, sourcePaneId: "%3", sourcePid: process.pid });
	});

	it("names the agent and pane it went to", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "held", taskId: CTX.taskId, paneId: "%3", agentRole: "review" }));
		await handleMessage(args(["ping"]), SOCKET, CTX);
		expect(stdoutOutput).toContain("Message queued for task aaaaaaaa (AI Review agent, pane %3).");
	});

	it("says plainly when the receiver gets no way to reply to this agent", async () => {
		mockSend.mockResolvedValue(okResp({
			delivered: true, status: "held", taskId: "other", replyUnavailable: "agent identity cannot be verified on Windows yet",
		}));
		await handleMessage(args(["ping"], { task: "seq:42" }), SOCKET, CTX);
		expect(stderrOutput).toContain(
			"Replies to you are not available (agent identity cannot be verified on Windows yet): the message carries no reply command.",
		);
		expect(stdoutOutput).toContain("Message queued");
	});

	it("prints no reply notice when the sender was proven", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "held", taskId: "other" }));
		await handleMessage(args(["ping"], { task: "seq:42" }), SOCKET, CTX);
		expect(stderrOutput).not.toContain("Replies to you");
	});
});

describe("message — --agent addresses one agent of the task", () => {
	const HANDLE = encodeAgentHandle({ paneId: "%3", sessionId: null, paneToken: "gen-1", agentProcess: "303@Mon Oct 26 09:00:00 2026" });

	it("sends the handle along on both forms", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "held", taskId: "other", pending: 1 }));
		await handleMessage(args(["review it"], { task: "seq:42", agent: HANDLE }), SOCKET, CTX);
		expect(mockSend.mock.calls[0]![2]).toMatchObject({ taskId: "seq:42", agentHandle: HANDLE });
		await handleMessage(args(["review it"], { task: "seq:42", agent: HANDLE, in: "30m" }), SOCKET, CTX);
		expect(mockSend.mock.calls[1]![1]).toBe("message.schedule");
		expect(mockSend.mock.calls[1]![2]).toMatchObject({ agentHandle: HANDLE });
	});

	it("refuses a raw pane id or a bare flag, sending nothing", async () => {
		for (const agent of ["%3", "true"]) {
			stderrOutput = "";
			await expect(handleMessage(args(["review it"], { task: "seq:42", agent }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
			expect(stderrOutput).toContain("dev3 pane list --task <id>");
		}
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("refuses on Windows instead of falling back to the task", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			await expect(handleMessage(args(["review it"], { task: "seq:42", agent: HANDLE }), SOCKET, CTX)).rejects.toThrow("EXIT_1");
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
		expect(stderrOutput).toContain("--agent is not available on Windows yet");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("keeps --agent in the corrected command a missing subject prints", async () => {
		await expect(handleMessage(rawArgs(["review it"], { task: "seq:42", agent: HANDLE }), SOCKET, CTX)).rejects.toThrow();
		expect(stderrOutput).toContain(`--agent ${HANDLE}`);
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

	it("tells a scheduled sender, too, when replies cannot reach it", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: "other", pending: 1, replyUnavailable: "a shell, not an agent" }));
		await handleMessage(args(["later"], { in: "30m", task: "seq:42" }), SOCKET, CTX);
		expect(stderrOutput).toContain("Replies to you are not available (a shell, not an agent)");
	});

	it("hands the app its own tmux pane so a self-reminder can come back to this agent", async () => {
		vi.stubEnv("TMUX_PANE", "%3");
		try {
			mockSend.mockResolvedValue(okResp({ taskId: CTX.taskId, pending: 1 }));
			await handleMessage(args(["later"], { in: "30m" }), SOCKET, CTX);
			expect(mockSend.mock.calls[0]![2]).toMatchObject({ sourceTaskId: CTX.taskId, sourcePaneId: "%3", sourcePid: process.pid });
			mockSend.mockClear();
			// Outside a worktree there is no author to bind, whatever pane the shell is in.
			await handleMessage(args(["later"], { in: "30m", task: "seq:9" }), SOCKET, null);
			expect(mockSend.mock.calls[0]![2]).not.toHaveProperty("sourcePaneId");
			// A native pane names itself through DEV3_PANE_ID instead.
			vi.stubEnv("TMUX_PANE", "");
			vi.stubEnv("DEV3_PANE_ID", "pane-2");
			mockSend.mockClear();
			await handleMessage(args(["later"], { in: "30m" }), SOCKET, CTX);
			expect(mockSend.mock.calls[0]![2]).toMatchObject({ sourcePaneId: "pane-2" });
		} finally {
			vi.unstubAllEnvs();
		}
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

describe("message — text input", () => {
	it("reads the body from stdin when the text is -, byte for byte", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: CTX.taskId }));
		const body = "Rename `note.ts` addNote — keep $HOME and \"quotes\"\nПроверка 🙂";
		mockReadStdin.mockResolvedValue(`${body}\n`);

		await handleMessage(args(["-"]), SOCKET, CTX);

		expect(mockReadStdin).toHaveBeenCalledOnce();
		expect(mockSend.mock.calls[0]![2]!.text).toBe(body);
	});

	it("reads stdin for --message - too", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: CTX.taskId }));
		mockReadStdin.mockResolvedValue("from stdin");

		await handleMessage(args([], { message: "-" }), SOCKET, CTX);

		expect(mockSend.mock.calls[0]![2]!.text).toBe("from stdin");
	});

	it("refuses positional text together with --message instead of dropping one", async () => {
		await expect(handleMessage(args(["short"], { message: "the long body" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");

		expect(stderrOutput).toContain("given twice");
		expect(mockSend).not.toHaveBeenCalled();
		expect(mockReadStdin).not.toHaveBeenCalled();
	});

	it("refuses unquoted words instead of sending only the first", async () => {
		await expect(handleMessage(args(["only", "the", "first"]), SOCKET, CTX)).rejects.toThrow("EXIT_3");

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

describe("message — --json and lost transports", () => {
	it("prints status and message id as JSON", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "held", messageId: "m-123", taskId: CTX.taskId }));
		await handleMessage(args(["hi"], { json: "true" }), SOCKET, CTX);
		expect(JSON.parse(stdoutOutput)).toEqual({ status: "held", messageId: "m-123" });
	});

	it("exits 11 with JSON when the app reports an unconfirmed send", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "unconfirmed", messageId: "m-1", taskId: CTX.taskId }));
		await expect(handleMessage(args(["hi"], { json: "true" }), SOCKET, CTX)).rejects.toThrow("EXIT_11");
		expect(JSON.parse(stdoutOutput)).toEqual({ status: "unconfirmed", messageId: "m-1" });
	});

	it.each([
		["an empty response", Object.assign(new Error("Empty response from server"), { name: "EmptyResponseError" })],
		["a reset connection", Object.assign(new Error("reset"), { code: "ECONNRESET" })],
		["a broken pipe", Object.assign(new Error("pipe"), { code: "EPIPE" })],
		["a socket timeout", new Error("Socket timeout (30s)")],
		["an unreadable answer", new Error("Invalid JSON response: {oops")],
	])("maps %s after sending to exit 11 (unconfirmed), never a re-send prompt", async (_name, err) => {
		mockSend.mockRejectedValue(err);
		await expect(handleMessage(args(["hi"], { json: "true" }), SOCKET, CTX)).rejects.toThrow("EXIT_11");
		expect(JSON.parse(stdoutOutput)).toEqual({ status: "unconfirmed", messageId: null });
	});

	it("leaves a connect that never happened to the app-not-running exit, saying not-delivered in JSON", async () => {
		mockSend.mockRejectedValue(new Error("APP_NOT_RUNNING"));
		await expect(handleMessage(args(["hi"], { json: "true" }), SOCKET, CTX)).rejects.toThrow("APP_NOT_RUNNING");
		expect(JSON.parse(stdoutOutput)).toEqual({ status: "not-delivered", messageId: null });
	});

	it("prints a not-delivered verdict when the app refuses the send", async () => {
		mockSend.mockResolvedValue(errResp("Could not deliver the message — the task has no live agent session."));
		await expect(handleMessage(args(["hi"], { json: "true" }), SOCKET, CTX)).rejects.toThrow("EXIT_1");
		expect(JSON.parse(stdoutOutput)).toEqual({
			status: "not-delivered",
			messageId: null,
			error: "Could not deliver the message — the task has no live agent session.",
		});
	});

	it("prints a not-delivered verdict for a stale endpoint, then leaves the exit to main", async () => {
		mockSend.mockRejectedValue(Object.assign(new Error("STALE_ENDPOINT"), { name: "StaleEndpointError" }));
		await expect(handleMessage(args(["hi"], { json: "true" }), SOCKET, CTX)).rejects.toThrow("STALE_ENDPOINT");
		expect(JSON.parse(stdoutOutput)).toEqual({ status: "not-delivered", messageId: null });
	});

	it("names the right verdict for an app that could not even be discovered", () => {
		expect(unreachableAppVerdict(["message", "--json", "--subject", "s", "hi"])).toBe('{"status":"not-delivered","messageId":null}');
		expect(unreachableAppVerdict(["message", "--json", "--in", "5m", "hi"])).toBe('{"status":"not-scheduled","messageId":null}');
		expect(unreachableAppVerdict(["message", "--json", "--to-sender", "cli", "hi"])).toBe('{"status":"not-posted","itemId":null}');
		expect(unreachableAppVerdict(["message", "--json=true", "hi"])).toBe('{"status":"not-delivered","messageId":null}');
		expect(unreachableAppVerdict(["message", "--subject", "s", "hi"])).toBeNull();
		expect(unreachableAppVerdict(["message", "--list", "--json"])).toBeNull();
	});

	it("prints the scheduled id as JSON", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: CTX.taskId, pending: 1, messageId: "sched-1" }));
		await handleMessage(args(["later"], { in: "10m", json: "true" }), SOCKET, CTX);
		expect(JSON.parse(stdoutOutput)).toMatchObject({ status: "scheduled", messageId: "sched-1" });
	});
});

describe("message — external senders", () => {
	it("sends --as-sender from outside a task with no source task", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "held", messageId: "m-9", taskId: "bbbbbbbb-1" }));
		await handleMessage(args(["status?"], { task: "seq:4", project: "proj-002", "as-sender": "openclaw:home:main", json: "true" }), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "message.sendAsSender", expect.objectContaining({ asSender: "openclaw:home:main", taskId: "seq:4" }));
		expect(mockSend.mock.calls[0]![2]).not.toHaveProperty("sourceTaskId");
	});

	it("refuses --as-sender inside a task worktree", async () => {
		await expect(handleMessage(args(["x"], { task: "seq:4", "as-sender": "cli" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("refuses --as-sender with --in or --at", async () => {
		await expect(handleMessage(args(["x"], { task: "seq:4", "as-sender": "cli", in: "5m" }), SOCKET, null)).rejects.toThrow("EXIT_3");
		await expect(handleMessage(args(["x"], { task: "seq:4", "as-sender": "cli", at: "14:00" }), SOCKET, null)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("refuses a malformed sender id before reaching the app", async () => {
		await expect(handleMessage(args(["x"], { task: "seq:4", "as-sender": "Bad Id" }), SOCKET, null)).rejects.toThrow("EXIT_3");
	});

	it("exits 39 for a sender the registry does not know", async () => {
		mockSend.mockResolvedValue(errResp('Unknown external sender "ghost". Register it in …'));
		await expect(handleMessage(args(["x"], { task: "seq:4", "as-sender": "ghost" }), SOCKET, null)).rejects.toThrow("EXIT_39");
	});

	it("fails closed on an app that predates senders: exit 1, never a success", async () => {
		mockSend.mockResolvedValue(errResp("Unknown method: message.sendAsSender"));
		await expect(handleMessage(args(["x"], { task: "seq:4", "as-sender": "cli", json: "true" }), SOCKET, null)).rejects.toThrow("EXIT_1");
		expect(JSON.parse(stdoutOutput)).toMatchObject({ status: "not-delivered", messageId: null });
		expect(stderrOutput).toContain("predates external senders");
	});

	it("posts --to-sender from a task into the sender inbox", async () => {
		mockSend.mockResolvedValue(okResp({ senderId: "cli", itemId: "item-1" }));
		await handleMessage(args(["done"], { "to-sender": "cli", "in-reply-to": "m-9", json: "true" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "sender.post", {
			senderId: "cli",
			sourceTaskId: CTX.taskId,
			text: "done",
			subject: SUBJECT,
			inReplyTo: "m-9",
		});
		expect(JSON.parse(stdoutOutput)).toEqual({ status: "posted", itemId: "item-1" });
	});

	it("refuses --to-sender outside a task, and --in-reply-to without it", async () => {
		await expect(handleMessage(args(["done"], { "to-sender": "cli" }), SOCKET, null)).rejects.toThrow("EXIT_3");
		await expect(handleMessage(args(["done"], { "in-reply-to": "m" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});
});
