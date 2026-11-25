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
	it("sends immediately with the in-context task attached, and says the whole message is held", async () => {
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
		expect(stdoutOutput).toContain("15s of quiet");
		// The human window is its own, longer number — a sender that expects 15s while
		// the user is typing would chase a peer that is not late at all.
		expect(stdoutOutput).toContain("60s if the user has been typing");
		expect(stdoutOutput).not.toContain("Message sent");
	});

	it("attaches the worktree task, its pane and pid as the sender when messaging another task; none without a worktree", async () => {
		vi.stubEnv("TMUX_PANE", "%3");
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "held", taskId: "other", projectId: CTX.projectId }));

		await handleMessage(args(["ping"], { task: "seq:42" }), SOCKET, CTX);
		expect(mockSend.mock.calls[0]![2]).toMatchObject({ taskId: "seq:42", sourceTaskId: CTX.taskId, sourcePaneId: "%3", sourcePid: process.pid });

		await handleMessage(args(["ping"], { task: "seq:42" }), SOCKET, null);
		expect(mockSend.mock.calls[1]![2]).not.toHaveProperty("sourceTaskId");
	});

	it("reports a delivery failure as a command error", async () => {
		mockSend.mockResolvedValue(errResp("no live agent"));
		await expect(handleMessage(args(["hi"]), SOCKET, CTX)).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("no live agent");
	});

	it("says a message waits behind the receiver's open prompt, warns against resending, and carries the hold into --json", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "held", heldBehindPrompt: true, messageId: "m1", taskId: CTX.taskId, paneId: "%3" }));
		await handleMessage(args(["ping"]), SOCKET, CTX);
		expect(stdoutOutput).toContain("Message held for task aaaaaaaa (pane %3): the agent is showing a prompt");
		expect(stdoutOutput).toContain("Do not send it again.");
		expect(stdoutOutput).not.toContain("Message queued");

		stdoutOutput = "";
		await handleMessage(args(["ping"], { json: "true" }), SOCKET, CTX);
		expect(JSON.parse(stdoutOutput)).toEqual({ status: "held", messageId: "m1", heldBehindPrompt: true });
	});

	it("names the agent and pane it went to", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "held", taskId: CTX.taskId, paneId: "%3", agentRole: "review" }));
		await handleMessage(args(["ping"]), SOCKET, CTX);
		expect(stdoutOutput).toContain("Message queued for task aaaaaaaa (AI Review agent, pane %3).");
	});

	it("says plainly when the receiver gets no way to reply, on both forms, and says nothing when the sender was proven", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "held", taskId: "other" }));
		await handleMessage(args(["ping"], { task: "seq:42" }), SOCKET, CTX);
		expect(stderrOutput).not.toContain("Replies to you");

		mockSend.mockResolvedValue(okResp({
			delivered: true, status: "held", taskId: "other", replyUnavailable: "agent identity cannot be verified on Windows yet",
		}));
		await handleMessage(args(["ping"], { task: "seq:42" }), SOCKET, CTX);
		expect(stderrOutput).toContain(
			"Replies to you are not available (agent identity cannot be verified on Windows yet): the message carries no reply command.",
		);
		expect(stdoutOutput).toContain("Message queued");

		mockSend.mockResolvedValue(okResp({ taskId: "other", pending: 1, replyUnavailable: "a shell, not an agent" }));
		await handleMessage(args(["later"], { in: "30m", task: "seq:42" }), SOCKET, CTX);
		expect(stderrOutput).toContain("Replies to you are not available (a shell, not an agent)");
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

	it("refuses a raw pane id, a bare flag or an old a1. handle, sending nothing", async () => {
		for (const agent of ["%3", "true", "a1.WyIlMyJd"]) {
			stderrOutput = "";
			await expect(handleMessage(args(["review it"], { task: "seq:42", agent }), SOCKET, CTX), agent).rejects.toThrow("EXIT_3");
			expect(stderrOutput, agent).toContain("dev3 pane list --task <id>");
		}
		expect(stderrOutput).toContain("written by an older dev3");
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
	it("schedules with --in (a future ISO time) or --at, carrying the text and the subject", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: CTX.taskId, pending: 1 }));
		await handleMessage(args(["later thing"], { in: "30m" }), SOCKET, CTX);
		const [, method, params] = mockSend.mock.calls[0]!;
		expect(method).toBe("message.schedule");
		expect(params!.text).toBe("later thing");
		expect(params!.subject).toBe(SUBJECT);
		expect(new Date(params!.at as string).getTime()).toBeGreaterThan(Date.now());
		expect(stdoutOutput).toContain("Message scheduled");

		await handleMessage(args(["at thing"], { at: "23:59" }), SOCKET, CTX);
		const [, atMethod, atParams] = mockSend.mock.calls[1]!;
		expect(atMethod).toBe("message.schedule");
		expect(typeof atParams!.at).toBe("string");
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

	it("rejects both --in and --at, an invalid --in duration, and an invalid --at time", async () => {
		const cases: Array<[Record<string, string>, RegExp]> = [
			[{ in: "30m", at: "14:00" }, /either --in or --at/i],
			[{ in: "soon" }, /invalid --in/i],
			[{ at: "99:99" }, /invalid --at/i],
		];
		for (const [flags, message] of cases) {
			stderrOutput = "";
			await expect(handleMessage(args(["x"], flags), SOCKET, CTX), JSON.stringify(flags)).rejects.toThrow("EXIT_3");
			expect(stderrOutput).toMatch(message);
		}
		expect(mockSend).not.toHaveBeenCalled();
	});
});

