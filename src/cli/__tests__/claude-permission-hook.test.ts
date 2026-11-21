import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
import { sendRequest } from "../socket-client";
import { handleClaudePermission } from "../commands/claude-permission";

const context: CliContext = { projectId: "project-1", taskId: "task-1", socketPath: "/tmp/test.sock" };
// Verified on Claude Code 2.1.330: a PermissionRequest carries no tool_use_id.
const PAYLOAD = JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
let stdout: string;
let stderr: string;

beforeEach(() => {
	stdout = "";
	stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
	vi.mocked(sendRequest).mockReset().mockResolvedValue({ id: "1", ok: true, data: {} });
});
afterEach(() => vi.restoreAllMocks());

describe("handleClaudePermission", () => {
	it("tells dev3 which pane shows the prompt, and prints no permission decision", async () => {
		await handleClaudePermission(PAYLOAD, context.socketPath, context, { TMUX_PANE: "%2" });
		expect(sendRequest).toHaveBeenCalledWith(context.socketPath, "task.claudePermissionRequest", {
			taskId: "task-1", projectId: "project-1", sessionId: "s1", toolName: "Bash", paneId: "%2",
		}, expect.objectContaining({ timeoutMs: 3_000 }));
		expect(stdout).toBe("");
	});

	it("uses the native pane id when there is no tmux pane", async () => {
		await handleClaudePermission(PAYLOAD, context.socketPath, context, { DEV3_PANE_ID: "agent" });
		expect(vi.mocked(sendRequest).mock.calls[0]?.[2]).toMatchObject({ paneId: "agent" });
	});

	it.each([
		["the app is offline", () => vi.mocked(sendRequest).mockRejectedValue(new Error("offline"))],
		["the move is refused", () => vi.mocked(sendRequest).mockResolvedValue({ id: "1", ok: true, data: { moveError: "nope" } })],
	])("never throws when %s", async (_, arrange) => {
		arrange();
		await expect(handleClaudePermission(PAYLOAD, context.socketPath, context, {})).resolves.toBeUndefined();
		expect(stderr).toContain("dev3 permission hook");
		expect(stdout).toBe("");
	});

	it("does nothing outside a task", async () => {
		await handleClaudePermission(PAYLOAD, null, null, {});
		expect(sendRequest).not.toHaveBeenCalled();
	});
});
