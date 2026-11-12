import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";
import { senderAgentParams } from "../sender-agent";

const ctx: CliContext = { projectId: "proj-1", taskId: "task-1", socketPath: "/tmp/x.sock", worktreePath: "/wt" };

afterEach(() => vi.unstubAllEnvs());

describe("senderAgentParams", () => {
	it("sends the pane, pid and the env evidence when they are set", () => {
		vi.stubEnv("TMUX_PANE", "%4");
		vi.stubEnv("TMUX", "/private/tmp/tmux-501/dev3,4242,0");
		vi.stubEnv("DEV3_TASK_ID", "task-1");
		expect(senderAgentParams(ctx)).toEqual({
			sourcePaneId: "%4", sourcePid: process.pid, sourceTmux: "/private/tmp/tmux-501/dev3,4242,0", sourceEnvTaskId: "task-1",
		});
	});

	it("omits sourceTmux and sourceEnvTaskId when TMUX and DEV3_TASK_ID are empty or unset", () => {
		vi.stubEnv("TMUX_PANE", "%4");
		vi.stubEnv("TMUX", "  ");
		vi.stubEnv("DEV3_TASK_ID", "");
		expect(senderAgentParams(ctx)).toEqual({ sourcePaneId: "%4", sourcePid: process.pid });
		vi.stubEnv("TMUX", undefined as unknown as string);
		vi.stubEnv("DEV3_TASK_ID", undefined as unknown as string);
		expect(senderAgentParams(ctx)).toEqual({ sourcePaneId: "%4", sourcePid: process.pid });
	});

	it("sends nothing outside a task or without a pane", () => {
		vi.stubEnv("TMUX_PANE", "");
		vi.stubEnv("DEV3_PANE_ID", "");
		expect(senderAgentParams(ctx)).toEqual({});
		vi.stubEnv("TMUX_PANE", "%4");
		expect(senderAgentParams(null)).toEqual({});
	});
});