describe("message — text input", () => {
	it("reads the body from stdin when the text (or --message) is -, byte for byte", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: CTX.taskId }));
		const body = "Rename `note.ts` addNote — keep $HOME and \"quotes\"\nПроверка 🙂";
		mockReadStdin.mockResolvedValue(`${body}\n`);

		await handleMessage(args(["-"]), SOCKET, CTX);

		expect(mockReadStdin).toHaveBeenCalledOnce();
		expect(mockSend.mock.calls[0]![2]!.text).toBe(body);

		mockReadStdin.mockResolvedValue("from stdin");
		await handleMessage(args([], { message: "-" }), SOCKET, CTX);
		expect(mockSend.mock.calls[1]![2]!.text).toBe("from stdin");
	});

	it("refuses positional text together with --message, and unquoted words, instead of dropping any", async () => {
		await expect(handleMessage(args(["short"], { message: "the long body" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("given twice");

		await expect(handleMessage(args(["only", "the", "first"]), SOCKET, CTX)).rejects.toThrow("EXIT_3");

		expect(mockSend).not.toHaveBeenCalled();
		expect(mockReadStdin).not.toHaveBeenCalled();
	});
});

describe("message — validation", () => {
	it("rejects empty text, and a send with no task in context", async () => {
		await expect(handleMessage(args([]), SOCKET, CTX)).rejects.toThrow("EXIT_3");

		const ctxNoTask = { projectId: null, taskId: null, socketPath: SOCKET } as unknown as CliContext;
		await expect(handleMessage(args(["x"]), SOCKET, ctxNoTask)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toMatch(/no task in context/i);
		expect(mockSend).not.toHaveBeenCalled();
	});
});

describe("message — --subject is mandatory", () => {
	// The error path IS the feature: every agent alive has the habit of sending
	// without a subject, so this is the message they will actually meet.
	it("refuses a message with no subject, with its own exit code, teaching the shape and the corrected command", async () => {
		await expect(
			handleMessage(rawArgs(["CI is green on all four shards"], { task: "seq:490" }), SOCKET, CTX),
		).rejects.toThrow("EXIT_17");
		expect(mockSend).not.toHaveBeenCalled();
		expect(stderrOutput).toContain("dev3 message needs --subject");
		expect(stderrOutput).toContain("about 6 words");
		expect(stderrOutput).toContain("80 characters at most");
		expect(stderrOutput).toContain('good:  --subject "<pr:1577> merged, main green"');
		expect(stderrOutput).toContain('bad:   --subject "<seq:1722> -> Coordinator: <pr:1577> merged"');
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

	it("treats a bare or whitespace-only --subject as missing, on the scheduled form too", async () => {
		const cases: Array<Record<string, string>> = [{ subject: "true" }, { subject: "   \t " }, { in: "30m" }];
		for (const flags of cases) {
			await expect(handleMessage(rawArgs(["ping"], flags), SOCKET, CTX), JSON.stringify(flags)).rejects.toThrow("EXIT_17");
		}
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("accepts a subject exactly at the limit and rejects one over it instead of truncating", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, taskId: CTX.taskId, projectId: CTX.projectId }));
		const exact = "a".repeat(80);
		await handleMessage(rawArgs(["ping"], { subject: exact }), SOCKET, CTX);
		expect(mockSend.mock.calls[0]?.[2]?.subject).toBe(exact);

		await expect(handleMessage(rawArgs(["ping"], { subject: `${exact}a` }), SOCKET, CTX)).rejects.toThrow("EXIT_17");
		expect(stderrOutput).toContain("--subject is too long: 81 characters");
		expect(mockSend).toHaveBeenCalledTimes(1);
	});

	it("collapses a multi-line subject into the one line it is", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, taskId: CTX.taskId, projectId: CTX.projectId }));
		await handleMessage(rawArgs(["ping"], { subject: "  CI green\n  on   main " }), SOCKET, CTX);
		expect(mockSend.mock.calls[0]?.[2]?.subject).toBe("CI green on main");
	});
});

