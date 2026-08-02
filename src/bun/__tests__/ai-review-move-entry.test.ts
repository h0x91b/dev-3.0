/**
 * AI Review through its PRODUCTION entry point.
 *
 * The board's status control and the native Task menu both call the `moveTask`
 * RPC, which dispatches through the task's lifecycle actor. This file enters
 * there — not at the launch helper — so it can show that the path actually
 * reaches the pane seam, and that a native task's review agent gets a real pane
 * with no tmux anywhere in the chain.
 *
 * Real: `moveTask`, the lifecycle machine and executor, `launchColumnAgent`, and
 * the auxiliary-pane seam. Mocked: the pane runtime, the agent-command resolver,
 * and task storage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../shared/types";

const mocks = vi.hoisted(() => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
	updateTask: vi.fn(),
	resolveProjectConfig: vi.fn(),
	resolveProjectEnv: vi.fn(async () => ({})),
	resolveOperationalProjectConfig: vi.fn(async () => ({ devScript: "", portCount: 0, env: {} })),
	resolveCommandForAgent: vi.fn(),
	setupAgentHooks: vi.fn(async () => ""),
	// native pane runtime
	nativeTaskPanesState: vi.fn(),
	nativeTaskPaneCommands: vi.fn(async () => [] as any[]),
	// Serves the same fake pane list as the tolerant read; the undecidable and
	// unreadable-record cases run against the real discovery path in
	// column-agent-strict-discovery.test.ts.
	nativeTaskPaneCommandsStrict: vi.fn(async () => ({ kind: "read", panes: await mocks.nativeTaskPaneCommands(), unreadable: [] as string[] })),
	nativeTaskPaneCommandsOf: vi.fn(() => [] as any[]),
	splitNativeTaskPane: vi.fn(),
	closeNativeTaskPane: vi.fn(),
	focusNativeTaskPane: vi.fn(),
	// every tmux method reachable from this chain
	tmuxSplitWindow: vi.fn(),
	tmuxSelectPane: vi.fn(),
	tmuxKillPane: vi.fn(),
	tmuxListPanes: vi.fn(),
	tmuxHasSession: vi.fn(async () => false),
	tmuxBinaryPath: vi.fn(() => "/opt/homebrew/bin/tmux"),
}));

const ALL_TMUX_CALLS = [
	mocks.tmuxSplitWindow,
	mocks.tmuxSelectPane,
	mocks.tmuxKillPane,
	mocks.tmuxListPanes,
	mocks.tmuxHasSession,
	mocks.tmuxBinaryPath,
];

// shared.ts reaches bun:ffi at import time (objc helpers); Node cannot resolve it.
vi.mock("bun:ffi", () => ({
	dlopen: vi.fn(() => ({ symbols: {} })),
	FFIType: { ptr: "ptr", function: "function", i32: "i32", void: "void" },
	JSCallback: class {
		ptr = 1;
		close() {}
	},
	CString: class {},
}));

vi.mock("electrobun/bun", () => ({
	PATHS: { VIEWS_FOLDER: "/fake-bundle/Resources/app/views/" },
	Utils: { showMessageBox: vi.fn(), showNotification: vi.fn(), openFileDialog: vi.fn(), quit: vi.fn() },
	Updater: {
		localInfo: {
			version: vi.fn().mockResolvedValue("0.0.0-test"),
			hash: vi.fn().mockResolvedValue("deadbeef"),
			channel: vi.fn().mockResolvedValue("dev"),
		},
		checkForUpdate: vi.fn(),
		downloadUpdate: vi.fn(),
		updateInfo: vi.fn().mockReturnValue(null),
		applyUpdate: vi.fn(),
	},
	BrowserWindow: vi.fn(),
	BrowserView: vi.fn(),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn(() => ({ exitCode: 0, stdout: new Uint8Array() })) }));
vi.mock("../data", () => ({
	getProject: mocks.getProject,
	getTask: mocks.getTask,
	updateTask: mocks.updateTask,
}));
vi.mock("../repo-config", () => ({
	resolveProjectConfig: mocks.resolveProjectConfig,
	resolveProjectEnv: mocks.resolveProjectEnv,
}));
vi.mock("../rpc-handlers/settings-config", () => ({
	resolveOperationalProjectConfig: mocks.resolveOperationalProjectConfig,
}));
vi.mock("../agents", () => ({ resolveCommandForAgent: mocks.resolveCommandForAgent }));
vi.mock("../agent-hooks", () => ({ setupAgentHooks: mocks.setupAgentHooks }));
vi.mock("../artifact-template", () => ({ ensureArtifactTemplateEnv: () => ({}) }));
vi.mock("../native-task-panes", () => ({
	nativeTaskPanesState: mocks.nativeTaskPanesState,
	nativeTaskPaneCommands: mocks.nativeTaskPaneCommands,
	nativeTaskPaneCommandsStrict: mocks.nativeTaskPaneCommandsStrict,
	nativeTaskPaneCommandsOf: mocks.nativeTaskPaneCommandsOf,
	splitNativeTaskPane: mocks.splitNativeTaskPane,
	closeNativeTaskPane: mocks.closeNativeTaskPane,
	focusNativeTaskPane: mocks.focusNativeTaskPane,
	nativeTaskPanesAlive: vi.fn(async () => true),
	stopNativeTaskPanes: vi.fn(),
	recoverNativeTaskPanes: vi.fn(async () => null),
	startNativeTaskPanes: vi.fn(),
	setNativeTaskPaneLayout: vi.fn(),
	nativeTaskPaneLayout: vi.fn(async () => null),
	writeNativeTaskPane: vi.fn(),
}));
vi.mock("../tmux", async (importOriginal) => ({
	...(await importOriginal<typeof import("../tmux")>()),
	tmux: {
		splitWindow: mocks.tmuxSplitWindow,
		selectPane: mocks.tmuxSelectPane,
		killPane: mocks.tmuxKillPane,
		listPanes: mocks.tmuxListPanes,
		hasSession: mocks.tmuxHasSession,
		binaryPath: mocks.tmuxBinaryPath,
	},
}));

const { moveTask } = await import("../rpc-handlers/task-lifecycle");
const { setPushMessage } = await import("../rpc-handlers/shared");
const { _resetLifecycleActorsForTest } = await import("../lifecycle/service");
const { dev3TaskTempPath } = await import("../temp-paths");

const TASK_ID = "cccccccc-0000-0000-0000-000000000003";
const PROJECT = { id: "proj-1", name: "p", path: "/repo", defaultBaseBranch: "main" } as Project;

function nativeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: TASK_ID,
		seq: 77,
		projectId: PROJECT.id,
		title: "Review me",
		description: "",
		status: "review-by-user",
		baseBranch: "main",
		worktreePath: "/repo/wt",
		branchName: "dev3/x",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		terminalBackend: "native",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	} as Task;
}

function paneSet(paneIds: string[]) {
	return {
		taskId: TASK_ID,
		panes: paneIds.map((paneId) => ({
			paneId,
			sessionId: `s-${paneId}`,
			hostPid: 1,
			shellPid: 2,
			cols: 80,
			rows: 24,
			alive: true,
		})),
		layout: null,
		activePaneId: paneIds[0] ?? "",
	} as any;
}

/** Task storage that behaves like the real one: reads see previous writes. */
function trackTask(task: Task): { current: () => Task } {
	let stored = { ...task };
	mocks.getProject.mockResolvedValue(PROJECT);
	mocks.getTask.mockImplementation(async () => ({ ...stored }));
	mocks.updateTask.mockImplementation(async (_project: Project, _taskId: string, updates: Partial<Task>) => {
		stored = { ...stored, ...updates, updatedAt: new Date().toISOString() };
		return { ...stored };
	});
	return { current: () => stored };
}

