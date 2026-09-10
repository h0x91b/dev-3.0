/**
 * Claude Code's `UserPromptSubmit` adapter. It reports a submission and does
 * nothing else — the task's status is moved by the other entry on the same
 * event, which this must never be able to disturb.
 *
 * Payload shape verified against claude 2.1.267: `prompt` and `prompt_id` are
 * both present, and `prompt_id` is what makes exactly-once provable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { handleClaudePrompt } from "../commands/claude-prompt";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CONTEXT: CliContext = {
	projectId: "project-1",
	taskId: "task-1",
	socketPath: SOCKET,
};

const PAYLOAD = {
	session_id: "session-1",
	prompt_id: "prompt-9",
	hook_event_name: "UserPromptSubmit",
	prompt: "rebase and push",
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
});

afterEach(() => {
	stderrSpy.mockRestore();
});

describe("handleClaudePrompt", () => {
	it("reports the submission with its identity, and nothing about the transcript", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: { outcome: "recorded" } });

		await handleClaudePrompt(JSON.stringify(PAYLOAD), SOCKET, CONTEXT);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.promptSubmitted", {
			taskId: "task-1",
			projectId: "project-1",
			harness: "claude",
			prompt: "rebase and push",
			sessionId: "session-1",
			submissionId: "prompt-9",
		}, expect.anything());
		// transcript_path is global conversation surveillance and is never read.
		const [, , params] = mockSend.mock.calls[0]!;
		expect(JSON.stringify(params)).not.toContain("transcript");
	});

	it("stays silent on another hook event", async () => {
		await handleClaudePrompt(JSON.stringify({ ...PAYLOAD, hook_event_name: "Stop" }), SOCKET, CONTEXT);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("sends nothing for an empty prompt", async () => {
		await handleClaudePrompt(JSON.stringify({ ...PAYLOAD, prompt: "  " }), SOCKET, CONTEXT);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("does nothing outside a task worktree", async () => {
		await handleClaudePrompt(JSON.stringify(PAYLOAD), SOCKET, null);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("swallows unparseable input rather than failing the prompt", async () => {
		await expect(handleClaudePrompt("not json", SOCKET, CONTEXT)).resolves.toBeUndefined();
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("swallows a socket failure, since a traffic row is never worth erasing a prompt", async () => {
		mockSend.mockRejectedValue(new Error("app is down"));
		await expect(handleClaudePrompt(JSON.stringify(PAYLOAD), SOCKET, CONTEXT)).resolves.toBeUndefined();
		expect(stderr).toContain("app is down");
	});
});
