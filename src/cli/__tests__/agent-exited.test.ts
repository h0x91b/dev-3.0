import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));

import { sendRequest } from "../socket-client";
import { parseArgs } from "../args";
import { handleAgentExitedHook } from "../commands/agent-exited";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";

// The exact argv the launch wrapper runs: `agentExitReportArgv` + the exit code.
const wrapperArgs = (code: string) => parseArgs(["--task", "task-1", "--session", "s-1", code]);

beforeEach(() => {
	vi.stubEnv("TMUX_PANE", "");
	vi.stubEnv("DEV3_PANE_ID", "");
	mockSend.mockReset();
	mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("dev3 hook agent-exited", () => {
	it("forwards the task, the spawn's session and the exit code", async () => {
		await handleAgentExitedHook(wrapperArgs("1"), SOCKET, { projectId: "p-1", taskId: "task-1", socketPath: SOCKET });
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "agent.exited", { taskId: "task-1", projectId: "p-1", sessionId: "s-1", exitCode: 1 }, expect.any(Object));
	});

	it("names the pane the agent ran in, tmux's or a native one's, so the app clears that pane's state only", async () => {
		const context = { projectId: "p-1", taskId: "task-1", socketPath: SOCKET };
		vi.stubEnv("DEV3_PANE_ID", "native-2");
		await handleAgentExitedHook(wrapperArgs("0"), SOCKET, context);
		expect(mockSend.mock.calls[0]![2]).toMatchObject({ paneId: "native-2" });
		vi.stubEnv("TMUX_PANE", "%4");
		await handleAgentExitedHook(wrapperArgs("0"), SOCKET, context);
		expect(mockSend.mock.calls[1]![2]).toMatchObject({ paneId: "%4" });
	});

	it("never fails the pane: app offline, socket error, missing session", async () => {
		await expect(handleAgentExitedHook(wrapperArgs("1"), null, null)).resolves.toBeUndefined();
		mockSend.mockRejectedValue(new Error("ECONNREFUSED"));
		await expect(handleAgentExitedHook(wrapperArgs("0"), SOCKET, null)).resolves.toBeUndefined();
		await handleAgentExitedHook(parseArgs(["--task", "task-1", "1"]), SOCKET, null);
		expect(mockSend).toHaveBeenCalledTimes(1);
	});
});
