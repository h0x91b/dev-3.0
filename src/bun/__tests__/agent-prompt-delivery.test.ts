import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The routing seam: which backend's delivery path a task's persisted
// `terminalBackend` marker selects. Both adapters are mocked so the assertions
// are purely about routing — and about the two paths NEVER crossing.
vi.mock("../agent-prompt", () => ({
	sendPromptToAgentPane: vi.fn(async () => true),
	sendPromptToPane: vi.fn(async () => true),
	holdMessageForPane: vi.fn(async () => true),
}));
vi.mock("../agent-message-target", () => ({
	resolveMainAgentTarget: vi.fn(),
	addressedAgentRefusal: vi.fn(async () => null),
}));
vi.mock("../agent-prompt-native", () => ({
	sendPromptToNativeAgentPane: vi.fn(async () => true),
	sendPromptToNativePane: vi.fn(async () => true),
}));
vi.mock("../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	taskSessionName: (taskId: string) => `dev3-task-${taskId}`,
}));
vi.mock("../agent-hooks-refresh", () => ({
	refreshClaudeHooksForTask: vi.fn(async () => {}),
}));

import { holdMessageForPane, sendPromptToAgentPane, sendPromptToPane } from "../agent-prompt";
import { addressedAgentRefusal, resolveMainAgentTarget } from "../agent-message-target";
import { sendPromptToNativeAgentPane, sendPromptToNativePane } from "../agent-prompt-native";
import { refreshClaudeHooksForTask } from "../agent-hooks-refresh";
import { deliverAgentPrompt } from "../agent-prompt-delivery";
import { resetTypedPromptClaims, typedPromptClaimCount } from "../agent-typed-prompt-claims";
import type { PaneSessionEntry, ScheduledMessageAuthor, Task } from "../../shared/types";

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

/** A `dev3 message` accepted by dev3 with nothing typed yet. */
const HELD = { status: "held", detail: "held until the pane goes quiet" } as const;

beforeEach(() => {
	vi.mocked(sendPromptToAgentPane).mockResolvedValue(TMUX_DELIVERED);
	vi.mocked(sendPromptToPane).mockResolvedValue(TMUX_DELIVERED);
	vi.mocked(sendPromptToNativeAgentPane).mockResolvedValue(NATIVE_UNCONFIRMED);
	vi.mocked(sendPromptToNativePane).mockResolvedValue(NATIVE_UNCONFIRMED);
	vi.mocked(holdMessageForPane).mockResolvedValue(HELD);
	vi.mocked(resolveMainAgentTarget).mockResolvedValue({ ok: true, paneId: "%1", author: null });
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
		expect(sendPromptToNativeAgentPane).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID }), "check CI", {});
	});

	it("routes a concrete pane target to the native pane path", async () => {
		await deliverAgentPrompt(nativeTask(), "ls", { kind: "pane", paneId: "pane-2" });
		expect(sendPromptToNativePane).toHaveBeenCalledWith(
			expect.objectContaining({ id: TASK_ID }),
			"pane-2",
			"ls",
			{},
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

describe("deliverAgentPrompt — hook re-assertion", () => {
	it("re-asserts the Claude hooks before the prompt is typed, on either backend", async () => {
		for (const t of [task(), task({ terminalBackend: "native" } as Partial<Task>)]) {
			vi.clearAllMocks();
			await deliverAgentPrompt(t, "check CI");
			expect(refreshClaudeHooksForTask).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID }));
		}
	});

	it("re-asserts them for a concrete pane target too", async () => {
		await deliverAgentPrompt(task(), "check CI", { kind: "pane", paneId: "%4" });
		expect(refreshClaudeHooksForTask).toHaveBeenCalledTimes(1);
	});
});

