import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit-test agent-prompt against a mock tmux singleton (the standard seam for
// handler-level tests). The real ../tmux module has module-load side effects
// (config file writes, shim sanitation), so a full factory mock keeps this fast
// and isolated; PANE_ID_FORMAT is only forwarded to the mocked listPanes.
//
// Delivery now runs through the guarded pane-input seam (decision 201), so the
// mock covers the two calls that seam makes: observePane to pin the incarnation,
// and sendKeysGuarded to perform each stage.
vi.mock("../tmux", () => ({
	tmux: {
		activePaneId: vi.fn(),
		listPanes: vi.fn(),
		showOption: vi.fn(),
		setPaneOption: vi.fn(),
		observePane: vi.fn(),
		sendKeysGuarded: vi.fn(),
	},
	isTmuxSpawnError: (err: unknown) => (err as { spawnFailure?: boolean })?.spawnFailure === true,
	isTmuxTimeoutError: (err: unknown) => (err as { timedOut?: boolean })?.timedOut === true,
	taskSessionName: (taskId: string) => `dev3-${taskId.slice(0, 8)}`,
	DEFAULT_TMUX_SOCKET: "dev3",
	PANE_ID_FORMAT: { sentinel: "pane-id-format" },
	TMUX_AGENT_PANE_OPTION: "@dev3_agent",
	TMUX_LAST_AGENT_PANE_OPTION: "@dev3_last_agent_pane",
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { tmux } from "../tmux";
import {
	AGENT_PROMPT_ENTER_DELAY_MS,
	holdMessageForAgentPane,
	holdMessageForPane,
	sendPromptToAgentPane,
	sendPromptToPane,
} from "../agent-prompt";
import { deferHeldAgentMessagesForTask, flushHeldAgentMessagesForTask, resetAgentMessageHolds } from "../agent-message-hold";
import {
	AGENT_MESSAGE_HOLD_CEILING_MS,
	AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS,
	AGENT_MESSAGE_HOLD_IDLE_MS,
} from "../../shared/agent-message-hold-timing";
import type { PaneSessionEntry, Task } from "../../shared/types";

const TASK_ID = "1234abcd-0000-4000-8000-000000000001";
const SESSION = `dev3-${TASK_ID.slice(0, 8)}`;
const SOCKET = "dev3";
const SERVER_TOKEN = "srv-token-1";

/** An unmarked task, which `taskTerminalBackendIdentity` reads as tmux. */
const TASK = { id: TASK_ID, tmuxSocket: SOCKET } as Task;

function agentPane(paneId: string | null): PaneSessionEntry {
	return { paneId, agentCmd: "claude", sessionId: null, agentId: null, configId: null } as PaneSessionEntry;
}

/** The chunks handed to the guard for call `n` — what actually goes into the pane. */
function sentChunks(n: number): unknown {
	return vi.mocked(tmux.sendKeysGuarded).mock.calls[n]?.[0]?.chunks;
}

function sentPane(n: number): unknown {
	return vi.mocked(tmux.sendKeysGuarded).mock.calls[n]?.[0]?.pane;
}

/**
 * Run a whole prompt program: it spans the inter-stage delay, so the timers must
 * advance before the promise can settle.
 */
async function runPrompt<T>(started: Promise<T>): Promise<T> {
	await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS);
	return started;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(tmux.activePaneId).mockResolvedValue("%1");
	vi.mocked(tmux.listPanes).mockResolvedValue([{ paneId: "%1" }] as never);
	vi.mocked(tmux.showOption).mockResolvedValue(""); // no last-focused agent recorded
	vi.mocked(tmux.setPaneOption).mockResolvedValue(undefined);
	vi.mocked(tmux.observePane).mockResolvedValue({ kind: "present", sessionName: SESSION, serverToken: SERVER_TOKEN } as never);
	vi.mocked(tmux.sendKeysGuarded).mockResolvedValue({ sent: true } as never);
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("sendPromptToAgentPane — delivery", () => {
	it("types the prompt, then sends Enter as a separate guarded stage", async () => {
		const delivery = await runPrompt(sendPromptToAgentPane(TASK, "check CI", [agentPane("%1")]));

		expect(delivery).toMatchObject({ status: "delivered" });
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
		expect(sentChunks(0)).toEqual([{ literal: "check CI" }]);
		expect(sentChunks(1)).toEqual([{ keys: ["Enter"] }]);
	});

	it("pins the pane to the session and server generation it was sighted in", async () => {
		await runPrompt(sendPromptToAgentPane(TASK, "check CI", [agentPane("%1")]));

		expect(vi.mocked(tmux.sendKeysGuarded).mock.calls[0]?.[0]).toMatchObject({
			pane: "%1",
			session: SESSION,
			serverToken: SERVER_TOKEN,
		});
	});

	it("TYPES a prompt whose text is a tmux key name instead of pressing it", async () => {
		// Without -l, tmux resolves an argument as a key name FIRST, so a message whose
		// text is exactly "C-c" would interrupt the agent rather than reach its input
		// box. The text must therefore arrive as a literal chunk, never as keys.
		await runPrompt(sendPromptToAgentPane(TASK, "C-c", [agentPane("%1")]));

		expect(sentChunks(0)).toEqual([{ literal: "C-c" }]);
		expect(sentChunks(0)).not.toEqual([{ keys: ["C-c"] }]);
	});

	it("never sends Enter after a stage the guard refused", async () => {
		// The guard is false inside the server's own turn: the pane moved, restarted,
		// died, or sits in copy mode. Counting EXECUTIONS is the assertion — a verdict
		// alone cannot tell "text went in, Enter did not" from "nothing went in".
		vi.mocked(tmux.sendKeysGuarded).mockResolvedValue({ sent: false } as never);

		const delivery = await runPrompt(sendPromptToAgentPane(TASK, "check CI", [agentPane("%1")]));

		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(1);
		expect(delivery).toMatchObject({ status: "not-started", reason: "incarnation-changed" });
	});

	it("reports a spawn failure as nothing-sent, with no second stage", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockRejectedValue(Object.assign(new Error("tmux: not found"), { spawnFailure: true }));

		const delivery = await runPrompt(sendPromptToAgentPane(TASK, "check CI", [agentPane("%1")]));

		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(1);
		expect(delivery).toMatchObject({ status: "not-started", reason: "backend-failure" });
	});

	it("sends nothing when no target pane can be resolved", async () => {
		vi.mocked(tmux.activePaneId).mockResolvedValue(null);
		vi.mocked(tmux.listPanes).mockResolvedValue([] as never);

		const delivery = await runPrompt(sendPromptToAgentPane(TASK, "check CI", [agentPane("%9")]));

		expect(delivery).toMatchObject({ status: "not-started", reason: "pane-absent" });
		expect(tmux.observePane).not.toHaveBeenCalled();
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
	});
});

describe("sendPromptToAgentPane — target resolution", () => {
	const TWO_AGENTS = [agentPane("%1"), agentPane("%2")];

	beforeEach(() => {
		// Two live agent panes; tmux's active pane is %1.
		vi.mocked(tmux.listPanes).mockResolvedValue([{ paneId: "%1" }, { paneId: "%2" }] as never);
		vi.mocked(tmux.activePaneId).mockResolvedValue("%1");
	});

	it("routes to the last-focused agent pane the hook recorded, not the active pane", async () => {
		vi.mocked(tmux.showOption).mockResolvedValue("%2");
		await runPrompt(sendPromptToAgentPane(TASK, "ping", TWO_AGENTS));
		expect(sentPane(0)).toBe("%2");
	});

	it("ignores a recorded last-focused pane that is no longer live and falls back to the active pane", async () => {
		vi.mocked(tmux.showOption).mockResolvedValue("%9"); // dead / unknown
		await runPrompt(sendPromptToAgentPane(TASK, "ping", TWO_AGENTS));
		expect(sentPane(0)).toBe("%1");
	});

	it("never types into a focused shell split: falls back to a live agent pane", async () => {
		// %3 is a live shell split, not in the agent registry. tmux would report the
		// send as delivered either way, so aiming there loses the prompt silently.
		vi.mocked(tmux.listPanes).mockResolvedValue([{ paneId: "%1" }, { paneId: "%2" }, { paneId: "%3" }] as never);
		vi.mocked(tmux.showOption).mockResolvedValue("%3");
		vi.mocked(tmux.activePaneId).mockResolvedValue("%3");
		await runPrompt(sendPromptToAgentPane(TASK, "ping", TWO_AGENTS));
		expect(sentPane(0)).toBe("%1");
	});

	it("keeps honouring the focus when the focused pane is itself an agent pane", async () => {
		vi.mocked(tmux.listPanes).mockResolvedValue([{ paneId: "%1" }, { paneId: "%2" }, { paneId: "%3" }] as never);
		vi.mocked(tmux.showOption).mockResolvedValue("");
		vi.mocked(tmux.activePaneId).mockResolvedValue("%2");
		await runPrompt(sendPromptToAgentPane(TASK, "ping", TWO_AGENTS));
		expect(sentPane(0)).toBe("%2");
	});

	it("marks live agent panes with the focus-hook option (self-heal)", async () => {
		vi.mocked(tmux.showOption).mockResolvedValue("");
		await runPrompt(sendPromptToAgentPane(TASK, "ping", TWO_AGENTS));
		expect(tmux.setPaneOption).toHaveBeenCalledWith("%1", "@dev3_agent", "1", { socket: SOCKET, bestEffort: true });
		expect(tmux.setPaneOption).toHaveBeenCalledWith("%2", "@dev3_agent", "1", { socket: SOCKET, bestEffort: true });
	});

	it("targets the single live agent unconditionally when nothing is recorded", async () => {
		vi.mocked(tmux.listPanes).mockResolvedValue([{ paneId: "%2" }, { paneId: "%5" }] as never);
		vi.mocked(tmux.activePaneId).mockResolvedValue("%5"); // a focused shell
		vi.mocked(tmux.showOption).mockResolvedValue("");
		await runPrompt(sendPromptToAgentPane(TASK, "ping", [agentPane("%2")]));
		expect(sentPane(0)).toBe("%2");
	});
});

describe("sendPromptToPane — concrete pane target", () => {
	it("delivers to a live pane", async () => {
		const delivery = await runPrompt(sendPromptToPane(TASK, "%1", "hello"));

		expect(delivery).toMatchObject({ status: "delivered" });
		expect(sentChunks(0)).toEqual([{ literal: "hello" }]);
	});

	it("keeps an absent pane distinct from a dead one, and sends in neither case", async () => {
		vi.mocked(tmux.observePane).mockResolvedValue({ kind: "absent" } as never);
		await expect(runPrompt(sendPromptToPane(TASK, "%42", "hello"))).resolves.toMatchObject({
			status: "not-started",
			reason: "pane-absent",
		});

		vi.mocked(tmux.observePane).mockResolvedValue({
			kind: "dead",
			sessionName: SESSION,
			serverToken: SERVER_TOKEN,
		} as never);
		await expect(runPrompt(sendPromptToPane(TASK, "%42", "hello"))).resolves.toMatchObject({
			status: "not-started",
			reason: "pane-dead",
		});

		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
	});

	it("refuses a pane that belongs to another task's session", async () => {
		vi.mocked(tmux.observePane).mockResolvedValue({
			kind: "present",
			sessionName: "dev3-someone-else",
			serverToken: SERVER_TOKEN,
		} as never);

		await expect(runPrompt(sendPromptToPane(TASK, "%1", "hello"))).resolves.toMatchObject({
			status: "not-started",
			reason: "pane-absent",
		});
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
	});
});

describe("the held dev3 message — nothing reaches the pane until it goes quiet", () => {
	afterEach(() => resetAgentMessageHolds());

	it("types NOTHING on arrival, then the text and one Enter after the quiet window", async () => {
		const delivery = await holdMessageForAgentPane(TASK, "check CI", [agentPane("%1")]);

		expect(delivery).toMatchObject({ status: "held" });
		// The user may be mid-word: not one byte may go into the pane yet, and the
		// 800ms hand-off gap must not smuggle one in either.
		await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
		expect(sentChunks(0)).toEqual([{ literal: "check CI" }]);
		expect(sentChunks(1)).toEqual([{ keys: ["Enter"] }]);
		expect(sentPane(1)).toBe("%1");
	});

	it("stacks three messages into three pastes and ONE Enter", async () => {
		for (const text of ["one", "two", "three"]) {
			await holdMessageForAgentPane(TASK, text, [agentPane("%1")]);
			await vi.advanceTimersByTimeAsync(4_000);
		}
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(4);
		expect(sentChunks(0)).toEqual([{ literal: "one" }]);
		expect(sentChunks(1)).toEqual([{ literal: "two" }]);
		expect(sentChunks(2)).toEqual([{ literal: "three" }]);
		expect(sentChunks(3)).toEqual([{ keys: ["Enter"] }]);
	});

	it("keeps the pane clean while the user types, with no ceiling on his hold", async () => {
		await holdMessageForAgentPane(TASK, "check CI", [agentPane("%1")]);

		// Continuous typing for twice the ceiling: his half-written line is untouched.
		let elapsed = 0;
		while (elapsed < AGENT_MESSAGE_HOLD_CEILING_MS * 2) {
			await vi.advanceTimersByTimeAsync(1_000);
			elapsed += 1_000;
			deferHeldAgentMessagesForTask(TASK_ID);
		}
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
	});

	it("keeps the pane clean through a pause to think, then lands on the human window", async () => {
		await holdMessageForAgentPane(TASK, "check CI", [agentPane("%1")]);
		deferHeldAgentMessagesForTask(TASK_ID);

		// Three message windows of silence is still just a pause in his own line.
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 3);
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
	});

	it("lands the moment the user submits his own line", async () => {
		await holdMessageForAgentPane(TASK, "check CI", [agentPane("%1")]);
		flushHeldAgentMessagesForTask(TASK_ID);
		await vi.advanceTimersByTimeAsync(0);

		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
		expect(sentChunks(0)).toEqual([{ literal: "check CI" }]);
		expect(sentChunks(1)).toEqual([{ keys: ["Enter"] }]);
	});

	it("pins the pane when the hold releases, so a dead pane types nothing at all", async () => {
		await holdMessageForAgentPane(TASK, "check CI", [agentPane("%1")]);
		vi.mocked(tmux.observePane).mockResolvedValue({ kind: "absent" } as never);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
	});

	it("sends no Enter when the text itself did not land", async () => {
		// A refused text stage leaves an unknown input box, so an Enter into it would
		// submit whatever is sitting there.
		vi.mocked(tmux.sendKeysGuarded).mockResolvedValue({ sent: false } as never);
		await holdMessageForAgentPane(TASK, "check CI", [agentPane("%1")]);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 2);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(1);
	});

	it("refuses a message for a task with no agent pane, while its sender is listening", async () => {
		vi.mocked(tmux.activePaneId).mockResolvedValue(null);
		vi.mocked(tmux.listPanes).mockResolvedValue([] as never);

		await expect(holdMessageForAgentPane(TASK, "check CI", [])).resolves.toMatchObject({
			status: "not-delivered",
			reason: "pane-absent",
		});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
	});

	it("refuses a concrete pane target that is not live", async () => {
		vi.mocked(tmux.listPanes).mockResolvedValue([{ paneId: "%1" }] as never);

		await expect(holdMessageForPane(TASK, "%9", "check CI")).resolves.toMatchObject({
			status: "not-delivered",
			reason: "pane-absent",
		});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
	});

	it("leaves a hand-off's instant submit alone", async () => {
		await runPrompt(sendPromptToAgentPane(TASK, "open a PR", [agentPane("%1")]));
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
		expect(sentChunks(1)).toEqual([{ keys: ["Enter"] }]);
	});
});
