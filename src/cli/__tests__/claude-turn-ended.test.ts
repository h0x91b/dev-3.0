import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleClaudeTurnEnded } from "../commands/claude-turn-ended";
import { sendRequest } from "../socket-client";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
const context = { taskId: "task", projectId: "project", socketPath: "/fixture/socket" };
beforeEach(() => { vi.mocked(sendRequest).mockReset(); });

describe("Claude normal turn/exit observation", () => {
	it.each(["Stop", "SessionEnd"])("reports %s from a native pane without changing the column", async hook_event_name => {
		await handleClaudeTurnEnded(JSON.stringify({ hook_event_name, session_id: "session" }), context.socketPath, context, { DEV3_PANE_ID: "pane-1" });
		expect(sendRequest).toHaveBeenCalledWith(context.socketPath, "task.claudeTurnEnded", {
			taskId: "task", projectId: "project", sessionId: "session", paneId: "pane-1",
		}, expect.anything());
	});
	it("ignores nested SDK sessions even when they inherit a tmux pane", async () => {
		await handleClaudeTurnEnded('{"hook_event_name":"Stop","session_id":"session"}', context.socketPath, context, { TMUX_PANE: "%1", CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
		expect(sendRequest).not.toHaveBeenCalled();
	});
	it("does not block Stop if the app is offline", async () => {
		vi.mocked(sendRequest).mockRejectedValue(new Error("offline"));
		await expect(handleClaudeTurnEnded('{"hook_event_name":"Stop","session_id":"session"}', context.socketPath, context, { TMUX_PANE: "%1" })).resolves.toBeUndefined();
	});
});
