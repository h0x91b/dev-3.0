import type { CodingAgent, Task } from "../../../shared/types";
import { getTaskAgentMeta, taskRunningAgentIds } from "../taskAgentMeta";

const claude: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	configurations: [
		{ id: "c1", name: "Default" },
		{ id: "c2", name: "Fast (Opus 5.5)" },
	],
	defaultConfigId: "c1",
};
const codex: CodingAgent = {
	id: "builtin-codex",
	name: "Codex",
	baseCommand: "codex",
	configurations: [{ id: "x1", name: "Default" }],
	defaultConfigId: "x1",
};

const pane = { agentCmd: "claude", sessionId: null, agentId: "builtin-claude", configId: "c2", agentFromDefault: true };

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1", seq: 1, projectId: "p1", title: "Task", description: "", status: "in-progress",
		baseBranch: "main", worktreePath: "/wt", branchName: null, groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
		sessionState: { panes: [pane] },
		...overrides,
	};
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

describe("getTaskAgentMeta", () => {
	it("resolves the default agent and config from the main pane", () => {
		const meta = getTaskAgentMeta(makeTask(), [claude, codex]);
		expect(meta.agent?.id).toBe("builtin-claude");
		expect(meta.config?.id).toBe("c2");
		expect(meta.configLabel).toBe("Opus 5.5 · Fast");
	});

	it("keeps the task's own pick when it has one", () => {
		const meta = getTaskAgentMeta(makeTask({ agentId: "builtin-codex", configId: "x1" }), [claude, codex]);
		expect(meta.agent?.id).toBe("builtin-codex");
	});

	it("shows no agent for a task with no worktree", () => {
		const meta = getTaskAgentMeta(makeTask({ worktreePath: null }), [claude, codex]);
		expect(meta.agent).toBeNull();
		expect(meta.configLabel).toBe("");
	});
});
