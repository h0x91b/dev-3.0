import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentPromptLedger } from "../agent-prompt-ledger";

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
const pushCliAttention = vi.hoisted(() => vi.fn());
vi.mock("../rpc-handlers/shared", () => ({ pushCliAttention }));
/** Batch files the mocked spill has written and not yet discarded. */
const batchFiles = vi.hoisted(() => ({ alive: new Set<string>(), written: 0 }));
const spillHeldMessageBatch = vi.hoisted(() =>
	vi.fn(async (_task: unknown, texts: string[]) => {
		batchFiles.written += 1;
		const path = batchFiles.written === 1 ? "/task/messages/burst-1.md" : `/task/messages/burst-${batchFiles.written}.md`;
		batchFiles.alive.add(path);
		return { path, pointer: `<dev3-ai-message>\n${texts.length} held messages: ${path}\n</dev3-ai-message>` };
	}),
);
const discardHeldMessageBatch = vi.hoisted(() => vi.fn(async (path: string) => void batchFiles.alive.delete(path)));
vi.mock("../agent-message-spill", () => ({ spillHeldMessageBatch, discardHeldMessageBatch }));

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { tmux } from "../tmux";
import {
	AGENT_PROMPT_ENTER_DELAY_MS,
	holdMessageForPane,
	sendPromptToAgentPane,
	sendPromptToPane,
} from "../agent-prompt";
import {
	claimDev3TypedPrompt,
	noteDev3TypedPrompt,
	resetTypedPromptClaims,
	typedPromptClaimCount,
} from "../agent-typed-prompt-claims";
import {
	deferHeldAgentMessagesForTask,
	flushHeldAgentMessagesForTask,
	releaseStrandedAgentMessagesOnSubmission,
	resetAgentMessageHolds,
} from "../agent-message-hold";
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
	it("types the prompt, then sends Enter as a separate guarded stage, pinned to the sighted session and server", async () => {
		const delivery = await runPrompt(sendPromptToAgentPane(TASK, "check CI", [agentPane("%1")]));

		expect(delivery).toMatchObject({ status: "delivered" });
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
		expect(sentChunks(0)).toEqual([{ literal: "check CI" }]);
		expect(sentChunks(1)).toEqual([{ keys: ["Enter"] }]);
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

	it("never sends Enter after a stage the guard refused or tmux failed to spawn", async () => {
		// The guard is false inside the server's own turn: the pane moved, restarted,
		// died, or sits in copy mode. Counting EXECUTIONS is the assertion — a verdict
		// alone cannot tell "text went in, Enter did not" from "nothing went in".
		const cases: Array<[string, () => void, string]> = [
			["guard refused", () => vi.mocked(tmux.sendKeysGuarded).mockResolvedValue({ sent: false } as never), "incarnation-changed"],
			["spawn failure", () => vi.mocked(tmux.sendKeysGuarded).mockRejectedValue(Object.assign(new Error("tmux: not found"), { spawnFailure: true })), "backend-failure"],
		];
		for (const [name, arrange, reason] of cases) {
			vi.mocked(tmux.sendKeysGuarded).mockClear();
			arrange();
			const delivery = await runPrompt(sendPromptToAgentPane(TASK, "check CI", [agentPane("%1")]));
			expect(tmux.sendKeysGuarded, name).toHaveBeenCalledTimes(1);
			expect(delivery, name).toMatchObject({ status: "not-started", reason });
		}
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

	it("routes to the recorded last-focused agent, else the focused agent pane, never a focused shell split", async () => {
		// A shell split is not in the agent registry; tmux would report the send as
		// delivered either way, so aiming there loses the prompt silently.
		const cases: Array<{ name: string; live: string[]; recorded: string; active: string; agents: PaneSessionEntry[]; expected: string }> = [
			{ name: "recorded last-focused agent wins over the active pane", live: ["%1", "%2"], recorded: "%2", active: "%1", agents: TWO_AGENTS, expected: "%2" },
			{ name: "a dead recorded pane falls back to the active pane", live: ["%1", "%2"], recorded: "%9", active: "%1", agents: TWO_AGENTS, expected: "%1" },
			{ name: "a focused shell split falls back to a live agent pane", live: ["%1", "%2", "%3"], recorded: "%3", active: "%3", agents: TWO_AGENTS, expected: "%1" },
			{ name: "a focused agent pane is honoured", live: ["%1", "%2", "%3"], recorded: "", active: "%2", agents: TWO_AGENTS, expected: "%2" },
			{ name: "the single live agent is targeted unconditionally", live: ["%2", "%5"], recorded: "", active: "%5", agents: [agentPane("%2")], expected: "%2" },
		];
		for (const c of cases) {
			vi.mocked(tmux.sendKeysGuarded).mockClear();
			vi.mocked(tmux.listPanes).mockResolvedValue(c.live.map((paneId) => ({ paneId })) as never);
			vi.mocked(tmux.showOption).mockResolvedValue(c.recorded);
			vi.mocked(tmux.activePaneId).mockResolvedValue(c.active);
			await runPrompt(sendPromptToAgentPane(TASK, "ping", c.agents));
			expect(sentPane(0), c.name).toBe(c.expected);
		}
	});

	it("marks live agent panes with the focus-hook option (self-heal)", async () => {
		vi.mocked(tmux.showOption).mockResolvedValue("");
		await runPrompt(sendPromptToAgentPane(TASK, "ping", TWO_AGENTS));
		expect(tmux.setPaneOption).toHaveBeenCalledWith("%1", "@dev3_agent", "1", { socket: SOCKET, bestEffort: true });
		expect(tmux.setPaneOption).toHaveBeenCalledWith("%2", "@dev3_agent", "1", { socket: SOCKET, bestEffort: true });
	});
});

describe("sendPromptToPane — concrete pane target", () => {
	it("delivers to a live pane", async () => {
		const delivery = await runPrompt(sendPromptToPane(TASK, "%1", "hello"));

		expect(delivery).toMatchObject({ status: "delivered" });
		expect(sentChunks(0)).toEqual([{ literal: "hello" }]);
	});

	it("refuses an absent, dead, or other task's pane without sending, keeping absent distinct from dead", async () => {
		const cases: Array<[string, unknown, string]> = [
			["absent", { kind: "absent" }, "pane-absent"],
			["dead", { kind: "dead", sessionName: SESSION, serverToken: SERVER_TOKEN }, "pane-dead"],
			["another task's session", { kind: "present", sessionName: "dev3-someone-else", serverToken: SERVER_TOKEN }, "pane-absent"],
		];
		for (const [name, observed, reason] of cases) {
			vi.mocked(tmux.observePane).mockResolvedValue(observed as never);
			await expect(runPrompt(sendPromptToPane(TASK, "%42", "hello")), name).resolves.toMatchObject({ status: "not-started", reason });
		}
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
	});
});

describe("the held dev3 message — nothing reaches the pane until it goes quiet", () => {
	afterEach(() => resetAgentMessageHolds());

	it("types NOTHING on arrival, then the text and one Enter after the quiet window", async () => {
		const delivery = await holdMessageForPane(TASK, "%1", "check CI");

		expect(delivery).toMatchObject({ status: "held" });
		// The user may be mid-word: not one byte may go into the pane yet, and the
		// 800ms hand-off gap must not smuggle one in either.
		await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();

		// Exactly to the release: the text goes in and the Enter does not follow it yet.
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS - AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(1);
		expect(sentChunks(0)).toEqual([{ literal: "check CI" }]);

		// The Enter keeps the hand-off's gap behind it: sent in the same millisecond,
		// Claude Code reads the paste and the CR as one paste and never submits.
		await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
		expect(sentChunks(1)).toEqual([{ keys: ["Enter"] }]);
		expect(sentPane(1)).toBe("%1");
	});

	it("stacks three messages into three pastes and ONE Enter", async () => {
		for (const text of ["one", "two", "three"]) {
			await holdMessageForPane(TASK, "%1", text);
			await vi.advanceTimersByTimeAsync(4_000);
		}
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS + AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(4);
		// The first opens the turn; the other two arrive behind a blank line, because an
		// envelope ends without a newline and used to weld onto its predecessor (#1608).
		expect(sentChunks(0)).toEqual([{ literal: "one" }]);
		expect(sentChunks(1)).toEqual([{ literal: "\n\ntwo" }]);
		expect(sentChunks(2)).toEqual([{ literal: "\n\nthree" }]);
		expect(sentChunks(3)).toEqual([{ keys: ["Enter"] }]);
	});

	it("keeps the pane clean while the user types, with no ceiling on his hold", async () => {
		await holdMessageForPane(TASK, "%1", "check CI");

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
		await holdMessageForPane(TASK, "%1", "check CI");
		deferHeldAgentMessagesForTask(TASK_ID);

		// Three message windows of silence is still just a pause in his own line.
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 3);
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
	});

	it("lands the moment the user submits his own line", async () => {
		await holdMessageForPane(TASK, "%1", "check CI");
		flushHeldAgentMessagesForTask(TASK_ID);
		await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS);

		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
		expect(sentChunks(0)).toEqual([{ literal: "check CI" }]);
		expect(sentChunks(1)).toEqual([{ keys: ["Enter"] }]);
	});

	it("pins the pane when the hold releases, so a dead pane types nothing at all", async () => {
		await holdMessageForPane(TASK, "%1", "check CI");
		vi.mocked(tmux.observePane).mockResolvedValue({ kind: "absent" } as never);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
	});

	it("sends no Enter when the text itself did not land", async () => {
		// A refused text stage leaves an unknown input box, so an Enter into it would
		// submit whatever is sitting there.
		vi.mocked(tmux.sendKeysGuarded).mockResolvedValue({ sent: false, inMode: false });
		await holdMessageForPane(TASK, "%1", "check CI");

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 2);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(1);
	});

	it("waits out a scrolled-up pane instead of losing the message, and lands it once", async () => {
		// Copy mode refuses the keys but it is still the same pane: the user will scroll back.
		vi.mocked(tmux.sendKeysGuarded)
			.mockResolvedValueOnce({ sent: false, inMode: true })
			.mockResolvedValueOnce({ sent: false, inMode: true });
		await holdMessageForPane(TASK, "%1", "check CI");

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 2);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
		expect(sentChunks(1)).toEqual([{ literal: "check CI" }]);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS + AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(4);
		expect(sentChunks(2)).toEqual([{ literal: "check CI" }]);
		expect(sentChunks(3)).toEqual([{ keys: ["Enter"] }]);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 3);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(4);
	});

	it("strands a turn whose Enter hit copy mode: no more keys, a badge, and a drop once the pane is gone", async () => {
		pushCliAttention.mockClear();
		// The text lands; the user scrolled up in the gap, so the Enter is refused.
		vi.mocked(tmux.sendKeysGuarded)
			.mockResolvedValueOnce({ sent: true, inMode: false })
			.mockResolvedValueOnce({ sent: false, inMode: true });
		await holdMessageForPane(TASK, "%1", "check CI");
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS + AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
		expect(pushCliAttention).toHaveBeenCalledWith(expect.objectContaining({ taskId: TASK_ID, reason: expect.stringContaining("not sent") }));

		// An hour of the pane staying alive: dev3 never types or presses anything more.
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);

		vi.mocked(tmux.observePane).mockResolvedValue({ kind: "absent" } as never);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(pushCliAttention).toHaveBeenLastCalledWith(expect.objectContaining({ reason: expect.stringContaining("not delivered") }));
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
	});

	/** Text lands, the Enter hits copy mode: the agent pane's box now holds an unsent peer message. */
	async function strandCheckCi() {
		vi.mocked(tmux.sendKeysGuarded)
			.mockResolvedValueOnce({ sent: true, inMode: false })
			.mockResolvedValueOnce({ sent: false, inMode: true });
		await holdMessageForPane(TASK, "%1", "check CI, a peer message long enough to match");
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS + AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
	}

	// Commit / Create PR / rebase / role-brief hand-offs type AND press Enter at once; into
	// a stranded box that Enter would submit the peer text and whatever the user typed after it.
	it("refuses a direct prompt into a stranded box without sending a key, until a matching submission", async () => {
		await strandCheckCi();

		await expect(runPrompt(sendPromptToAgentPane(TASK, "commit your work", [agentPane("%1")]))).resolves.toMatchObject({
			status: "not-started",
			reason: "input-occupied",
			retryableAsNewDelivery: true,
		});
		await expect(runPrompt(sendPromptToPane(TASK, "%1", "commit your work"))).resolves.toMatchObject({ reason: "input-occupied" });
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);

		releaseStrandedAgentMessagesOnSubmission(TASK_ID, "check CI, a peer message long enough to match");
		await expect(runPrompt(sendPromptToAgentPane(TASK, "commit your work", [agentPane("%1")]))).resolves.toMatchObject({
			status: "delivered",
		});
	});

	it("does not refuse a direct prompt to a different pane of the same task", async () => {
		await strandCheckCi();
		vi.mocked(tmux.listPanes).mockResolvedValue([{ paneId: "%1" }, { paneId: "%2" }] as never);
		await expect(runPrompt(sendPromptToPane(TASK, "%2", "hunt bugs"))).resolves.toMatchObject({ status: "delivered" });
	});

	// tmux restarted while the app kept running: the same `%id` in the same session name is
	// a new, empty box. Holding the old stranded turn for it would block the agent forever.
	it("drops a stranded turn when the pane id now belongs to another tmux server generation", async () => {
		pushCliAttention.mockClear();
		await strandCheckCi();
		vi.mocked(tmux.observePane).mockResolvedValue({ kind: "present", sessionName: SESSION, serverToken: "srv-token-2" } as never);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(pushCliAttention).toHaveBeenLastCalledWith(expect.objectContaining({ reason: expect.stringContaining("not delivered") }));
		await expect(runPrompt(sendPromptToAgentPane(TASK, "commit your work", [agentPane("%1")]))).resolves.toMatchObject({
			status: "delivered",
		});
	});

	it("refuses a message for a task with no live pane, or a concrete target that is not live", async () => {
		vi.mocked(tmux.listPanes).mockResolvedValue([{ paneId: "%1" }] as never);
		await expect(holdMessageForPane(TASK, "%9", "check CI"), "target not live").resolves.toMatchObject({
			status: "not-delivered",
			reason: "pane-absent",
		});

		vi.mocked(tmux.activePaneId).mockResolvedValue(null);
		vi.mocked(tmux.listPanes).mockResolvedValue([] as never);
		await expect(holdMessageForPane(TASK, "%1", "check CI"), "no live pane").resolves.toMatchObject({
			status: "not-delivered",
			reason: "pane-absent",
		});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
	});
});