describe("message — --variant", () => {
	it("carries the index alongside the seq ref on both forms, and omits the field when absent", async () => {
		mockSend.mockResolvedValue(okResp({ taskId: "bbbbbbbb-1111-2222-3333-444444444444", pending: 1 }));

		await handleMessage(args(["ping"], { task: "seq:490", variant: "1" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenLastCalledWith(SOCKET, "message.send", expect.objectContaining({ taskId: "seq:490", variantIndex: 1 }));

		await handleMessage(args(["ping"], { task: "seq:490", variant: "2", in: "30m" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenLastCalledWith(SOCKET, "message.schedule", expect.objectContaining({ taskId: "seq:490", variantIndex: 2 }));

		await handleMessage(args(["ping"], { task: "seq:490" }), SOCKET, CTX);
		expect(mockSend.mock.calls[2]?.[2]).not.toHaveProperty("variantIndex");
	});

	it("rejects --variant against a task id, without --task, bare, or non-numeric", async () => {
		const cases: Array<[Record<string, string>, RegExp | null]> = [
			[{ task: "bbbbbbbb-1111-2222-3333-444444444444", variant: "1" }, /--task seq:<N> --variant/],
			[{ variant: "1" }, null],
			[{ task: "seq:490", variant: "true" }, /--variant needs an index/],
			[{ task: "seq:490", variant: "one" }, /Invalid --variant/],
		];
		for (const [flags, message] of cases) {
			stderrOutput = "";
			await expect(handleMessage(args(["ping"], flags), SOCKET, CTX), JSON.stringify(flags)).rejects.toThrow("EXIT_3");
			if (message) expect(stderrOutput).toMatch(message);
		}
		expect(mockSend).not.toHaveBeenCalled();
	});
});

describe("message — --json and lost transports", () => {
	it("prints status and message id as JSON, for a send and a schedule", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "held", messageId: "m-123", taskId: CTX.taskId }));
		await handleMessage(args(["hi"], { json: "true" }), SOCKET, CTX);
		expect(JSON.parse(stdoutOutput)).toEqual({ status: "held", messageId: "m-123" });

		stdoutOutput = "";
		mockSend.mockResolvedValue(okResp({ taskId: CTX.taskId, pending: 1, messageId: "sched-1" }));
		await handleMessage(args(["later"], { in: "10m", json: "true" }), SOCKET, CTX);
		expect(JSON.parse(stdoutOutput)).toMatchObject({ status: "scheduled", messageId: "sched-1" });
	});

	it("exits 11 (unconfirmed) when the app says so, and for every transport loss after sending — never a re-send prompt", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "unconfirmed", messageId: "m-1", taskId: CTX.taskId }));
		await expect(handleMessage(args(["hi"], { json: "true" }), SOCKET, CTX)).rejects.toThrow("EXIT_11");
		expect(JSON.parse(stdoutOutput)).toEqual({ status: "unconfirmed", messageId: "m-1" });

		const losses: Array<[string, Error]> = [
			["an empty response", Object.assign(new Error("Empty response from server"), { name: "EmptyResponseError" })],
			["a reset connection", Object.assign(new Error("reset"), { code: "ECONNRESET" })],
			["a broken pipe", Object.assign(new Error("pipe"), { code: "EPIPE" })],
			["a socket timeout", new Error("Socket timeout (30s)")],
			["an unreadable answer", new Error("Invalid JSON response: {oops")],
		];
		for (const [name, err] of losses) {
			stdoutOutput = "";
			mockSend.mockRejectedValue(err);
			await expect(handleMessage(args(["hi"], { json: "true" }), SOCKET, CTX), name).rejects.toThrow("EXIT_11");
			expect(JSON.parse(stdoutOutput), name).toEqual({ status: "unconfirmed", messageId: null });
		}
	});

	it("says not-delivered in JSON and leaves the exit to main for a connect that never happened or a stale endpoint", async () => {
		const errors: Array<[string, Error]> = [
			["APP_NOT_RUNNING", new Error("APP_NOT_RUNNING")],
			["STALE_ENDPOINT", Object.assign(new Error("STALE_ENDPOINT"), { name: "StaleEndpointError" })],
		];
		for (const [message, err] of errors) {
			stdoutOutput = "";
			mockSend.mockRejectedValue(err);
			await expect(handleMessage(args(["hi"], { json: "true" }), SOCKET, CTX), message).rejects.toThrow(message);
			expect(JSON.parse(stdoutOutput), message).toEqual({ status: "not-delivered", messageId: null });
		}
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

	it("names the right verdict for an app that could not even be discovered", () => {
		expect(unreachableAppVerdict(["message", "--json", "--subject", "s", "hi"])).toBe('{"status":"not-delivered","messageId":null}');
		expect(unreachableAppVerdict(["message", "--json", "--in", "5m", "hi"])).toBe('{"status":"not-scheduled","messageId":null}');
		expect(unreachableAppVerdict(["message", "--json", "--to-sender", "cli", "hi"])).toBe('{"status":"not-posted","itemId":null}');
		expect(unreachableAppVerdict(["message", "--json=true", "hi"])).toBe('{"status":"not-delivered","messageId":null}');
		expect(unreachableAppVerdict(["message", "--subject", "s", "hi"])).toBeNull();
		expect(unreachableAppVerdict(["message", "--list", "--json"])).toBeNull();
	});
});

