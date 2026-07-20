import { describe, it, expect, vi, beforeEach } from "vitest";

// Terminal ⌘F search handlers (tmux copy-mode search, decision 141):
// tmuxSearchUpdate pins a pane, re-anchors at history-bottom before every
// query (anti-drift), and reads matches through search_present gating;
// tmuxSearchStep walks matches; tmuxSearchCancel leaves copy-mode.

// ---- Mocks ----

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	realpathSync: vi.fn((p: string) => p),
}));

vi.mock("../data", () => ({}));

vi.mock("../pty-server", () => ({
	getSessionSocket: vi.fn(() => "dev3"),
	getSessionTmuxName: vi.fn((key: string) => `dev3-${key.slice(0, 8)}`),
	tmuxSessionExists: vi.fn(async () => true),
	getPtyPort: vi.fn(() => 9999),
}));

// The handlers' tmux seam: mock the typed client singleton (same pattern as
// tmux-pty-devserver-selfhost.test.ts) — no raw spawn mocking anywhere.
vi.mock("../tmux", () => {
	class MockTmuxError extends Error {
		exitCode = 1;
		stderr = "no such pane";
		constructor() { super("tmux failed"); this.name = "TmuxError"; }
	}
	class MockTmuxSpawnError extends Error {
		constructor() { super("tmux failed to spawn"); this.name = "TmuxSpawnError"; }
	}
	const format = { formatString: "", parse: () => [] };
	return {
		DEFAULT_TMUX_SOCKET: "dev3",
		TmuxError: MockTmuxError,
		TmuxSpawnError: MockTmuxSpawnError,
		isTmuxSpawnError: (err: unknown) => (err as { name?: string })?.name === "TmuxSpawnError",
		taskSessionName: (taskId: string) => `dev3-${taskId.slice(0, 8)}`,
		devServerSessionName: (taskId: string) => `dev3-dev-${taskId.slice(0, 8)}`,
		devServerSessionForTaskSession: (name: string) => `dev3-dev-${name.slice(5)}`,
		parseDev3SessionName: vi.fn(() => null),
		PANE_CWD_FORMAT: "#{pane_current_path}",
		PANE_ID_FORMAT: format,
		PANE_IN_MODE_FORMAT: format,
		PANE_START_COMMAND_FORMAT: format,
		PANE_CURRENT_COMMAND_FORMAT: format,
		PANE_SWITCHER_FORMAT: format,
		WINDOW_SWITCHER_FORMAT: format,
		SEARCH_STATE_FORMAT: format,
		SESSION_OVERVIEW_FORMAT: format,
		ALT_CLICK_PANE_FORMAT: format,
		altClickIneligibleReason: vi.fn(() => null),
		computeAltClickKeys: vi.fn(() => null),
		findAltClickPane: vi.fn(() => null),
		validAltClickPanes: vi.fn(() => []),
		tmux: {
			binaryPath: vi.fn(() => "/usr/bin/tmux"),
			hasSession: vi.fn(async () => true),
			listPanes: vi.fn(async () => []),
			displayMessage: vi.fn(async () => ({ present: true, count: 5 })),
			activePaneId: vi.fn(async () => "%3"),
			enterCopyMode: vi.fn(async () => undefined),
			copyModeHistoryBottom: vi.fn(async () => undefined),
			copyModeSearchBackwardText: vi.fn(async () => undefined),
			copyModeSearchStep: vi.fn(async () => undefined),
			exitCopyMode: vi.fn(async () => undefined),
			sendKeys: vi.fn(async () => undefined),
		},
	};
});

vi.mock("../agents", () => ({}));
vi.mock("../repo-config", () => ({}));
vi.mock("../port-pool", () => ({}));
vi.mock("../port-scanner", () => ({
	clearPortDataForTask: vi.fn(),
	getPortsForTask: vi.fn(() => []),
}));
vi.mock("../process-reaper", () => ({}));
vi.mock("../resource-monitor", () => ({}));
vi.mock("../settings", () => ({
	loadSettings: vi.fn(async () => ({})),
	recordFavoriteUsages: vi.fn(),
}));
vi.mock("../shell-env", () => ({
	getUserShell: vi.fn(() => "/bin/zsh"),
}));
vi.mock("../spawn", () => ({
	spawn: vi.fn(() => ({ exited: Promise.resolve(0), stdout: undefined, stderr: undefined })),
}));
vi.mock("../agent-hooks", () => ({ setupAgentHooks: vi.fn() }));
vi.mock("../artifact-template", () => ({ ensureArtifactTemplateEnv: vi.fn() }));
vi.mock("../rpc-handlers/shared-pure", () => ({
	getPushMessage: vi.fn(() => null),
	isActive: vi.fn(() => true),
	buildAgentEnv: vi.fn(() => ({})),
	buildCmdScript: vi.fn(() => ""),
	buildEnvExports: vi.fn(() => []),
	buildScriptRunnerCommand: vi.fn(() => ""),
	buildTaskLifecycleEnv: vi.fn(() => ({})),
	escapeForDoubleQuotes: vi.fn((s: string) => s),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	portableReadKey: vi.fn(() => ""),
	resolveBinaryPath: vi.fn(() => null),
	shellQuote: vi.fn((s: string) => s),
}));
vi.mock("../rpc-handlers/settings-config", () => ({
	resolveOperationalProjectConfig: vi.fn(async () => ({})),
}));

import { tmux, TmuxError } from "../tmux";

