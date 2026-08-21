/**
 * The dev server on BOTH terminal backends.
 *
 * The regression this guards: a native task used to get a `dev3-dev-<id>` tmux
 * session behind its back (the viewer split failed inside a best-effort catch,
 * so the dev script kept running invisibly). A native start must touch no tmux
 * at all and must open a real auxiliary pane instead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	// data
	getProject: vi.fn(),
	getTask: vi.fn(),
	// settings-config
	resolveOperationalProjectConfig: vi.fn(),
	// task-terminal-backend
	taskTerminalBackendIdentity: vi.fn(),
	// task-aux-panes seam
	auxPaneAlive: vi.fn(),
	closeAuxPane: vi.fn(),
	findAuxPane: vi.fn(),
	nativeAuxPaneShellPid: vi.fn(),
	openAuxPane: vi.fn(),
	// port pool / scanner / reaper
	getPortAssignments: vi.fn(() => [] as number[]),
	allocatePorts: vi.fn(),
	buildPortEnv: vi.fn(() => ({})),
	buildProcessTree: vi.fn(async () => new Map<number, number[]>()),
	collectDescendants: vi.fn(() => [] as number[]),
	collectTaskPids: vi.fn(async () => new Set<number>()),
	findPortHolders: vi.fn(async () => []),
	getLsofOutput: vi.fn(async () => ""),
	getPortsForTask: vi.fn(() => []),
	getSessionPanePids: vi.fn(async () => [] as number[]),
	parseLsofOutput: vi.fn(() => []),
	scanTaskPorts: vi.fn(async () => []),
	waitForPortsFree: vi.fn(async () => []),
	clearPortDataForTask: vi.fn(),
	clearDevServerSummaryForTask: vi.fn(),
	schedulePortScanSoon: vi.fn(),
	getPidCwd: vi.fn(async () => null),
	terminatePidsVerified: vi.fn(async () => [] as number[]),
	getResourceUsage: vi.fn(() => undefined),
	writeLaunchScript: vi.fn(async () => {}),
	// tmux singleton — every method the dev-server paths could reach
	tmuxHasSession: vi.fn(async () => false),
	tmuxNewSessionDetached: vi.fn(async () => ({ stdout: "", stderr: "" })),
	tmuxSplitWindow: vi.fn(async () => ({ paneId: "%7", stdout: "", stderr: "" })),
	tmuxKillSession: vi.fn(async () => {}),
	tmuxKillPane: vi.fn(async () => {}),
	tmuxSelectPane: vi.fn(async () => {}),
	tmuxSetOption: vi.fn(async () => {}),
	tmuxListPanes: vi.fn(async () => []),
	tmuxBinaryPath: vi.fn(() => "/opt/homebrew/bin/tmux"),
}));

vi.mock("../../data", () => ({ getProject: mocks.getProject, getTask: mocks.getTask }));
vi.mock("../settings-config", () => ({ resolveOperationalProjectConfig: mocks.resolveOperationalProjectConfig }));
vi.mock("../../task-terminal-backend", () => ({ taskTerminalBackendIdentity: mocks.taskTerminalBackendIdentity }));

vi.mock("../../task-aux-panes", () => ({
	auxPaneAlive: mocks.auxPaneAlive,
	auxPaneTitle: (purpose: string) => (purpose === "devServer" ? "Dev Server" : "Git"),
	closeAuxPane: mocks.closeAuxPane,
	findAuxPane: mocks.findAuxPane,
	nativeAuxPaneShellPid: mocks.nativeAuxPaneShellPid,
	openAuxPane: mocks.openAuxPane,
}));

vi.mock("../../port-pool", () => ({
	getPortAssignments: mocks.getPortAssignments,
	allocatePorts: mocks.allocatePorts,
	buildPortEnv: mocks.buildPortEnv,
}));

vi.mock("../../port-scanner", () => ({
	buildProcessTree: mocks.buildProcessTree,
	clearPortDataForTask: mocks.clearPortDataForTask,
	clearDevServerSummaryForTask: mocks.clearDevServerSummaryForTask,
	schedulePortScanSoon: mocks.schedulePortScanSoon,
	collectDescendants: mocks.collectDescendants,
	collectTaskPids: mocks.collectTaskPids,
	findPortHolders: mocks.findPortHolders,
	getLsofOutput: mocks.getLsofOutput,
	getPortsForTask: mocks.getPortsForTask,
	getSessionPanePids: mocks.getSessionPanePids,
	parseLsofOutput: mocks.parseLsofOutput,
	scanTaskPorts: mocks.scanTaskPorts,
	waitForPortsFree: mocks.waitForPortsFree,
}));

vi.mock("../../process-reaper", () => ({ getPidCwd: mocks.getPidCwd, terminatePidsVerified: mocks.terminatePidsVerified }));
vi.mock("../../resource-monitor", () => ({ getResourceUsage: mocks.getResourceUsage }));

vi.mock("../../pty-server", () => ({}));
vi.mock("../../agents", () => ({}));
vi.mock("../../repo-config", () => ({}));
vi.mock("../../settings", () => ({ loadSettings: vi.fn(), recordFavoriteUsages: vi.fn() }));
vi.mock("../../shell-env", () => ({ getUserShell: vi.fn(() => "/bin/bash") }));
vi.mock("../../spawn", () => ({ spawn: vi.fn() }));
vi.mock("../../agent-hooks", () => ({ setupAgentHooks: vi.fn() }));
vi.mock("../../agent-transcripts", () => ({ resolveResumableSessionId: vi.fn() }));
vi.mock("../../artifact-template", () => ({ ensureArtifactTemplateEnv: vi.fn() }));
vi.mock("../../agent-prompt", () => ({ markAgentPane: vi.fn() }));
vi.mock("../../native-task-panes", () => ({ nativeTaskPanesAlive: vi.fn(async () => false) }));

vi.mock("../shared-pure", async (importOriginal) => ({
	...(await importOriginal<typeof import("../shared-pure")>()),
	writeLaunchScript: mocks.writeLaunchScript,
}));

vi.mock("../../tmux", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../tmux")>()),
	tmux: {
		hasSession: mocks.tmuxHasSession,
		newSessionDetached: mocks.tmuxNewSessionDetached,
		splitWindow: mocks.tmuxSplitWindow,
		killSession: mocks.tmuxKillSession,
		killPane: mocks.tmuxKillPane,
		selectPane: mocks.tmuxSelectPane,
		setOption: mocks.tmuxSetOption,
		listPanes: mocks.tmuxListPanes,
		binaryPath: mocks.tmuxBinaryPath,
	},
}));

import { runDevServer, stopDevServer, cleanupTaskTmuxState } from "../tmux-pty";

const TASK_ID = "abcdef12-0000-0000-0000-000000000001";
const DEV_SESSION = "dev3-dev-abcdef12";
const TASK_SESSION = "dev3-abcdef12";
const PROJECT = { id: "proj-1", name: "p", path: "/repo" } as any;
const TASK = { id: TASK_ID, title: "Dev server task", branchName: "feat/x", worktreePath: "/repo/wt", tmuxSocket: "dev3" } as any;

/** Every tmux method the mocked singleton exposes — "no tmux at all" asserts on all of them. */
const ALL_TMUX_CALLS = [
	mocks.tmuxHasSession,
	mocks.tmuxNewSessionDetached,
	mocks.tmuxSplitWindow,
	mocks.tmuxKillSession,
	mocks.tmuxKillPane,
	mocks.tmuxSelectPane,
	mocks.tmuxSetOption,
	mocks.tmuxListPanes,
	mocks.tmuxBinaryPath,
];

