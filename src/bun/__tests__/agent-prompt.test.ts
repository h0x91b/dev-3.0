import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit-test agent-prompt against a mock tmux singleton (the standard seam for
// handler-level tests). The real ../tmux module has module-load side effects
// (config file writes, shim sanitation), so a full factory mock keeps this fast
// and isolated; PANE_ID_FORMAT is only forwarded to the mocked listPanes.
vi.mock("../tmux", () => ({
	tmux: {
		activePaneId: vi.fn(),
		listPanes: vi.fn(),
		sendKeys: vi.fn(),
		showOption: vi.fn(),
		setPaneOption: vi.fn(),
	},
	PANE_ID_FORMAT: { sentinel: "pane-id-format" },
	TMUX_AGENT_PANE_OPTION: "@dev3_agent",
	TMUX_LAST_AGENT_PANE_OPTION: "@dev3_last_agent_pane",
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { tmux } from "../tmux";
import { TmuxSpawnError } from "../tmux/errors";
import {
	AGENT_PROMPT_ENTER_DELAY_MS,
	sendPromptToAgentPane,
	sendPromptToPane,
} from "../agent-prompt";
import type { PaneSessionEntry } from "../../shared/types";

const SESSION = "dev3-task-1234";
const SOCKET = "dev3";

function agentPane(paneId: string | null): PaneSessionEntry {
	return { paneId, agentCmd: "claude", sessionId: null, agentId: null, configId: null } as PaneSessionEntry;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(tmux.activePaneId).mockResolvedValue("%1");
	vi.mocked(tmux.listPanes).mockResolvedValue([{ paneId: "%1" }] as never);
	vi.mocked(tmux.sendKeys).mockResolvedValue(undefined);
	vi.mocked(tmux.showOption).mockResolvedValue(""); // no last-focused agent recorded
	vi.mocked(tmux.setPaneOption).mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("sendPromptToAgentPane — delivery", () => {
	it("pastes the prompt, then sends Enter as a discrete keypress after the delay", async () => {
		await expect(sendPromptToAgentPane(SESSION, SOCKET, "check CI", [agentPane("%1")])).resolves.toBe(true);
		expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
		expect(tmux.sendKeys).toHaveBeenCalledWith("%1", ["check CI"], { socket: SOCKET, bestEffort: true });

		await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeys).toHaveBeenCalledTimes(2);
		expect(tmux.sendKeys).toHaveBeenLastCalledWith("%1", ["Enter"], { socket: SOCKET, bestEffort: true });
	});

	it("returns false and never schedules Enter when the paste send-keys cannot launch", async () => {
		// bestEffort swallows non-zero tmux exits inside the client, so a rejection
		// reaching agent-prompt means tmux itself failed to start (TmuxSpawnError).
		// Callers (scheduled-message delivery) must see false — not a phantom success
		// that removes the queued message.
		vi.mocked(tmux.sendKeys).mockRejectedValue(new TmuxSpawnError("/usr/bin/tmux", new Error("posix_spawn failed")));

		await expect(sendPromptToAgentPane(SESSION, SOCKET, "check CI", [agentPane("%1")])).resolves.toBe(false);

		await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ENTER_DELAY_MS);
		expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
	});

	it("returns false without sending when no target pane can be resolved", async () => {
		vi.mocked(tmux.activePaneId).mockResolvedValue(null);
		vi.mocked(tmux.listPanes).mockResolvedValue([] as never);

		await expect(sendPromptToAgentPane(SESSION, SOCKET, "check CI", [agentPane("%9")])).resolves.toBe(false);
		expect(tmux.sendKeys).not.toHaveBeenCalled();
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
		await sendPromptToAgentPane(SESSION, SOCKET, "ping", TWO_AGENTS);
		expect(tmux.sendKeys).toHaveBeenCalledWith("%2", ["ping"], { socket: SOCKET, bestEffort: true });
	});

	it("ignores a recorded last-focused pane that is no longer live and falls back to the active pane", async () => {
		vi.mocked(tmux.showOption).mockResolvedValue("%9"); // dead / unknown
		await sendPromptToAgentPane(SESSION, SOCKET, "ping", TWO_AGENTS);
		expect(tmux.sendKeys).toHaveBeenCalledWith("%1", ["ping"], { socket: SOCKET, bestEffort: true });
	});

	it("ignores a recorded pane that is live but not a registered agent pane", async () => {
		// %3 is a live shell split, not in the agent registry.
		vi.mocked(tmux.listPanes).mockResolvedValue([{ paneId: "%1" }, { paneId: "%2" }, { paneId: "%3" }] as never);
		vi.mocked(tmux.showOption).mockResolvedValue("%3");
		vi.mocked(tmux.activePaneId).mockResolvedValue("%3");
		await sendPromptToAgentPane(SESSION, SOCKET, "ping", TWO_AGENTS);
		// No last-focused agent → ≥2 agents → active pane (%3, the focused shell).
		expect(tmux.sendKeys).toHaveBeenCalledWith("%3", ["ping"], { socket: SOCKET, bestEffort: true });
	});

	it("marks live agent panes with the focus-hook option (self-heal)", async () => {
		vi.mocked(tmux.showOption).mockResolvedValue("");
		await sendPromptToAgentPane(SESSION, SOCKET, "ping", TWO_AGENTS);
		expect(tmux.setPaneOption).toHaveBeenCalledWith("%1", "@dev3_agent", "1", { socket: SOCKET, bestEffort: true });
		expect(tmux.setPaneOption).toHaveBeenCalledWith("%2", "@dev3_agent", "1", { socket: SOCKET, bestEffort: true });
	});

	it("targets the single live agent unconditionally when nothing is recorded", async () => {
		vi.mocked(tmux.listPanes).mockResolvedValue([{ paneId: "%2" }, { paneId: "%5" }] as never);
		vi.mocked(tmux.activePaneId).mockResolvedValue("%5"); // a focused shell
		vi.mocked(tmux.showOption).mockResolvedValue("");
		await sendPromptToAgentPane(SESSION, SOCKET, "ping", [agentPane("%2")]);
		expect(tmux.sendKeys).toHaveBeenCalledWith("%2", ["ping"], { socket: SOCKET, bestEffort: true });
	});
});

describe("sendPromptToPane — concrete pane target", () => {
	it("delivers to a live pane", async () => {
		await expect(sendPromptToPane(SESSION, SOCKET, "%1", "hello")).resolves.toBe(true);
		expect(tmux.sendKeys).toHaveBeenCalledWith("%1", ["hello"], { socket: SOCKET, bestEffort: true });
	});

	it("returns false for a pane that is no longer live", async () => {
		await expect(sendPromptToPane(SESSION, SOCKET, "%42", "hello")).resolves.toBe(false);
		expect(tmux.sendKeys).not.toHaveBeenCalled();
	});

	it("returns false when the paste fails at launch for a live pane", async () => {
		vi.mocked(tmux.sendKeys).mockRejectedValue(new TmuxSpawnError("/usr/bin/tmux", new Error("boom")));
		await expect(sendPromptToPane(SESSION, SOCKET, "%1", "hello")).resolves.toBe(false);
	});
});