describe("message — external senders", () => {
	it("sends --as-sender from outside a task with no source task", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, status: "held", messageId: "m-9", taskId: "bbbbbbbb-1" }));
		await handleMessage(args(["status?"], { task: "seq:4", project: "proj-002", "as-sender": "openclaw:home:main", json: "true" }), SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "message.sendAsSender", expect.objectContaining({ asSender: "openclaw:home:main", taskId: "seq:4" }));
		expect(mockSend.mock.calls[0]![2]).not.toHaveProperty("sourceTaskId");
	});

	it("refuses misplaced sender flags before reaching the app", async () => {
		const cases: Array<[string, string[], Record<string, string>, CliContext | null]> = [
			["--as-sender inside a task worktree", ["x"], { task: "seq:4", "as-sender": "cli" }, CTX],
			["--as-sender with --agent", ["x"], { task: "seq:4", "as-sender": "cli", agent: "anything" }, null],
			["--as-sender with --in", ["x"], { task: "seq:4", "as-sender": "cli", in: "5m" }, null],
			["--as-sender with --at", ["x"], { task: "seq:4", "as-sender": "cli", at: "14:00" }, null],
			["a malformed sender id", ["x"], { task: "seq:4", "as-sender": "Bad Id" }, null],
			["--to-sender outside a task", ["done"], { "to-sender": "cli" }, null],
			["--in-reply-to without --to-sender", ["done"], { "in-reply-to": "m" }, CTX],
		];
		for (const [name, positional, flags, context] of cases) {
			await expect(handleMessage(args(positional, flags), SOCKET, context), name).rejects.toThrow("EXIT_3");
		}
		expect(mockSend).not.toHaveBeenCalled();
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
});