function useBackend(backend: "native" | "tmux"): void {
	mocks.taskTerminalBackendIdentity.mockReturnValue(backend);
}

/** Track dev-server liveness the way the real backends do: the pane/session IS the server. */
function trackNativeLiveness(paneId = "%42", shellPid = 4242): { alive: () => boolean } {
	let alive = false;
	mocks.auxPaneAlive.mockImplementation(async () => alive);
	mocks.findAuxPane.mockImplementation(async () => (alive ? { backend: "native", paneId } : null));
	mocks.nativeAuxPaneShellPid.mockImplementation(async () => (alive ? shellPid : null));
	mocks.openAuxPane.mockImplementation(async () => {
		alive = true;
		return { backend: "native", paneId };
	});
	mocks.closeAuxPane.mockImplementation(async () => {
		alive = false;
	});
	return { alive: () => alive };
}

beforeEach(() => {
	vi.clearAllMocks();
	cleanupTaskTmuxState(TASK_ID);
	mocks.getProject.mockResolvedValue(PROJECT);
	mocks.getTask.mockResolvedValue(TASK);
	mocks.resolveOperationalProjectConfig.mockResolvedValue({ devScript: "npm run dev", portCount: 0, env: {} });
	mocks.getPortAssignments.mockReturnValue([]);
	mocks.getLsofOutput.mockResolvedValue("");
	mocks.buildProcessTree.mockResolvedValue(new Map());
	mocks.collectDescendants.mockReturnValue([]);
	mocks.terminatePidsVerified.mockResolvedValue([]);
	mocks.waitForPortsFree.mockResolvedValue([]);
	mocks.findPortHolders.mockResolvedValue([]);
	mocks.tmuxHasSession.mockResolvedValue(false);
	mocks.tmuxNewSessionDetached.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.tmuxSplitWindow.mockResolvedValue({ paneId: "%7", stdout: "", stderr: "" });
});

