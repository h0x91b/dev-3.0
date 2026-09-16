/**
 * Claude Code's `SessionStart` / `SessionEnd` adapter — the receipt that tells
 * dev3 whether typed input would reach the agent's input box or one of its
 * startup dialogs (h0x91b/dev-3.0#1785).
 *
 * Payload shape verified against claude 2.1.273: both events carry the same
 * `session_id`, SessionStart adds `source` and SessionEnd adds `reason`. Neither
 * is read here — the id is what pairs a start with its end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { handleClaudeSession } from "../commands/claude-session";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CONTEXT: CliContext = {
	projectId: "project-1",
	taskId: "task-1",
	socketPath: SOCKET,
};

const START = {
	session_id: "session-1",
	hook_event_name: "SessionStart",
	source: "startup",
	model: "claude-opus-5[1m]",
	transcript_path: "/tmp/transcript.jsonl",
	cwd: "/tmp/worktree",
};

const END = {
	session_id: "session-1",
	hook_event_name: "SessionEnd",
	reason: "prompt_input_exit",
	transcript_path: "/tmp/transcript.jsonl",
	cwd: "/tmp/worktree",
};

let stderr = "";
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	stderr = "";
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	mockSend.mockReset();
	// The hook reads its pane and launch identity out of the environment, and this
	// suite may itself be running inside tmux — pin all three so the assertions are
	// about what the adapter sends, not about where the test happened to run.
	for (const key of ["TMUX_PANE", "DEV3_PANE_ID", "DEV3_LAUNCH_ID"]) delete process.env[key];
	mockSend.mockResolvedValue({ id: "1", ok: true, data: { readiness: "ready" } });
});

afterEach(() => {
	stderrSpy.mockRestore();
});

describe("handleClaudeSession", () => {
	it("reports a session opening", async () => {
		await handleClaudeSession(JSON.stringify(START), SOCKET, CONTEXT);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.agentSession", {
			taskId: "task-1",
			projectId: "project-1",
			harness: "claude",
			event: "SessionStart",
			sessionId: "session-1",
		}, expect.anything());
		// transcript_path is global conversation surveillance and is never read.
		const [, , params] = mockSend.mock.calls[0]!;
		expect(JSON.stringify(params)).not.toContain("transcript");
	});

	it("reports a session closing under the same id", async () => {
		await handleClaudeSession(JSON.stringify(END), SOCKET, CONTEXT);
		expect(mockSend.mock.calls[0]?.[2]).toMatchObject({ event: "SessionEnd", sessionId: "session-1" });
	});

	it("stays silent on another hook event", async () => {
		await handleClaudeSession(JSON.stringify({ ...START, hook_event_name: "Stop" }), SOCKET, CONTEXT);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("does nothing outside a task worktree", async () => {
		await handleClaudeSession(JSON.stringify(START), SOCKET, null);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("swallows unparseable input rather than failing the session", async () => {
		await expect(handleClaudeSession("not json", SOCKET, CONTEXT)).resolves.toBeUndefined();
		expect(mockSend).not.toHaveBeenCalled();
	});

	// A non-zero SessionStart hook is a startup error in the user's face, and
	// knowing when the input box appeared is never worth that.
	it("swallows a socket failure", async () => {
		mockSend.mockRejectedValue(new Error("app is down"));
		await expect(handleClaudeSession(JSON.stringify(START), SOCKET, CONTEXT)).resolves.toBeUndefined();
		expect(stderr).toContain("app is down");
	});
});

// Where a receipt applies and which launch it belongs to. Without the launch id a
// slow hook from the agent dev3 just replaced would bless the one now booting;
// without the pane, one ready agent would vouch for a sibling still in its dialog.
describe("handleClaudeSession — pane and launch identity", () => {
	it("forwards the pane and launch id the agent's environment carries", async () => {
		process.env.TMUX_PANE = "%7";
		process.env.DEV3_LAUNCH_ID = "launch-42";
		try {
			await handleClaudeSession(JSON.stringify(START), SOCKET, CONTEXT);
		} finally {
			delete process.env.TMUX_PANE;
			delete process.env.DEV3_LAUNCH_ID;
		}
		expect(mockSend.mock.calls[0]?.[2]).toMatchObject({ paneId: "%7", launchId: "launch-42" });
	});

	it("prefers the native pane variable when both are present", async () => {
		process.env.TMUX_PANE = "%7";
		process.env.DEV3_PANE_ID = "native-3";
		try {
			await handleClaudeSession(JSON.stringify(START), SOCKET, CONTEXT);
		} finally {
			delete process.env.TMUX_PANE;
			delete process.env.DEV3_PANE_ID;
		}
		expect(mockSend.mock.calls[0]?.[2]).toMatchObject({ paneId: "native-3" });
	});

	it("sends neither key when the environment carries neither", async () => {
		await handleClaudeSession(JSON.stringify(START), SOCKET, CONTEXT);
		const params = mockSend.mock.calls[0]?.[2] as Record<string, unknown>;
		expect(params).not.toHaveProperty("paneId");
		expect(params).not.toHaveProperty("launchId");
	});
});
