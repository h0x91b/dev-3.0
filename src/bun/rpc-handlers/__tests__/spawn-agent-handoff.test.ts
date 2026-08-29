/**
 * "+ Agent" carrying the task's conversation across to the new agent.
 *
 * What these guard: the retelling is written BEFORE a pane exists (so a task with
 * nothing to hand over never leaves a bare agent standing where a takeover was
 * asked for), the pointer is HELD rather than typed into a booting pane, and a
 * pointer that never lands comes back as a reported verdict instead of a throw —
 * the pane is already up by then, and killing it would be worse than saying so.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
	updateTask: vi.fn(),
	splitTaskPane: vi.fn(),
	resolveCommandForAgent: vi.fn(),
	writeLaunchScript: vi.fn(async () => {}),
	getSessionSocket: vi.fn(() => "dev3"),
	prepareTaskHandoff: vi.fn(),
	previewTaskHandoff: vi.fn(),
	deliverAgentPrompt: vi.fn(),
	calls: [] as string[],
}));

vi.mock("../../data", () => ({
	getProject: mocks.getProject,
	getTask: mocks.getTask,
	updateTask: mocks.updateTask,
}));

vi.mock("../../conversation-handoff", () => ({
	prepareTaskHandoff: mocks.prepareTaskHandoff,
	previewTaskHandoff: mocks.previewTaskHandoff,
	handoffPrompt: (h: { path: string }) => `read ${h.path} and continue`,
}));

vi.mock("../../agent-prompt-delivery", () => ({ deliverAgentPrompt: mocks.deliverAgentPrompt }));

vi.mock("../../task-aux-panes", () => ({
	auxPaneAlive: vi.fn(),
	auxPaneTitle: (purpose: string) => purpose,
	closeAuxPane: vi.fn(),
	findAuxPane: vi.fn(),
	nativeAuxPaneShellPid: vi.fn(),
	openAuxPane: vi.fn(),
	splitTaskPane: mocks.splitTaskPane,
	AuxPaneUnavailableError: class AuxPaneUnavailableError extends Error {},
}));

vi.mock("../../agents", () => ({
	resolveCommandForAgent: mocks.resolveCommandForAgent,
	resolveCommandForProject: vi.fn(),
	ensureClaudeTrust: vi.fn(),
	ensureCodexTrust: vi.fn(),
	ensureGeminiTrust: vi.fn(),
	supportsPreAssignedSessionId: vi.fn(() => false),
}));

vi.mock("../../repo-config", () => ({ resolveProjectEnv: vi.fn(async () => ({})) }));
vi.mock("../../artifact-template", () => ({ ensureArtifactTemplateEnv: vi.fn(() => ({})) }));
vi.mock("../../agent-hooks", () => ({ setupAgentHooks: vi.fn(async () => null) }));
vi.mock("../../agent-transcripts", () => ({ resolveResumableSessionId: vi.fn() }));
vi.mock("../../agent-prompt", () => ({ markAgentPane: vi.fn() }));
vi.mock("../../settings", () => ({ loadSettings: vi.fn(), recordFavoriteUsages: vi.fn() }));
vi.mock("../../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("../../port-pool", () => ({ getPortAssignments: vi.fn(() => []), buildPortEnv: vi.fn(() => ({})) }));
vi.mock("../../pty-server", () => ({ getSessionSocket: mocks.getSessionSocket }));
vi.mock("../../native-task-panes", () => ({ nativeTaskPanesAlive: vi.fn(async () => false) }));
vi.mock("../settings-config", () => ({ resolveOperationalProjectConfig: vi.fn() }));
vi.mock("../../task-terminal-backend", () => ({ taskTerminalBackendIdentity: vi.fn(() => "native") }));
vi.mock("../../process-reaper", () => ({ getPidCwd: vi.fn(), terminatePidsVerified: vi.fn(async () => []) }));
vi.mock("../../resource-monitor", () => ({ getResourceUsage: vi.fn(() => undefined) }));
vi.mock("../../port-scanner", () => ({
	buildProcessTree: vi.fn(async () => new Map()),
	clearDevServerSummaryForTask: vi.fn(),
	schedulePortScanSoon: vi.fn(),
	clearPortDataForTask: vi.fn(),
	collectDescendants: vi.fn(() => []),
	collectTaskPids: vi.fn(async () => new Set()),
	findPortHolders: vi.fn(async () => []),
	getLsofOutput: vi.fn(async () => ""),
	getPortsForTask: vi.fn(() => []),
	getSessionPanePids: vi.fn(async () => []),
	parseLsofOutput: vi.fn(() => []),
	scanTaskPorts: vi.fn(async () => []),
	waitForPortsFree: vi.fn(async () => []),
}));

vi.mock("../../tmux", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../tmux")>()),
	tmux: {
		hasSession: vi.fn(async () => false),
		splitWindow: vi.fn(async () => ({ paneId: "%7", stdout: "", stderr: "" })),
		selectPane: vi.fn(async () => {}),
		listPanes: vi.fn(async () => []),
		binaryPath: vi.fn(() => "/opt/homebrew/bin/tmux"),
	},
}));

vi.mock("../shared-pure", async (importOriginal) => ({
	...(await importOriginal<typeof import("../shared-pure")>()),
	writeLaunchScript: mocks.writeLaunchScript,
}));

import { tmuxPtyHandlers } from "../tmux-pty";

const TASK_ID = "abcdef12-0000-0000-0000-000000000002";
const PROJECT = { id: "proj-1", name: "p", path: "/repo" } as any;
const TASK = { id: TASK_ID, title: "t", branchName: "feat/x", worktreePath: "/repo/wt" } as any;

const PREPARED = {
	path: "/container/conversations/handoff-claude-sess-1.md",
	chars: 4_200,
	source: "claude" as const,
	sessionId: "sess-1",
	turns: 12,
	toolCalls: 40,
	fidelity: "full" as const,
};

function spawn(handoff?: boolean) {
	return tmuxPtyHandlers.spawnAgentInTask({
		taskId: TASK_ID,
		projectId: PROJECT.id,
		agentId: "builtin-claude",
		configId: null,
		...(handoff === undefined ? {} : { handoff }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.calls = [];
	mocks.getProject.mockResolvedValue(PROJECT);
	mocks.getTask.mockResolvedValue(TASK);
	mocks.updateTask.mockResolvedValue(TASK);
	mocks.getSessionSocket.mockReturnValue("dev3");
	mocks.resolveCommandForAgent.mockResolvedValue({ command: "claude", extraEnv: {} });
	mocks.splitTaskPane.mockImplementation(async () => {
		mocks.calls.push("split");
		return { backend: "native", paneId: "%42" };
	});
	mocks.prepareTaskHandoff.mockImplementation(async () => {
		mocks.calls.push("prepare");
		return PREPARED;
	});
	mocks.deliverAgentPrompt.mockResolvedValue({ status: "held" });
});

describe("spawnAgentInTask without a handoff", () => {
	it("neither writes a retelling nor sends anything", async () => {
		expect(await spawn()).toEqual({ handoff: null });
		expect(mocks.prepareTaskHandoff).not.toHaveBeenCalled();
		expect(mocks.deliverAgentPrompt).not.toHaveBeenCalled();
	});

	it("stays out of the way when the flag is explicitly off", async () => {
		expect(await spawn(false)).toEqual({ handoff: null });
		expect(mocks.prepareTaskHandoff).not.toHaveBeenCalled();
	});
});

describe("spawnAgentInTask handing the conversation over", () => {
	it("writes the retelling before opening the pane", async () => {
		await spawn(true);
		expect(mocks.calls).toEqual(["prepare", "split"]);
	});

	it("holds the pointer for the new pane instead of typing into a booting agent", async () => {
		const result = await spawn(true);

		expect(mocks.deliverAgentPrompt).toHaveBeenCalledWith(
			TASK,
			`read ${PREPARED.path} and continue`,
			{ kind: "pane", paneId: "%42" },
			{ hold: true },
		);
		expect(result.handoff).toEqual({
			path: PREPARED.path,
			chars: PREPARED.chars,
			source: "claude",
			delivery: { status: "held" },
		});
	});

	it("opens no pane at all when there is nothing to hand over", async () => {
		mocks.prepareTaskHandoff.mockResolvedValue(null);

		await expect(spawn(true)).rejects.toThrow("Nothing to hand over");
		expect(mocks.splitTaskPane).not.toHaveBeenCalled();
	});

	it("reports a pointer that never landed rather than throwing over a live pane", async () => {
		mocks.deliverAgentPrompt.mockResolvedValue({ status: "not-delivered", reason: "pane-dead" });

		const result = await spawn(true);
		expect(result.handoff?.delivery).toEqual({ status: "not-delivered", reason: "pane-dead" });
		expect(mocks.splitTaskPane).toHaveBeenCalledTimes(1);
	});

	it("turns a delivery that threw into an unconfirmed verdict, keeping the pane", async () => {
		mocks.deliverAgentPrompt.mockRejectedValue(new Error("socket gone"));

		const result = await spawn(true);
		expect(result.handoff?.delivery).toMatchObject({ status: "unconfirmed", reason: "backend-failure" });
	});
});
