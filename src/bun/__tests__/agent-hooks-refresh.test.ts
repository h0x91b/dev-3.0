import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents", () => ({
	getAllAgents: vi.fn(async () => []),
	findConfig: vi.fn(() => undefined),
}));
vi.mock("../data", () => ({
	getProject: vi.fn(async () => ({ id: "project-1", autoReviewEnabled: false })),
}));
vi.mock("../../shared/agent-hooks", () => ({
	isDev3OwnedFolder: vi.fn(() => true),
	writeClaudeHooks: vi.fn(() => ({ written: false, skippedSymlink: null })),
}));

import { findConfig, getAllAgents } from "../agents";
import { getProject } from "../data";
import { isDev3OwnedFolder, writeClaudeHooks } from "../../shared/agent-hooks";
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
	vi.mocked(writeClaudeHooks).mockReturnValue({ written: false, skippedSymlink: null });
	vi.mocked(isDev3OwnedFolder).mockReturnValue(true);
});

afterEach(() => vi.clearAllMocks());

describe("refreshClaudeHooksForTask", () => {
	it("re-installs the hooks for a Claude task, one on the global default, and a wrapper declaring the Claude family", async () => {
		await refreshClaudeHooksForTask(task());
		expect(writeClaudeHooks, "claude").toHaveBeenCalledWith("/tmp/worktree", { stopTarget: "review-by-user" });

		// The global default's agent lives on the task's main pane.
		vi.mocked(writeClaudeHooks).mockClear();
		const pane = { agentCmd: "claude", sessionId: null, agentId: "agent-1", configId: null, agentFromDefault: true };
		await refreshClaudeHooksForTask(task({ agentId: null, sessionState: { panes: [pane] } }));
		expect(writeClaudeHooks, "global default").toHaveBeenCalledWith("/tmp/worktree", { stopTarget: "review-by-user" });

		// A wrapper script or shell alias cannot be recognized by name; the agent's
		// declared CLI family is what makes it get hooks at all.
		vi.mocked(writeClaudeHooks).mockClear();
		vi.mocked(getAllAgents).mockResolvedValue([
			{ id: "agent-1", baseCommand: "my-claude", configurations: [], agentFamily: "claude" } as unknown as CodingAgent,
		]);
		await refreshClaudeHooksForTask(task());
		expect(writeClaudeHooks, "declared wrapper").toHaveBeenCalledWith("/tmp/worktree", { stopTarget: "review-by-user" });
	});

	// #2127: a task promoted to coordinator mid-session gets its Stop target fixed on the next prompt.
	it("carries auto-review into the Stop target, but keeps a coordinator task out of it", async () => {
		vi.mocked(getProject).mockResolvedValue({ id: "project-1", autoReviewEnabled: true } as Project);
		await refreshClaudeHooksForTask(task());
		expect(writeClaudeHooks).toHaveBeenLastCalledWith("/tmp/worktree", { stopTarget: "review-by-ai" });
		await refreshClaudeHooksForTask(task({ taskType: "coordinator" }));
		expect(writeClaudeHooks).toHaveBeenLastCalledWith("/tmp/worktree", { stopTarget: "review-by-user" });
	});

	it("writes nothing for a folder dev3 does not own, or an agent that is not (or no longer) Claude", async () => {
		const agentWith = (fields: Record<string, unknown>) => () => vi.mocked(getAllAgents).mockResolvedValue([
			{ id: "agent-1", configurations: [], ...fields } as unknown as CodingAgent,
		]);
		const cases: [string, () => void, Partial<Task>?][] = [
			// Its hooks travel in --settings.
			["a folder dev3 does not own", () => vi.mocked(isDev3OwnedFolder).mockReturnValue(false), { worktreePath: "/home/me/notes" }],
			["a configuration's baseCommandOverride", () => vi.mocked(findConfig).mockReturnValue({ id: "c1", baseCommandOverride: "codex" } as never)],
			// Codex reads its dev3 hooks from a -c override fixed at launch.
			["a non-Claude agent", agentWith({ baseCommand: "codex" })],
			["a wrapper with no declared family", agentWith({ baseCommand: "my-claude" })],
			["an explicit opt-out on a recognized command", agentWith({ baseCommand: "claude", agentFamily: "none" })],
			["an agent id that no longer resolves", () => vi.mocked(getAllAgents).mockResolvedValue([])],
		];
		for (const [label, arrange, overrides] of cases) {
			vi.mocked(getAllAgents).mockResolvedValue([CLAUDE_AGENT]);
			vi.mocked(findConfig).mockReturnValue(undefined);
			vi.mocked(isDev3OwnedFolder).mockReturnValue(true);
			arrange();
			await refreshClaudeHooksForTask(task(overrides));
			expect(writeClaudeHooks, label).not.toHaveBeenCalled();
		}
	});

	it("does nothing and reads nothing when the task has no worktree or no agent", async () => {
		for (const overrides of [{ worktreePath: null }, { agentId: null }]) {
			await refreshClaudeHooksForTask(task(overrides as Partial<Task>));
			expect(writeClaudeHooks, JSON.stringify(overrides)).not.toHaveBeenCalled();
			expect(getProject, JSON.stringify(overrides)).not.toHaveBeenCalled();
		}
	});

	// A failure here must never swallow the user's message.
	it("does not throw when the agent registry, the project lookup or the write itself fails", async () => {
		const breakers: [string, () => void][] = [
			["the agent registry", () => vi.mocked(getAllAgents).mockRejectedValueOnce(new Error("boom"))],
			["the project lookup", () => vi.mocked(getProject).mockRejectedValueOnce(new Error("boom"))],
			["the write itself", () => vi.mocked(writeClaudeHooks).mockImplementationOnce(() => { throw new Error("EACCES"); })],
		];
		for (const [label, breakIt] of breakers) {
			breakIt();
			await expect(refreshClaudeHooksForTask(task()), label).resolves.toBeUndefined();
		}
	});
});
