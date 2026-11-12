import { describe, expect, it } from "vitest";
import { taskRunningAgentIds } from "../../shared/task-running-agent";
import type { Task } from "../../shared/types";

const pane = { agentCmd: "claude", sessionId: null, agentId: "builtin-claude", configId: "c2", agentFromDefault: true };

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1", worktreePath: "/wt", agentId: null, configId: null,
		sessionState: { panes: [pane] },
		...overrides,
	} as Task;
}

describe("taskRunningAgentIds", () => {
	it("falls back to the main pane when the task picked no agent", () => {
		expect(taskRunningAgentIds(makeTask())).toEqual({ agentId: "builtin-claude", configId: "c2" });
	});

	it("prefers the task's own pick over the pane", () => {
		const task = makeTask({ agentId: "builtin-codex", configId: "x1" });
		expect(taskRunningAgentIds(task)).toEqual({ agentId: "builtin-codex", configId: "x1" });
	});

	it("returns nulls without a worktree or without panes", () => {
		expect(taskRunningAgentIds(makeTask({ worktreePath: null }))).toEqual({ agentId: null, configId: null });
		expect(taskRunningAgentIds(makeTask({ sessionState: undefined }))).toEqual({ agentId: null, configId: null });
	});
});
