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
	},
	PANE_ID_FORMAT: { sentinel: "pane-id-format" },
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
