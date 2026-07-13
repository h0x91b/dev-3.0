import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Project, Task } from "../../shared/types";

// Self-hosted dev-server guard (issues #910/#920): when dev-3.0's own devScript
// (`bun run dev`) boots a dev3 app instance INSIDE the task's dev tmux session,
// that guest instance can end up serving `devServer.stop`/`restart` for the very
// session that hosts it. The verified teardown SIGTERMs the session's full
// process tree — including the serving process — so the RPC reply was never
// written ("Empty response from server", then refused reconnects). The guard:
//   - stop:   reply first with the projected stopped state, tear down after the
//             reply has flushed (deferred);
//   - restart/start-over-running: refuse with a clear error — a guest cannot
//             outlive the teardown that a restart of its own host requires.

// ---- Mocks ----

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	realpathSync: vi.fn((p: string) => p),
}));

vi.mock("../data", () => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
}));

vi.mock("../pty-server", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	tmuxArgs: vi.fn((_socket: string, ...args: string[]) => ["tmux", ...args]),
	getTmuxBinary: vi.fn(() => "/usr/bin/tmux"),
	tmuxClientCwd: vi.fn(() => "/"),
	spawnTmux: vi.fn(() => ({ exited: Promise.resolve(0), stdout: undefined, stderr: undefined })),
	isTmuxSpawnError: vi.fn(() => false),
	capturePane: vi.fn(),
}));

vi.mock("../agents", () => ({}));
vi.mock("../repo-config", () => ({}));

vi.mock("../port-pool", () => ({
	getPortAssignments: vi.fn(() => []),
	allocatePorts: vi.fn(async () => []),
	buildPortEnv: vi.fn(() => ({})),
}));

vi.mock("../port-scanner", () => ({
	buildProcessTree: vi.fn(async () => new Map<number, number[]>()),
	clearPortDataForTask: vi.fn(),
	collectDescendants: vi.fn(() => []),
	collectTaskPids: vi.fn(async () => new Set<number>()),
	findPortHolders: vi.fn(async () => []),
	getLsofOutput: vi.fn(async () => ""),
	getPortsForTask: vi.fn(() => []),
	getSessionPanePids: vi.fn(async () => [123]),
	parseLsofOutput: vi.fn(() => []),
	scanTaskPorts: vi.fn(async () => []),
	waitForPortsFree: vi.fn(async () => []),
}));

vi.mock("../process-reaper", () => ({
	getPidCwd: vi.fn(async () => null),
	terminatePidsVerified: vi.fn(async () => []),
}));

vi.mock("../resource-monitor", () => ({
	getResourceUsage: vi.fn(() => undefined),
}));

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

vi.mock("../tmux-alt-click", () => ({
	ALT_CLICK_PANE_FORMAT: "",
	altClickIneligibleReason: vi.fn(() => null),
	computeAltClickKeys: vi.fn(() => []),
	findAltClickPane: vi.fn(() => null),
	parseAltClickPanes: vi.fn(() => []),
}));

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
	resolveOperationalProjectConfig: vi.fn(async () => ({ devScript: "bun run dev", portCount: 0 })),
}));

import * as data from "../data";
import { clearPortDataForTask } from "../port-scanner";
import { terminatePidsVerified } from "../process-reaper";

const { stopDevServer, restartDevServer, runDevServer } = await import("../rpc-handlers/tmux-pty");

// ---- Fixtures ----

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";

function makeProject(): Project {
	return {
		id: "proj-1",
		name: "dev-3.0",
		path: "/tmp/dev-3.0",
		setupScript: "",
		devScript: "bun run dev",
		cleanupScript: "",
	} as Project;
}

function makeTask(): Task {
	return {
		id: TASK_ID,
		seq: 1,
		title: "t",
		description: "t",
		status: "in-progress",
		worktreePath: "/tmp/wt",
		tmuxSocket: "dev3",
	} as unknown as Task;
}

const REAL_DEV3_TASK_ID = process.env.DEV3_TASK_ID;

beforeEach(() => {
	vi.clearAllMocks();
	delete process.env.DEV3_TASK_ID;
	vi.mocked(data.getProject).mockResolvedValue(makeProject());
	vi.mocked(data.getTask).mockResolvedValue(makeTask());
});

afterEach(() => {
	if (REAL_DEV3_TASK_ID === undefined) {
		delete process.env.DEV3_TASK_ID;
	} else {
		process.env.DEV3_TASK_ID = REAL_DEV3_TASK_ID;
	}
	vi.useRealTimers();
});

describe("stopDevServer — self-hosted guard", () => {
	it("replies before teardown when this instance is hosted by the target task", async () => {
		vi.useFakeTimers();
		process.env.DEV3_TASK_ID = TASK_ID;

		const status = await stopDevServer({ taskId: TASK_ID, projectId: "proj-1" });

		// The reply is built and returned WITHOUT reaping anything — reaping the
		// dev session's tree would SIGTERM this very process mid-request.
		expect(status.running).toBe(false);
		expect(terminatePidsVerified).not.toHaveBeenCalled();
		expect(clearPortDataForTask).not.toHaveBeenCalled();

		// Teardown still happens — deferred until after the reply has flushed.
		await vi.advanceTimersByTimeAsync(2000);
		expect(terminatePidsVerified).toHaveBeenCalledWith([123], expect.anything());
		expect(clearPortDataForTask).toHaveBeenCalledWith(TASK_ID);
	});

	it("tears down synchronously (verified) when serving another task's stop", async () => {
		process.env.DEV3_TASK_ID = "99999999-9999-9999-9999-999999999999";

		const status = await stopDevServer({ taskId: TASK_ID, projectId: "proj-1" });

		expect(status.taskId).toBe(TASK_ID);
		expect(terminatePidsVerified).toHaveBeenCalled();
		expect(clearPortDataForTask).toHaveBeenCalledWith(TASK_ID);
	});

	it("tears down synchronously when not launched from any task context", async () => {
		const status = await stopDevServer({ taskId: TASK_ID, projectId: "proj-1" });

		expect(status.taskId).toBe(TASK_ID);
		expect(terminatePidsVerified).toHaveBeenCalled();
	});
});

describe("restartDevServer — self-hosted guard", () => {
	it("refuses to restart its own host session with a clear error", async () => {
		process.env.DEV3_TASK_ID = TASK_ID;

		await expect(
			restartDevServer({ taskId: TASK_ID, projectId: "proj-1" }),
		).rejects.toThrow(/cannot restart itself/);
		expect(terminatePidsVerified).not.toHaveBeenCalled();
	});
});

describe("runDevServer — self-hosted guard", () => {
	it("refuses start-over-running for its own host session instead of killing itself", async () => {
		process.env.DEV3_TASK_ID = TASK_ID;

		await expect(
			runDevServer({ taskId: TASK_ID, projectId: "proj-1" }),
		).rejects.toThrow(/hosts the dev3 app instance/);
		expect(terminatePidsVerified).not.toHaveBeenCalled();
	});
});