describe("runDevServer — native backend", () => {
	it("makes no tmux calls at all", async () => {
		useBackend("native");
		trackNativeLiveness();

		await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id });

		for (const call of ALL_TMUX_CALLS) expect(call).not.toHaveBeenCalled();
	});

	it("opens the dev-server pane through the auxiliary-pane seam", async () => {
		useBackend("native");
		trackNativeLiveness();

		await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id });

		expect(mocks.openAuxPane).toHaveBeenCalledWith(
			expect.objectContaining({ purpose: "devServer", placement: "right", cwd: "/repo/wt" }),
		);
	});

	it("reports a native status with no tmux session names and the pane as viewer", async () => {
		useBackend("native");
		trackNativeLiveness("%99", 777);

		const status = await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id });

		expect(status).toMatchObject({
			backend: "native",
			running: true,
			taskSessionName: "",
			devSessionName: "",
			viewerPaneId: "%99",
			panePids: [777],
		});
	});
});

describe("runDevServer — tmux backend is unchanged", () => {
	it("creates the dev session and splits the viewer pane, reporting backend tmux", async () => {
		useBackend("tmux");

		const status = await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id });

		expect(mocks.tmuxNewSessionDetached).toHaveBeenCalledWith(
			expect.objectContaining({ sessionName: DEV_SESSION, cwd: "/repo/wt" }),
		);
		expect(mocks.tmuxSplitWindow).toHaveBeenCalledWith(expect.objectContaining({ target: TASK_SESSION }));
		expect(status.backend).toBe("tmux");
		expect(mocks.openAuxPane).not.toHaveBeenCalled();
	});
});

describe("stopDevServer", () => {
	it("closes the native pane and never kills a tmux session", async () => {
		useBackend("native");
		const liveness = trackNativeLiveness();
		await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id });

		await stopDevServer({ taskId: TASK_ID, projectId: PROJECT.id });

		// The 4th argument is the stop's correlation id, which has to reach the
		// aux-pane close or the log cannot join request → close → reply (seq 1407).
		expect(mocks.closeAuxPane).toHaveBeenCalledWith(TASK, "devServer", "dev3", expect.stringMatching(/^[0-9a-f]{8}$/));
		expect(mocks.tmuxKillSession).not.toHaveBeenCalled();
		expect(liveness.alive()).toBe(false);
	});

	it("still kills the dev tmux session on the tmux backend", async () => {
		useBackend("tmux");

		await stopDevServer({ taskId: TASK_ID, projectId: PROJECT.id });

		expect(mocks.tmuxKillSession).toHaveBeenCalledWith(DEV_SESSION, expect.objectContaining({ socket: "dev3" }));
		expect(mocks.closeAuxPane).not.toHaveBeenCalled();
	});

	it("reaps the native pane's shell pid and its descendants", async () => {
		useBackend("native");
		trackNativeLiveness("%42", 555);
		mocks.collectDescendants.mockReturnValue([556, 557]);
		await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id });

		await stopDevServer({ taskId: TASK_ID, projectId: PROJECT.id });

		expect(mocks.terminatePidsVerified).toHaveBeenCalledWith([555, 556, 557], expect.anything());
	});
});
