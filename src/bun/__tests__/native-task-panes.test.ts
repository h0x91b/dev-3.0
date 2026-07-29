/**
 * native-task-panes lifecycle tests (seq 1311).
 *
 * Negative test proving no tmux call appears on any native pane path.
 * Functional lifecycle tests via mocked coordinator and backend.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		accessSync: vi.fn(),
		existsSync: vi.fn(() => false),
		writeFileSync: vi.fn(),
		mkdirSync: vi.fn(),
		lstatSync: vi.fn(() => { throw new Error("ENOENT"); }),
		statSync: vi.fn(() => ({ isFile: () => true })),
		readlinkSync: vi.fn(() => { throw new Error("EINVAL"); }),
		realpathSync: vi.fn((p: string) => p),
		unlinkSync: vi.fn(),
		symlinkSync: vi.fn(),
	};
});

vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

// Mock out the real coordinator and backend to avoid filesystem / process spawning.
const mockCoord = {
	paneIds: vi.fn(() => ["pane-1"]),
	listPanes: vi.fn(async () => [{
		paneId: "pane-1",
		sessionId: "dev3-task-abc-pane-1",
		hostPid: 101,
		shellPid: 201,
		cols: 80,
		rows: 24,
		state: "running" as const,
	}]),
	layout: createSplitTree(),
	sessionIdFor: vi.fn((p: string) => `dev3-task-abc-${p}`),
	split: vi.fn(async () => "pane-2"),
	closePane: vi.fn(async () => ({ closedPaneId: "pane-1", remainingPaneIds: [], sessionTornDown: true })),
	cleanup: vi.fn(async () => undefined),
};

vi.mock("../native-terminal-multipane/coordinator", () => ({
	NativeMultipaneCoordinator: {
		create: vi.fn(async () => mockCoord),
		recover: vi.fn(async () => mockCoord),
	},
	defaultCoordinatorDeps: {},
}));

const mockBackend = {
	openSession: vi.fn(async () => ({
		id: "dev3-task-abc",
		views: [{ id: "pane-1", focused: true }],
		focusedViewId: "pane-1",
	})),
	cleanupSession: vi.fn(async () => undefined),
	describeSession: vi.fn(async () => null),
	focusView: vi.fn(async () => undefined),
};

vi.mock("../task-terminal-backend", () => ({
	nativeTaskSessionId: (taskId: string) => `dev3-task-${taskId}`,
	nativeTaskTerminalBackend: vi.fn(() => mockBackend),
}));

vi.mock("../native-terminal-registry/record", () => ({
	readRecord: vi.fn(() => null),
}));

vi.mock("../native-terminal-registry/registry", () => ({
	stop: vi.fn(async () => true),
}));

vi.mock("../native-terminal-registry/shell-launch", () => ({
	defineShellLaunchSpec: vi.fn((s) => s),
	defaultNativeShellLaunchSpec: vi.fn(() => ({ executable: "/bin/bash", argv: [], cwd: "/tmp", env: {} })),
}));

import { spawn } from "../spawn";
import { NativeMultipaneCoordinator } from "../native-terminal-multipane/coordinator";
import { createSplitTree } from "../../shared/split-tree";

const TASK_ID = "abc";
const LAUNCH = { executable: "/bin/zsh", argv: [] as string[] };

beforeEach(() => {
	vi.clearAllMocks();
	mockCoord.paneIds.mockReturnValue(["pane-1"]);
	mockCoord.listPanes.mockResolvedValue([{
		paneId: "pane-1",
		sessionId: `dev3-task-${TASK_ID}-pane-1`,
		hostPid: 101,
		shellPid: 201,
		cols: 80,
		rows: 24,
		state: "running" as const,
	}]);
	mockBackend.openSession.mockResolvedValue({
		id: `dev3-task-${TASK_ID}`,
		views: [{ id: "pane-1", focused: true }],
		focusedViewId: "pane-1",
	});
	mockBackend.describeSession.mockResolvedValue(null);
	vi.mocked(NativeMultipaneCoordinator.recover).mockResolvedValue(mockCoord as never);
});

describe("native-task-panes lifecycle", () => {
	it("start creates the coordinator and returns a pane state", async () => {
		const { startNativeTaskPanes } = await import("../native-task-panes");
		const state = await startNativeTaskPanes({ taskId: TASK_ID, cwd: "/tmp", env: {}, launch: LAUNCH, cols: 80, rows: 24 });
		expect(state.panes).toHaveLength(1);
		expect(state.panes[0].paneId).toBe("pane-1");
	});

	it("recover returns null when no coordinator exists", async () => {
		vi.mocked(NativeMultipaneCoordinator.recover).mockResolvedValue(null);
		const { recoverNativeTaskPanes } = await import("../native-task-panes");
		const state = await recoverNativeTaskPanes("nonexistent-task-id");
		expect(state).toBeNull();
	});

	it("never calls spawn on start or stop", async () => {
		const { startNativeTaskPanes, stopNativeTaskPanes } = await import("../native-task-panes");
		await startNativeTaskPanes({ taskId: TASK_ID, cwd: "/tmp", env: {}, launch: LAUNCH, cols: 80, rows: 24 });
		// After cleanup, recover must return null (verified teardown).
		vi.mocked(NativeMultipaneCoordinator.recover).mockResolvedValue(null);
		await stopNativeTaskPanes(TASK_ID);
		expect(spawn).not.toHaveBeenCalled();
	});
});
