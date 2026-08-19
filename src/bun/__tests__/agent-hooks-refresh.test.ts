import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents", () => ({
	getAllAgents: vi.fn(async () => []),
	findConfig: vi.fn(() => undefined),
}));
vi.mock("../data", () => ({
	getProject: vi.fn(async () => ({ id: "project-1", autoReviewEnabled: false })),
}));
vi.mock("../../shared/agent-hooks", () => ({
	writeClaudeHooks: vi.fn(() => false),
}));

import { findConfig, getAllAgents } from "../agents";
import { getProject } from "../data";
import { writeClaudeHooks } from "../../shared/agent-hooks";
import { refreshClaudeHooksForTask } from "../agent-hooks-refresh";
import type { CodingAgent, Project, Task } from "../../shared/types";

const CLAUDE_AGENT = { id: "agent-1", baseCommand: "claude", configurations: [] } as unknown as CodingAgent;

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "task-1",
		projectId: "project-1",
		worktreePath: "/tmp/worktree",
		agentId: "agent-1",
		configId: null,
		...overrides,
	} as Task;
}

beforeEach(() => {
	vi.mocked(getAllAgents).mockResolvedValue([CLAUDE_AGENT]);
	vi.mocked(findConfig).mockReturnValue(undefined);
	vi.mocked(getProject).mockResolvedValue({ id: "project-1", autoReviewEnabled: false } as Project);
	vi.mocked(writeClaudeHooks).mockReturnValue(false);
});

afterEach(() => vi.clearAllMocks());

describe("refreshClaudeHooksForTask", () => {
	it("re-installs the hooks for a Claude task", async () => {
		await refreshClaudeHooksForTask(task());
		expect(writeClaudeHooks).toHaveBeenCalledWith("/tmp/worktree", { stopTarget: "review-by-user" });
	});

	it("carries the project's auto-review setting into the Stop target", async () => {
		vi.mocked(getProject).mockResolvedValue({ id: "project-1", autoReviewEnabled: true } as Project);
		await refreshClaudeHooksForTask(task());
		expect(writeClaudeHooks).toHaveBeenCalledWith("/tmp/worktree", { stopTarget: "review-by-ai" });
	});

	it("honours a configuration's baseCommandOverride", async () => {
		vi.mocked(findConfig).mockReturnValue({ id: "c1", baseCommandOverride: "codex" } as never);
		await refreshClaudeHooksForTask(task());
		expect(writeClaudeHooks).not.toHaveBeenCalled();
	});

	// Codex reads its dev3 hooks from a -c override fixed at launch, so rewriting
	// its hooks file mid-session would change nothing.
	it("does nothing for a non-Claude agent", async () => {
		vi.mocked(getAllAgents).mockResolvedValue([
			{ id: "agent-1", baseCommand: "codex", configurations: [] } as unknown as CodingAgent,
		]);
		await refreshClaudeHooksForTask(task());
		expect(writeClaudeHooks).not.toHaveBeenCalled();
	});

	// A wrapper script or shell alias cannot be recognized by name; the agent's
	// declared CLI family is what makes it get hooks at all.
	it("re-installs the hooks for a wrapper command that declares the Claude family", async () => {
		vi.mocked(getAllAgents).mockResolvedValue([
			{ id: "agent-1", baseCommand: "my-claude", configurations: [], agentFamily: "claude" } as unknown as CodingAgent,
		]);
		await refreshClaudeHooksForTask(task());
		expect(writeClaudeHooks).toHaveBeenCalledWith("/tmp/worktree", { stopTarget: "review-by-user" });
	});

	it("writes nothing for a wrapper command with no declared family", async () => {
		vi.mocked(getAllAgents).mockResolvedValue([
			{ id: "agent-1", baseCommand: "my-claude", configurations: [] } as unknown as CodingAgent,
		]);
		await refreshClaudeHooksForTask(task());
		expect(writeClaudeHooks).not.toHaveBeenCalled();
	});

	it("honours an explicit opt-out on a recognized command", async () => {
		vi.mocked(getAllAgents).mockResolvedValue([
			{ id: "agent-1", baseCommand: "claude", configurations: [], agentFamily: "none" } as unknown as CodingAgent,
		]);
		await refreshClaudeHooksForTask(task());
		expect(writeClaudeHooks).not.toHaveBeenCalled();
	});

	it.each([
		["the task has no worktree", { worktreePath: null }],
		["the task has no agent", { agentId: null }],
	])("does nothing and reads nothing when %s", async (_label, overrides) => {
		await refreshClaudeHooksForTask(task(overrides as Partial<Task>));
		expect(writeClaudeHooks).not.toHaveBeenCalled();
		expect(getProject).not.toHaveBeenCalled();
	});

	it("does nothing when the agent id no longer resolves", async () => {
		vi.mocked(getAllAgents).mockResolvedValue([]);
		await refreshClaudeHooksForTask(task());
		expect(writeClaudeHooks).not.toHaveBeenCalled();
	});

	// A failure here must never swallow the user's message.
	it.each([
		["the agent registry", () => vi.mocked(getAllAgents).mockRejectedValue(new Error("boom"))],
		["the project lookup", () => vi.mocked(getProject).mockRejectedValue(new Error("boom"))],
		["the write itself", () => vi.mocked(writeClaudeHooks).mockImplementation(() => { throw new Error("EACCES"); })],
	])("does not throw when %s fails", async (_label, breakIt) => {
		breakIt();
		await expect(refreshClaudeHooksForTask(task())).resolves.toBeUndefined();
	});
});
