import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { handleCopilotHook } from "../commands/copilot-hook";
import { GENERIC_SKILL_BODY } from "../../shared/agent-skill-content";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CONTEXT: CliContext = {
	projectId: "project-1",
	taskId: "task-1",
	socketPath: SOCKET,
};

/** One real Copilot 1.0.83 payload per event, captured from a live session. */
const payload = (extra: Record<string, unknown> = {}) => JSON.stringify({
	sessionId: "session-1",
	timestamp: 1789403013545,
	cwd: "/private/tmp/work",
	...extra,
});

let stdout = "";
let stderr = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let originalTmuxPane: string | undefined;

beforeEach(() => {
	stdout = "";
	stderr = "";
	originalTmuxPane = process.env.TMUX_PANE;
	delete process.env.TMUX_PANE;
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = originalTmuxPane;
});

describe("handleCopilotHook", () => {
	it("maps each Copilot event onto the generic status event", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });

		for (const [copilotEvent, generic] of [
			["sessionStart", "SessionStart"],
			["preToolUse", "PreToolUse"],
			["postToolUse", "PostToolUse"],
			["agentStop", "Stop"],
		]) {
			mockSend.mockClear();
			await handleCopilotHook(copilotEvent, payload(), SOCKET, CONTEXT);
			expect(mockSend.mock.calls[0]?.[2]).toMatchObject({ event: generic, harness: "copilot" });
		}
	});

	it("carries the submitted prompt, keyed by the event's own timestamp", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });

		await handleCopilotHook("userPromptSubmitted", payload({ prompt: "do the thing" }), SOCKET, CONTEXT);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.agentHook", expect.objectContaining({
			event: "UserPromptSubmit",
			harness: "copilot",
			sessionId: "session-1",
			prompt: "do the thing",
			turnId: "1789403013545",
		}), expect.anything());
	});

	// `ask_user` is Copilot's AskUserQuestion: it blocks until the human answers,
	// so its preToolUse is the only moment the task is genuinely waiting on them.
	it("parks the task in Has Questions only on ask_user's preToolUse (either payload shape), naming the tool", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });

		await handleCopilotHook("preToolUse", payload({ toolName: "ask_user" }), SOCKET, CONTEXT);
		await handleCopilotHook("preToolUse", payload({ tool_name: "ask_user" }), SOCKET, CONTEXT);
		await handleCopilotHook("postToolUse", payload({ toolName: "ask_user" }), SOCKET, CONTEXT);
		await handleCopilotHook("preToolUse", payload({ toolName: "bash" }), SOCKET, CONTEXT);

		const events = mockSend.mock.calls.map((call) => call[2]);
		expect(events[0]).toMatchObject({ event: "PermissionRequest", toolName: "ask_user" });
		expect(events[1]).toMatchObject({ event: "PermissionRequest" });
		expect(events[2]).toMatchObject({ event: "PostToolUse", toolName: "ask_user" });
		expect(events[3]).toMatchObject({ event: "PreToolUse" });
	});

	it("ignores permissionRequest — Copilot fires it even when nothing asks the user", async () => {
		await handleCopilotHook("permissionRequest", payload({ toolName: "bash" }), SOCKET, CONTEXT);

		expect(mockSend).not.toHaveBeenCalled();
		expect(stdout).toBe("{}");
	});

	it("answers sessionStart with the dev3 protocol as additionalContext, even when dev3 is offline", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });
		await handleCopilotHook("sessionStart", payload({ source: "resume" }), SOCKET, CONTEXT);
		expect(JSON.parse(stdout)).toEqual({ additionalContext: GENERIC_SKILL_BODY });

		stdout = "";
		mockSend.mockClear();
		await handleCopilotHook("sessionStart", payload(), null, null);
		expect(mockSend).not.toHaveBeenCalled();
		expect(JSON.parse(stdout).additionalContext).toBe(GENERIC_SKILL_BODY);
	});

	// A non-zero exit or non-JSON stdout on preToolUse is fail-closed in Copilot:
	// it blocks the tool call. A dev3 that is merely down must never do that.
	it("stays silent-successful when the socket call throws", async () => {
		mockSend.mockRejectedValue(new Error("connect ECONNREFUSED"));

		await handleCopilotHook("preToolUse", payload({ toolName: "bash" }), SOCKET, CONTEXT);

		expect(stdout).toBe("{}");
		expect(stderr).toContain("connect ECONNREFUSED");
	});

	it("survives a payload that is not JSON at all", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });

		await handleCopilotHook("agentStop", "<not json>", SOCKET, CONTEXT);

		expect(stdout).toBe("{}");
		expect(mockSend.mock.calls[0]?.[2]).toMatchObject({ event: "Stop" });
	});
});