describe("a Cursor pane gets one more Enter, which steers a queued follow-up into its turn", () => {
	afterEach(() => resetAgentMessageHolds());
	const cursorPane = { ...agentPane("%1"), agentCmd: "agent" } as PaneSessionEntry;
	const CURSOR_TASK = { ...TASK, sessionState: { panes: [cursorPane] } } as Task;

	it("presses Enter twice after a held message lands in a Cursor pane", async () => {
		await holdMessageForPane(CURSOR_TASK, "%1", "check CI");
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS + 3 * AGENT_PROMPT_ENTER_DELAY_MS);

		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(3);
		expect(sentChunks(1)).toEqual([{ keys: ["Enter"] }]);
		expect(sentChunks(2)).toEqual([{ keys: ["Enter"] }]);
	});

	it("skips the steer Enter when the user typed after the submit, so his draft is never sent", async () => {
		await holdMessageForPane(CURSOR_TASK, "%1", "check CI");
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS + AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);

		deferHeldAgentMessagesForTask(TASK_ID);
		await vi.advanceTimersByTimeAsync(2 * AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
	});

	it("skips the steer Enter when a prompt opened in the pane meanwhile, so it never answers the menu", async () => {
		await holdMessageForPane(CURSOR_TASK, "%1", "check CI");
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS + AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);

		agentPromptLedger.claudePermissionRequest({ taskId: TASK_ID, sessionId: "s1", toolName: "Bash", paneId: "%1" });
		try {
			await vi.advanceTimersByTimeAsync(2 * AGENT_PROMPT_ENTER_DELAY_MS);
			expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
		} finally {
			agentPromptLedger.reset();
		}
	});

	it("does the same for a direct prompt, and keeps a Claude pane at one Enter", async () => {
		const cursor = sendPromptToAgentPane(CURSOR_TASK, "commit", [cursorPane]);
		await vi.advanceTimersByTimeAsync(2 * AGENT_PROMPT_ENTER_DELAY_MS);
		await expect(cursor).resolves.toMatchObject({ status: "delivered" });
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(3);

		vi.mocked(tmux.sendKeysGuarded).mockClear();
		await runPrompt(sendPromptToAgentPane(TASK, "commit", [agentPane("%1")]));
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
	});
});

