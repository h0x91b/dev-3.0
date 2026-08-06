import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { handleClaudeStopFailure } from "../commands/claude-stop-failure";
import { describeClaudeStopFailure, parseClaudeStopFailurePayload } from "../../shared/agent-stop-failure";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CONTEXT: CliContext = {
	projectId: "project-1",
	taskId: "task-1",
	socketPath: SOCKET,
};

const LIMIT_MESSAGE = "You've hit your session limit · resets 3:40pm (Asia/Jerusalem)\n/usage-credits to request more usage from your admin.";

let stdout = "";
let stderr = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	stdout = "";
	stderr = "";
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
});

describe("parseClaudeStopFailurePayload", () => {
	it("reads the shipped schema's error/error_details pair", () => {
		expect(parseClaudeStopFailurePayload(JSON.stringify({
			hook_event_name: "StopFailure",
			error: "rate_limit",
			error_details: "429",
			last_assistant_message: LIMIT_MESSAGE,
		}))).toEqual({
			error: "rate_limit",
			errorDetails: "429",
			lastAssistantMessage: LIMIT_MESSAGE,
		});
	});

	// The docs print stop_reason/error_message while the shipped zod schema uses
	// error/error_details. Betting on one spelling would drop every event.
	it("also reads the documented stop_reason/error_message pair", () => {
		expect(parseClaudeStopFailurePayload(JSON.stringify({
			hook_event_name: "StopFailure",
			stop_reason: "billing_error",
			error_message: "payment required",
		}))).toEqual({ error: "billing_error", errorDetails: "payment required" });
	});

	it("degrades an unrecognized error to unknown instead of dropping the event", () => {
		expect(parseClaudeStopFailurePayload(JSON.stringify({
			hook_event_name: "StopFailure",
			error: "some_future_error",
		}))).toEqual({ error: "unknown" });
	});

	it("ignores other events and malformed input", () => {
		expect(parseClaudeStopFailurePayload(JSON.stringify({ hook_event_name: "Stop" }))).toBeNull();
		expect(parseClaudeStopFailurePayload("not-json")).toBeNull();
	});
});

describe("describeClaudeStopFailure", () => {
	it("prefers Claude's own limit sentence — it is the only place the reset time appears", () => {
		expect(describeClaudeStopFailure({ error: "rate_limit", lastAssistantMessage: LIMIT_MESSAGE }))
			.toBe("You've hit your session limit · resets 3:40pm (Asia/Jerusalem)");
	});

	it("falls back to a per-error line when the last message is an ordinary reply", () => {
		expect(describeClaudeStopFailure({ error: "rate_limit", lastAssistantMessage: "Done, tests are green." }))
			.toBe("Usage limit reached — the agent stopped mid-task");
		expect(describeClaudeStopFailure({ error: "authentication_failed" }))
			.toBe("The agent must sign in again");
	});

	it("keeps the reason short enough for a task card", () => {
		const reason = describeClaudeStopFailure({
			error: "rate_limit",
			lastAssistantMessage: `You've hit your ${"very ".repeat(60)}long limit`,
		});
		expect(reason.length).toBeLessThanOrEqual(120);
		expect(reason.endsWith("…")).toBe(true);
	});
});

describe("handleClaudeStopFailure", () => {
	it("forwards the failure to one socket handler", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });

		await handleClaudeStopFailure(
			JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: LIMIT_MESSAGE }),
			SOCKET,
			CONTEXT,
		);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.claudeStopFailure", {
			taskId: "task-1",
			projectId: "project-1",
			error: "rate_limit",
			lastAssistantMessage: LIMIT_MESSAGE,
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
		expect(stdout).toBe("");
		expect(stderr).toBe("");
	});

	it("is a silent no-op outside a task, with no socket, and on junk input", async () => {
		await handleClaudeStopFailure(JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit" }), SOCKET, null);
		await handleClaudeStopFailure(JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit" }), null, CONTEXT);
		await handleClaudeStopFailure("not-json", SOCKET, CONTEXT);

		expect(mockSend).not.toHaveBeenCalled();
		expect(stdout).toBe("");
		expect(stderr).toBe("");
	});

	it("reports a socket failure on stderr without throwing", async () => {
		mockSend.mockRejectedValue(new Error("socket closed"));

		await handleClaudeStopFailure(
			JSON.stringify({ hook_event_name: "StopFailure", error: "server_error" }),
			SOCKET,
			CONTEXT,
		);

		expect(stderr).toContain("socket closed");
	});
});