beforeEach(async () => {
	vi.clearAllMocks();
	await _resetLifecycleActorsForTest();
	setPushMessage(undefined as never);
	mocks.resolveProjectConfig.mockImplementation(async (project: Project) => project);
	mocks.resolveProjectEnv.mockResolvedValue({});
	mocks.resolveCommandForAgent.mockResolvedValue({
		command: "claude 'review this branch'",
		agent: { id: "builtin-claude", name: "Claude", baseCommand: "claude", configurations: [], defaultConfigId: "" },
		config: undefined,
		extraEnv: {},
	} as never);
	mocks.setupAgentHooks.mockResolvedValue("" as never);
	mocks.nativeTaskPanesState.mockResolvedValue(paneSet(["pane-1"]));
	mocks.nativeTaskPaneCommands.mockResolvedValue([]);
	mocks.splitNativeTaskPane.mockResolvedValue({ paneId: "pane-2", state: paneSet(["pane-1", "pane-2"]) });
	mocks.closeNativeTaskPane.mockResolvedValue({ sessionTornDown: false, state: paneSet(["pane-1"]) });
	mocks.focusNativeTaskPane.mockResolvedValue(paneSet(["pane-1", "pane-2"]));
});

describe("moveTask → AI Review on a native task", () => {
	it("opens the review agent in a real native pane and never touches tmux", async () => {
		trackTask(nativeTask());

		const moved = await moveTask({ taskId: TASK_ID, projectId: PROJECT.id, newStatus: "review-by-ai" });

		expect(moved.status).toBe("review-by-ai");
		const [taskId, anchor, orientation, viewSpec] = mocks.splitNativeTaskPane.mock.calls[0] as any[];
		expect(taskId).toBe(TASK_ID);
		expect(anchor).toBe("pane-1");
		expect(orientation).toBe("horizontal");
		expect(viewSpec.launch.argv[0]).toContain("col-agent.sh");
		expect(viewSpec.cwd).toBe("/repo/wt");
		for (const call of ALL_TMUX_CALLS) expect(call).not.toHaveBeenCalled();
	});

	it("replaces a review pane a previous activation owns, so a second move yields one agent", async () => {
		trackTask(nativeTask());
		const owned = new Set(["pane-9"]);
		mocks.nativeTaskPaneCommands.mockImplementation(async () =>
			[...owned].map((paneId) => ({
				paneId,
				sessionId: `s-${paneId}`,
				command: ["/bin/bash", dev3TaskTempPath(TASK_ID, "col-agent.sh")],
				shellPid: 3,
				alive: true,
			})),
		);
		mocks.closeNativeTaskPane.mockImplementation(async (_taskId: string, paneId: string) => {
			owned.delete(paneId);
			return { sessionTornDown: false, state: paneSet(["pane-1"]) };
		});

		await moveTask({ taskId: TASK_ID, projectId: PROJECT.id, newStatus: "review-by-ai" });

		expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-9");
		expect(mocks.splitNativeTaskPane).toHaveBeenCalledTimes(1);
	});

	it("parks the task back in Your Review and reports why when its terminal is not running", async () => {
		const tracked = trackTask(nativeTask());
		mocks.nativeTaskPanesState.mockResolvedValue(null);
		const push = vi.fn();
		setPushMessage(push as never);

		await moveTask({ taskId: TASK_ID, projectId: PROJECT.id, newStatus: "review-by-ai" });

		expect(mocks.splitNativeTaskPane).not.toHaveBeenCalled();
		expect(tracked.current().status).toBe("review-by-user");
		const payload = push.mock.calls.find((call) => call[0] === "columnAgentFailed")?.[1];
		expect(payload).toMatchObject({
			column: { kind: "builtin", status: "review-by-ai" },
			reason: "terminal-not-running",
			movedTo: "review-by-user",
		});
		for (const call of ALL_TMUX_CALLS) expect(call).not.toHaveBeenCalled();
	});

	it("does not claim a move when the fallback column write is rejected", async () => {
		// The guarded fallback write loses its race (someone moved the card first), so
		// the task never lands in Your Review — and the toast must not say it did.
		const task = nativeTask();
		let stored = { ...task };
		mocks.getProject.mockResolvedValue(PROJECT);
		mocks.getTask.mockImplementation(async () => ({ ...stored }));
		mocks.updateTask.mockImplementation(async (_project: Project, _taskId: string, updates: Partial<Task>, options?: any) => {
			if (options?.ifStatus === "review-by-ai") return { ...stored, status: "in-progress" } as Task;
			stored = { ...stored, ...updates, updatedAt: new Date().toISOString() };
			return { ...stored };
		});
		mocks.nativeTaskPanesState.mockResolvedValue(null);
		const push = vi.fn();
		setPushMessage(push as never);

		await moveTask({ taskId: TASK_ID, projectId: PROJECT.id, newStatus: "review-by-ai" });

		expect(push.mock.calls.some((call) => call[0] === "columnAgentFailed")).toBe(false);
	});
});