describe("a held message bound to one agent is checked again when it releases", () => {
	it("types nothing when its agent is gone by then, and says so on the task", async () => {
		const verify = vi.fn(async () => "the addressed agent (pane %1) is no longer running in this task; not sent to another pane");
		await expect(holdMessageForPane(TASK, "%1", "review the diff", undefined, verify)).resolves.toMatchObject({
			status: "held",
			paneId: "%1",
		});
		expect(verify).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS + AGENT_PROMPT_ENTER_DELAY_MS);
		expect(verify).toHaveBeenCalledTimes(1);
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
		expect(pushCliAttention).toHaveBeenCalledWith(expect.objectContaining({
			taskId: TASK_ID,
			reason: expect.stringContaining("no longer running in this task"),
		}));
	});

	it("lands the rest of the burst without the refused one", async () => {
		await holdMessageForPane(TASK, "%1", "for the old agent", undefined, async () => "the agent was replaced");
		await holdMessageForPane(TASK, "%1", "still fine", undefined, async () => null);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS + AGENT_PROMPT_ENTER_DELAY_MS);
		expect(sentChunks(0)).toEqual([{ literal: "still fine" }]);
		expect(sentChunks(1)).toEqual([{ keys: ["Enter"] }]);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
	});

	it("drops a message whose check throws, rather than typing it unverified", async () => {
		await holdMessageForPane(TASK, "%1", "check CI", undefined, async () => {
			throw new Error("ps timed out");
		});

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS + AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
		expect(pushCliAttention).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining("could not be verified") }));
	});
});

