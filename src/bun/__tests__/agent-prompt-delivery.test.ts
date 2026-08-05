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

/** What a tmux send that the server accepted looks like coming back from the seam. */
const TMUX_DELIVERED = { deliveryId: "d1", backend: "tmux", paneId: "%1", status: "delivered", acceptedThrough: 2 } as const;

/** The best a native write can ever report: the bytes went out, unacknowledged. */
const NATIVE_UNCONFIRMED = { status: "unconfirmed", reason: "unacknowledged" } as const;

beforeEach(() => {
	vi.mocked(sendPromptToAgentPane).mockResolvedValue(TMUX_DELIVERED);
	vi.mocked(sendPromptToPane).mockResolvedValue(TMUX_DELIVERED);
	vi.mocked(sendPromptToNativeAgentPane).mockResolvedValue(NATIVE_UNCONFIRMED);
	vi.mocked(sendPromptToNativePane).mockResolvedValue(NATIVE_UNCONFIRMED);
});

afterEach(() => vi.clearAllMocks());

describe("deliverAgentPrompt — tmux tasks (regression)", () => {
	it("routes an unmarked legacy task through the tmux path", async () => {
		await expect(deliverAgentPrompt(task(), "check CI")).resolves.toEqual({ status: "delivered" });
		expect(sendPromptToAgentPane).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID }), "check CI", PANES);
		expect(sendPromptToNativeAgentPane).not.toHaveBeenCalled();
	});

	it("routes an explicitly tmux-marked task through the tmux path", async () => {
		await deliverAgentPrompt(task({ terminalBackend: "tmux" } as Partial<Task>), "check CI");
		expect(sendPromptToAgentPane).toHaveBeenCalledTimes(1);
		expect(sendPromptToNativeAgentPane).not.toHaveBeenCalled();
	});

	it("honours the task's own tmux socket", async () => {
		await deliverAgentPrompt(task({ tmuxSocket: "custom" } as Partial<Task>), "check CI");
		expect(sendPromptToAgentPane).toHaveBeenCalledWith(
			expect.objectContaining({ id: TASK_ID, tmuxSocket: "custom" }),
			"check CI",
			PANES,
		);
	});

	it("routes a concrete tmux pane target to the pane path", async () => {
		await deliverAgentPrompt(task(), "check CI", { kind: "pane", paneId: "%4" });
		expect(sendPromptToPane).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID }), "%4", "check CI");
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
	});

	it("maps a proven tmux refusal to not-delivered, keeping its reason", async () => {
		vi.mocked(sendPromptToAgentPane).mockResolvedValue({
			deliveryId: "d1",
			backend: "tmux",
			paneId: "%1",
			status: "not-started",
			reason: "pane-dead",
			retryableAsNewDelivery: false,
		});
		await expect(deliverAgentPrompt(task(), "check CI")).resolves.toMatchObject({
			status: "not-delivered",
			reason: "pane-dead",
		});
	});

	it("maps a tmux send that stopped mid-program to unconfirmed, never to a failure", async () => {
		// The text stage went in and Enter did not, so the agent has the text sitting in
		// its input box: a caller that re-sent would submit it twice.
		vi.mocked(sendPromptToAgentPane).mockResolvedValue({
			deliveryId: "d1",
			backend: "tmux",
			paneId: "%1",
			status: "partial",
			acceptedThrough: 1,
			uncertainStep: null,
			reason: "incarnation-changed",
		});
		await expect(deliverAgentPrompt(task(), "check CI")).resolves.toMatchObject({ status: "unconfirmed" });
	});
});

describe("deliverAgentPrompt — native tasks", () => {
	const nativeTask = (extra: Partial<Task> = {}) =>
		task({ terminalBackend: "native", ...extra } as Partial<Task>);

	it("routes an agent target to the native agent pane", async () => {
		await expect(deliverAgentPrompt(nativeTask(), "check CI")).resolves.toMatchObject({ status: "unconfirmed" });
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
		vi.mocked(sendPromptToNativeAgentPane).mockResolvedValue({ status: "not-delivered", reason: "pane-absent" });
		await expect(deliverAgentPrompt(nativeTask(), "check CI")).resolves.toMatchObject({ status: "not-delivered" });
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
