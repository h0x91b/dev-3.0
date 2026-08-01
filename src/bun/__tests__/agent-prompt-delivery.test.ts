import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The routing seam: which backend's delivery path a task's persisted
// `terminalBackend` marker selects. Both adapters are mocked so the assertions
// are purely about routing — and about the two paths NEVER crossing.
vi.mock("../agent-prompt", () => ({
	sendPromptToAgentPane: vi.fn(async () => true),
	sendPromptToPane: vi.fn(async () => true),
}));
vi.mock("../agent-prompt-native", () => ({
	sendPromptToNativeAgentPane: vi.fn(async () => true),
	sendPromptToNativePane: vi.fn(async () => true),
}));
vi.mock("../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	taskSessionName: (taskId: string) => `dev3-task-${taskId}`,
}));

import { sendPromptToAgentPane, sendPromptToPane } from "../agent-prompt";
import { sendPromptToNativeAgentPane, sendPromptToNativePane } from "../agent-prompt-native";
import { deliverAgentPrompt } from "../agent-prompt-delivery";
import type { PaneSessionEntry, Task } from "../../shared/types";

const TASK_ID = "task-1234";
const PANES: PaneSessionEntry[] = [
	{ paneId: "%1", agentCmd: "claude", sessionId: null, agentId: null, configId: null },
];

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: TASK_ID,
		projectId: "project-1",
		worktreePath: "/tmp/worktree",
		sessionState: { panes: PANES },
		...overrides,
	} as Task;
}

beforeEach(() => {
	vi.mocked(sendPromptToAgentPane).mockResolvedValue(true);
	vi.mocked(sendPromptToPane).mockResolvedValue(true);
	vi.mocked(sendPromptToNativeAgentPane).mockResolvedValue(true);
	vi.mocked(sendPromptToNativePane).mockResolvedValue(true);
});

afterEach(() => vi.clearAllMocks());

describe("deliverAgentPrompt — tmux tasks (regression)", () => {
	it("routes an unmarked legacy task through the tmux path with the exact old arguments", async () => {
		await expect(deliverAgentPrompt(task(), "check CI")).resolves.toBe(true);
		expect(sendPromptToAgentPane).toHaveBeenCalledWith(`dev3-task-${TASK_ID}`, "dev3", "check CI", PANES);
		expect(sendPromptToNativeAgentPane).not.toHaveBeenCalled();
	});

	it("routes an explicitly tmux-marked task through the tmux path", async () => {
		await deliverAgentPrompt(task({ terminalBackend: "tmux" } as Partial<Task>), "check CI");
		expect(sendPromptToAgentPane).toHaveBeenCalledTimes(1);
		expect(sendPromptToNativeAgentPane).not.toHaveBeenCalled();
	});

	it("honours the task's own tmux socket", async () => {
		await deliverAgentPrompt(task({ tmuxSocket: "custom" } as Partial<Task>), "check CI");
		expect(sendPromptToAgentPane).toHaveBeenCalledWith(`dev3-task-${TASK_ID}`, "custom", "check CI", PANES);
	});

	it("routes a concrete tmux pane target to the pane path", async () => {
		await deliverAgentPrompt(task(), "check CI", { kind: "pane", paneId: "%4" });
		expect(sendPromptToPane).toHaveBeenCalledWith(`dev3-task-${TASK_ID}`, "dev3", "%4", "check CI");
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
	});

	it("propagates a tmux failure as false", async () => {
		vi.mocked(sendPromptToAgentPane).mockResolvedValue(false);
		await expect(deliverAgentPrompt(task(), "check CI")).resolves.toBe(false);
	});
});

describe("deliverAgentPrompt — native tasks", () => {
	const nativeTask = (extra: Partial<Task> = {}) =>
		task({ terminalBackend: "native", ...extra } as Partial<Task>);

	it("routes an agent target to the native agent pane", async () => {
		await expect(deliverAgentPrompt(nativeTask(), "check CI")).resolves.toBe(true);
		expect(sendPromptToNativeAgentPane).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID }), "check CI");
	});

	it("routes a concrete pane target to the native pane path", async () => {
		await deliverAgentPrompt(nativeTask(), "ls", { kind: "pane", paneId: "pane-2" });
		expect(sendPromptToNativePane).toHaveBeenCalledWith(
			expect.objectContaining({ id: TASK_ID }),
			"pane-2",
			"ls",
		);
	});

	it("NEVER falls back to tmux when native delivery fails", async () => {
		vi.mocked(sendPromptToNativeAgentPane).mockResolvedValue(false);
		await expect(deliverAgentPrompt(nativeTask(), "check CI")).resolves.toBe(false);
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
		expect(sendPromptToPane).not.toHaveBeenCalled();
	});

	it("ignores stale tmux session state left on a native task", async () => {
		await deliverAgentPrompt(nativeTask({ sessionState: { panes: PANES } }), "check CI");
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
	});
});

describe("deliverAgentPrompt — unusable backend marker", () => {
	it("throws instead of guessing a backend", async () => {
		await expect(
			deliverAgentPrompt(task({ terminalBackend: "screen" } as unknown as Partial<Task>), "check CI"),
		).rejects.toThrow(/terminalBackend/);
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
		expect(sendPromptToNativeAgentPane).not.toHaveBeenCalled();
	});
});