describe("a held backlog past one read is typed as ONE batch pointer", () => {
	afterEach(() => {
		resetAgentMessageHolds();
		resetTypedPromptClaims();
		batchFiles.alive.clear();
		batchFiles.written = 0;
	});

	it("leaves no file and no receipt behind while the pane sits in copy mode for 10 minutes", async () => {
		// Before the undo, each quiet window wrote a new file AND a new receipt; 64
		// receipts is the per-task cap, so ~16 minutes evicted every older one.
		noteDev3TypedPrompt(TASK_ID, "an older message still waiting for its submit hook");
		// Its text is INSIDE every pointer: retracting by containment would spend it.
		noteDev3TypedPrompt(TASK_ID, "held messages");
		vi.mocked(tmux.sendKeysGuarded).mockResolvedValue({ sent: false, inMode: true } as never);
		for (const text of ["a", "b", "c"].map((c) => c.repeat(600))) await holdMessageForPane(TASK, "%1", text);

		await vi.advanceTimersByTimeAsync(10 * 60_000);

		expect(batchFiles.written).toBeGreaterThan(30);
		expect(batchFiles.alive.size).toBe(0);
		expect(typedPromptClaimCount(TASK_ID)).toBe(2);
		expect(claimDev3TypedPrompt(TASK_ID, "an older message still waiting for its submit hook")).toBe(true);
		expect(claimDev3TypedPrompt(TASK_ID, "held messages")).toBe(true);
	});

	it("types only the pointer, then one Enter, and leaves a receipt for exactly that text", async () => {
		const texts = ["a", "b", "c"].map((c) => c.repeat(600));
		for (const text of texts) await holdMessageForPane(TASK, "%1", text);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS + AGENT_PROMPT_ENTER_DELAY_MS);

		const pointer = "<dev3-ai-message>\n3 held messages: /task/messages/burst-1.md\n</dev3-ai-message>";
		expect(spillHeldMessageBatch).toHaveBeenCalledWith(TASK, texts);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
		expect(sentChunks(0)).toEqual([{ literal: pointer }]);
		expect(sentChunks(1)).toEqual([{ keys: ["Enter"] }]);
		// Without the receipt the receiver's submit hook records the pointer as the user's prompt.
		expect(claimDev3TypedPrompt(TASK_ID, pointer)).toBe(true);
	});
});
