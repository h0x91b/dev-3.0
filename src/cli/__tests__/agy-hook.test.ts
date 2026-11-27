import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { skillBodyFor } from "../../shared/agent-skill-content";
import { sendRequest } from "../socket-client";
import { handleAgyHook } from "../commands/agy-hook";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CONTEXT: CliContext = { projectId: "project-1", taskId: "task-1", socketPath: SOCKET };
const OPTIONS = { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 };

let stdout = "";
let stderr = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let originalTmuxPane: string | undefined;
let originalNativePane: string | undefined;

beforeEach(() => {
	stdout = "";
	stderr = "";
	originalTmuxPane = process.env.TMUX_PANE;
	delete process.env.TMUX_PANE;
	originalNativePane = process.env.DEV3_PANE_ID;
	delete process.env.DEV3_PANE_ID;
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	mockSend.mockReset();
	mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = originalTmuxPane;
	if (originalNativePane === undefined) delete process.env.DEV3_PANE_ID;
	else process.env.DEV3_PANE_ID = originalNativePane;
});

describe("handleAgyHook", () => {
	it("SessionStart records the conversation, marks the task active and injects the protocol", async () => {
		process.env.TMUX_PANE = "%7";
		await handleAgyHook("SessionStart", JSON.stringify({ hookEventName: "SessionStart", conversationId: "conv-1" }), SOCKET, CONTEXT);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.agentHook", {
			taskId: "task-1",
			projectId: "project-1",
			harness: "agy",
			event: "SessionStart",
			sessionId: "conv-1",
			paneId: "%7",
		}, OPTIONS);
		expect(JSON.parse(stdout)).toEqual({
			injectSteps: [{ systemMessage: { systemMessage: skillBodyFor("agy", "worktree") } }],
		});
	});

	it("names a native pane by DEV3_PANE_ID when there is no tmux pane, so its conversation lands on the right pane", async () => {
		process.env.DEV3_PANE_ID = "native-2";
		await handleAgyHook("PreInvocation", JSON.stringify({ conversationId: "conv-n" }), SOCKET, CONTEXT);
		expect(mockSend.mock.calls[0]![2]).toMatchObject({ sessionId: "conv-n", paneId: "native-2" });
		// A TMUX_PANE leaked into a native pane must not win over the explicit native id.
		process.env.TMUX_PANE = "%4";
		await handleAgyHook("PreInvocation", JSON.stringify({ conversationId: "conv-n" }), SOCKET, CONTEXT);
		expect(mockSend.mock.calls[1]![2]).toMatchObject({ paneId: "native-2" });
	});

	it("drops a conversation id that is not a plain token instead of sending it on", async () => {
		await handleAgyHook("PreInvocation", JSON.stringify({ conversationId: "x; rm -rf /" }), SOCKET, CONTEXT);
		expect(mockSend.mock.calls[0]![2]).not.toHaveProperty("sessionId");
	});

	it("PreInvocation reports activity and captures the conversation id", async () => {
		await handleAgyHook("PreInvocation", JSON.stringify({ conversationId: "conv-2" }), SOCKET, CONTEXT);

		expect(mockSend.mock.calls[0]![2]).toMatchObject({ harness: "agy", event: "UserPromptSubmit", sessionId: "conv-2" });
		expect(mockSend.mock.calls[0]![2]).not.toHaveProperty("prompt");
		expect(stdout).toBe("{}");
	});

	it("a normal Stop, a user cancel and a payload-named Stop all move the task toward review", async () => {
		await handleAgyHook("Stop", JSON.stringify({ conversationId: "conv-3", terminationReason: "NO_TOOL_CALL" }), SOCKET, CONTEXT);
		await handleAgyHook("Stop", JSON.stringify({ terminationReason: "USER_CANCELED" }), SOCKET, CONTEXT);
		await handleAgyHook("", JSON.stringify({ hookEventName: "Stop", conversationId: "c" }), SOCKET, CONTEXT);

		expect(mockSend.mock.calls).toHaveLength(3);
		expect(mockSend.mock.calls.map((call) => call[1])).toEqual(["task.agentHook", "task.agentHook", "task.agentHook"]);
		expect(mockSend.mock.calls[0]![2]).toMatchObject({ event: "Stop", sessionId: "conv-3" });
		expect(mockSend.mock.calls[2]![2]).toMatchObject({ event: "Stop" });
		expect(stdout).toBe("{}{}{}");
	});

	it("a Stop that ended on ERROR parks the task with an attention badge instead of sending Stop", async () => {
		await handleAgyHook("Stop", JSON.stringify({ conversationId: "conv-4", terminationReason: "ERROR", error: "boom" }), SOCKET, CONTEXT);

		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.claudeStopFailure", {
			taskId: "task-1",
			projectId: "project-1",
			error: "unknown",
		}, OPTIONS);
		expect(stdout).toBe("{}");
	});

	it("prints {} and sends nothing for malformed stdin and an unknown event", async () => {
		await handleAgyHook("PreInvocation", "not json", SOCKET, CONTEXT);
		expect(stdout).toBe("{}");
		expect(mockSend).toHaveBeenCalledTimes(1);
		mockSend.mockClear();
		stdout = "";

		await handleAgyHook("PostInvocation", "{}", SOCKET, CONTEXT);
		expect(stdout).toBe("{}");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("injects the protocol offline but never outside a dev3 task, and prints {} elsewhere", async () => {
		await handleAgyHook("SessionStart", "{}", null, CONTEXT);
		expect(JSON.parse(stdout).injectSteps).toHaveLength(1);
		stdout = "";

		await handleAgyHook("Stop", "{}", null, CONTEXT);
		expect(stdout).toBe("{}");
		stdout = "";

		await handleAgyHook("SessionStart", "{}", SOCKET, null);
		expect(stdout).toBe("{}");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("never fails agy: a rejected or refused status update still prints valid JSON and exits cleanly", async () => {
		mockSend.mockRejectedValueOnce(new Error("socket gone"));
		await handleAgyHook("PreInvocation", "{}", SOCKET, CONTEXT);
		expect(stdout).toBe("{}");
		expect(stderr).toContain("socket gone");

		stdout = "";
		mockSend.mockResolvedValueOnce({ id: "1", ok: false, error: "task not found" });
		await handleAgyHook("Stop", JSON.stringify({ terminationReason: "ERROR" }), SOCKET, CONTEXT);
		expect(stdout).toBe("{}");
		expect(stderr).toContain("task not found");
	});
});
