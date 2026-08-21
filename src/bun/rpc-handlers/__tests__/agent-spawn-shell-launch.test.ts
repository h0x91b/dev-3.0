/**
 * "+ Agent" on a native task, per platform, EXECUTED on the platform it claims.
 *
 * The regression: the spawn path handed the pane a hardcoded `/bin/bash`, which
 * does not exist on Windows, so adding a second agent died with "requested shell
 * executable not found: /bin/bash". A macOS run cannot see that — there the
 * literal happens to be correct — so this file asserts against the REAL
 * `process.platform` and runs on the windows-latest leg of the packaged proof.
 * The POSIX legs are the control that the launch there is byte-for-byte what it
 * always was: `/bin/bash <script>.sh`.
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
}));

vi.mock("../../data", () => ({
	getProject: mocks.getProject,
	getTask: mocks.getTask,
	updateTask: mocks.updateTask,
}));

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
const isWindows = process.platform === "win32";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getProject.mockResolvedValue(PROJECT);
	mocks.getTask.mockResolvedValue(TASK);
	mocks.updateTask.mockResolvedValue(TASK);
	mocks.getSessionSocket.mockReturnValue("dev3");
	mocks.splitTaskPane.mockResolvedValue({ backend: "native", paneId: "%42" });
	mocks.resolveCommandForAgent.mockResolvedValue({ command: "claude", extraEnv: {} });
});

async function spawnAndReadLaunch(): Promise<{ executable: string; argv: string[] }> {
	await tmuxPtyHandlers.spawnAgentInTask({ taskId: TASK_ID, projectId: PROJECT.id, agentId: "builtin-claude", configId: null });
	expect(mocks.splitTaskPane).toHaveBeenCalledTimes(1);
	return mocks.splitTaskPane.mock.calls[0][0].nativeLaunch;
}

describe(`spawnAgentInTask native launch on ${process.platform}`, () => {
	it("never hands the pane a POSIX shell path that cannot exist here", async () => {
		const launch = await spawnAndReadLaunch();
		if (isWindows) {
			expect(launch.executable).not.toBe("/bin/bash");
			expect(launch.executable).not.toMatch(/^\/bin\//);
		} else {
			expect(launch.executable).toBe("/bin/bash");
		}
	});

	it("launches the generated wrapper in this platform's dialect", async () => {
		const launch = await spawnAndReadLaunch();
		const script = launch.argv[launch.argv.length - 1];
		if (isWindows) {
			expect(launch.executable).toMatch(/(powershell|pwsh)(\.exe)?$/i);
			expect(launch.argv).toContain("-File");
			expect(script).toMatch(/\.ps1$/);
		} else {
			expect(launch.argv).toEqual([script]);
			expect(script).toMatch(/\.sh$/);
		}
	});

	// The same assertion the windows-latest leg makes natively, forced from any
	// platform: it is what makes this regression catchable in a local run and in
	// the ordinary suite, not only on the Windows runner.
	it("resolves PowerShell when the platform reports win32", async () => {
		const real = process.platform;
		const realSystemRoot = process.env.SystemRoot;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		// %SystemRoot% is where the PowerShell 5.1 path comes from; a real Windows
		// session always has it, a simulated one has to supply it.
		process.env.SystemRoot ??= "C:\\Windows";
		try {
			const launch = await spawnAndReadLaunch();
			expect(launch.executable).toMatch(/(powershell|pwsh)(\.exe)?$/i);
			expect(launch.argv).toContain("-File");
			expect(launch.argv[launch.argv.length - 1]).toMatch(/\.ps1$/);
		} finally {
			Object.defineProperty(process, "platform", { value: real, configurable: true });
			if (realSystemRoot === undefined) delete process.env.SystemRoot;
		}
	});

	it("writes the wrapper to the very path it launches", async () => {
		const launch = await spawnAndReadLaunch();
		const [writtenPath] = mocks.writeLaunchScript.mock.calls[0] as unknown as [string];
		expect(launch.argv[launch.argv.length - 1]).toBe(writtenPath);
	});
});