const { tmuxPtyHandlers } = await import("../rpc-handlers/tmux-pty");
const { tmuxSearchUpdate, tmuxSearchStep, tmuxSearchCancel } = tmuxPtyHandlers;

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";
const mocked = vi.mocked(tmux);

beforeEach(() => {
	vi.clearAllMocks();
	mocked.activePaneId.mockResolvedValue("%3");
	mocked.displayMessage.mockResolvedValue({ present: true, count: 5 } as never);
});

describe("tmuxSearchUpdate", () => {
	it("resolves the active pane, anchors at history-bottom, searches, returns matches", async () => {
		const result = await tmuxSearchUpdate({ taskId: TASK_ID, query: "needle" });
		expect(result).toEqual({ paneId: "%3", matches: 5 });
		expect(mocked.activePaneId).toHaveBeenCalledWith("dev3-aabbccdd", { socket: "dev3" });
		expect(mocked.enterCopyMode).toHaveBeenCalledWith("%3", { socket: "dev3" });
		expect(mocked.copyModeHistoryBottom).toHaveBeenCalledWith("%3", { socket: "dev3" });
		expect(mocked.copyModeSearchBackwardText).toHaveBeenCalledWith("%3", "needle", { socket: "dev3" });
		// Anti-drift contract: re-anchor BEFORE the search, never after.
		const anchorOrder = mocked.copyModeHistoryBottom.mock.invocationCallOrder[0];
		const searchOrder = mocked.copyModeSearchBackwardText.mock.invocationCallOrder[0];
		expect(anchorOrder).toBeLessThan(searchOrder);
	});

	it("reuses a caller-pinned pane without re-resolving the active one", async () => {
		const result = await tmuxSearchUpdate({ taskId: TASK_ID, query: "x", paneId: "%7" });
		expect(result.paneId).toBe("%7");
		expect(mocked.activePaneId).not.toHaveBeenCalled();
		expect(mocked.copyModeSearchBackwardText).toHaveBeenCalledWith("%7", "x", { socket: "dev3" });
	});

	it("gates the stale search_count on search_present after a miss", async () => {
		mocked.displayMessage.mockResolvedValue({ present: false, count: 6 } as never);
		const result = await tmuxSearchUpdate({ taskId: TASK_ID, query: "zzz" });
		expect(result.matches).toBe(0);
	});

	it("clears the search (exit copy-mode, no search commands) on an empty query", async () => {
		const result = await tmuxSearchUpdate({ taskId: TASK_ID, query: "", paneId: "%3" });
		expect(result).toEqual({ paneId: "%3", matches: 0 });
		expect(mocked.exitCopyMode).toHaveBeenCalledWith("%3", { socket: "dev3", bestEffort: true });
		expect(mocked.enterCopyMode).not.toHaveBeenCalled();
		expect(mocked.copyModeSearchBackwardText).not.toHaveBeenCalled();
	});

	it("rejects a malformed pane id without touching tmux", async () => {
		const result = await tmuxSearchUpdate({ taskId: TASK_ID, query: "x", paneId: "; rm -rf /" });
		expect(result).toEqual({ paneId: null, matches: 0 });
		expect(mocked.enterCopyMode).not.toHaveBeenCalled();
	});

	it("returns paneId null when the pinned pane died (TmuxError)", async () => {
		mocked.enterCopyMode.mockRejectedValue(new (TmuxError as unknown as new () => Error)());
		const result = await tmuxSearchUpdate({ taskId: TASK_ID, query: "x", paneId: "%9" });
		expect(result).toEqual({ paneId: null, matches: 0 });
	});
});

describe("tmuxSearchStep", () => {
	it("maps directions onto copyModeSearchStep and re-reads the count", async () => {
		const older = await tmuxSearchStep({ taskId: TASK_ID, paneId: "%3", direction: "older" });
		expect(older).toEqual({ matches: 5 });
		expect(mocked.copyModeSearchStep).toHaveBeenCalledWith("%3", "older", { socket: "dev3" });
		await tmuxSearchStep({ taskId: TASK_ID, paneId: "%3", direction: "newer" });
		expect(mocked.copyModeSearchStep).toHaveBeenCalledWith("%3", "newer", { socket: "dev3" });
	});

	it("rejects a malformed pane id without touching tmux", async () => {
		const result = await tmuxSearchStep({ taskId: TASK_ID, paneId: "oops", direction: "older" });
		expect(result).toEqual({ matches: 0 });
		expect(mocked.copyModeSearchStep).not.toHaveBeenCalled();
	});

	it("returns 0 matches when the pane died (TmuxError)", async () => {
		mocked.copyModeSearchStep.mockRejectedValue(new (TmuxError as unknown as new () => Error)());
		const result = await tmuxSearchStep({ taskId: TASK_ID, paneId: "%3", direction: "older" });
		expect(result).toEqual({ matches: 0 });
	});
});

describe("tmuxSearchCancel", () => {
	it("exits copy-mode best-effort in the pinned pane", async () => {
		await tmuxSearchCancel({ taskId: TASK_ID, paneId: "%3" });
		expect(mocked.exitCopyMode).toHaveBeenCalledWith("%3", { socket: "dev3", bestEffort: true });
	});

	it("rejects a malformed pane id without touching tmux", async () => {
		await tmuxSearchCancel({ taskId: TASK_ID, paneId: "$(boom)" });
		expect(mocked.exitCopyMode).not.toHaveBeenCalled();
	});
});