describe("deliverAgentPrompt — a held dev3 message", () => {
	const AUTHOR: ScheduledMessageAuthor = { paneId: "%4", sessionId: null, paneToken: "srv-1", agentProcess: "321@Mon Oct 26 10:00:00 2026" };

	it("holds a tmux agent target for the MAIN agent's pane, never the focus-following one", async () => {
		await expect(deliverAgentPrompt(task(), "check CI", { kind: "agent" }, { hold: true })).resolves.toMatchObject({
			status: "held",
		});
		expect(resolveMainAgentTarget).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID }));
		expect(holdMessageForPane).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID }), "%1", "check CI", undefined, undefined, undefined);
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
		expect(sendPromptToPane).not.toHaveBeenCalled();
	});

	it("refuses, typing nothing, when the main agent is gone — even with another agent live", async () => {
		vi.mocked(resolveMainAgentTarget).mockResolvedValue({ ok: false, detail: "the task's main agent has exited; not sent to another agent." });
		await expect(deliverAgentPrompt(task(), "check CI", { kind: "agent" }, { hold: true })).resolves.toEqual({
			status: "not-delivered",
			reason: "pane-absent",
			detail: "the task's main agent has exited; not sent to another agent.",
			paneId: "",
		});
		expect(holdMessageForPane).not.toHaveBeenCalled();
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
	});

	it("binds the main agent it resolved, so the release checks it is still that agent", async () => {
		vi.mocked(resolveMainAgentTarget).mockResolvedValue({ ok: true, paneId: "%1", author: { ...AUTHOR, paneId: "%1" } });
		await deliverAgentPrompt(task(), "check CI", { kind: "agent" }, { hold: true });
		const verify = vi.mocked(holdMessageForPane).mock.calls[0]![4]!;
		vi.mocked(addressedAgentRefusal).mockResolvedValueOnce("the addressed agent is no longer running");
		await expect(verify()).resolves.toBe("the addressed agent is no longer running");
		expect(addressedAgentRefusal).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID }), { ...AUTHOR, paneId: "%1" }, "%1");
	});

	it("sends a concrete tmux pane target down the hold path, unbound", async () => {
		await deliverAgentPrompt(task(), "check CI", { kind: "pane", paneId: "%4" }, { hold: true });
		expect(holdMessageForPane).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID }), "%4", "check CI", undefined, undefined, undefined);
		expect(resolveMainAgentTarget).not.toHaveBeenCalled();
		expect(sendPromptToPane).not.toHaveBeenCalled();
	});

	it("binds an addressed pane target to its agent, checked again at release", async () => {
		await deliverAgentPrompt(task(), "check CI", { kind: "pane", paneId: "%4" }, { hold: true, author: AUTHOR });
		const verify = vi.mocked(holdMessageForPane).mock.calls[0]![4];
		expect(verify).toBeTypeOf("function");
		await expect(verify!()).resolves.toBeNull();
		expect(addressedAgentRefusal).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID }), AUTHOR, "%4");
	});

	it("offers a tmux hold to the agent's tool hook, with the board trailer, and takes back the typed receipt once drained", async () => {
		resetTypedPromptClaims();
		const delivered = vi.fn();
		const epilogue = vi.fn(async () => "board");
		await deliverAgentPrompt(task(), "check CI", { kind: "agent" }, { hold: true, epilogue, hook: { text: "inline envelope", delivered } });
		const hook = vi.mocked(holdMessageForPane).mock.calls[0]![5]!;
		expect(hook.text).toBe("inline envelope");
		expect(hook.trailer).toBe(epilogue);
		expect(typedPromptClaimCount(TASK_ID)).toBe(1);
		hook.delivered();
		expect(delivered).toHaveBeenCalledTimes(1);
		expect(typedPromptClaimCount(TASK_ID)).toBe(0);
	});

	it("never offers a native hold to the tool hook: the native arm keeps the typed path", async () => {
		vi.mocked(resolveMainAgentTarget).mockResolvedValue({ ok: true, paneId: "pane-1", author: null });
		vi.mocked(sendPromptToNativePane).mockResolvedValue(HELD);
		await deliverAgentPrompt(task({ terminalBackend: "native" } as Partial<Task>), "check CI", { kind: "agent" }, {
			hold: true,
			hook: { text: "inline envelope", delivered: vi.fn() },
		});
		expect(vi.mocked(sendPromptToNativePane).mock.calls[0]![3]).not.toHaveProperty("hook");
	});

	it("passes the hold and the binding on to the native arm, which owns its own holding", async () => {
		vi.mocked(resolveMainAgentTarget).mockResolvedValue({ ok: true, paneId: "pane-1", author: { ...AUTHOR, paneId: "pane-1" } });
		vi.mocked(sendPromptToNativePane).mockResolvedValue(HELD);
		await expect(
			deliverAgentPrompt(task({ terminalBackend: "native" } as Partial<Task>), "check CI", { kind: "agent" }, { hold: true }),
		).resolves.toMatchObject({ status: "held" });
		expect(sendPromptToNativePane).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID }), "pane-1", "check CI", {
			hold: true,
			verify: expect.any(Function),
		});
		expect(sendPromptToNativeAgentPane).not.toHaveBeenCalled();
		expect(holdMessageForPane).not.toHaveBeenCalled();
	});
});
