/**
 * `createNativeTaskSession` must be transactional: either it returns a bound session,
 * or nothing it spawned is left running.
 *
 * A native pane host is detached on purpose, so it outlives the process that started
 * it. That makes a post-spawn failure inside the factory the worst possible place to
 * give up: the panes exist, and the caller never received a handle to reach them, so
 * nobody can clean them up. The factory therefore has to roll back by task id, which
 * needs no handle at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	startNativeTaskPanes: vi.fn(),
	stopNativeTaskPanes: vi.fn(async () => {}),
	bindNativeTaskPane: vi.fn(),
	nativeTaskPanesState: vi.fn(async () => null),
}));

vi.mock("../native-task-panes", () => ({
	startNativeTaskPanes: mocks.startNativeTaskPanes,
	stopNativeTaskPanes: mocks.stopNativeTaskPanes,
	nativeTaskPanesState: mocks.nativeTaskPanesState,
	nativeTaskPaneCommands: vi.fn(async () => []),
	nativeTaskPanesAlive: vi.fn(async () => false),
	splitNativeTaskPane: vi.fn(),
	closeNativeTaskPane: vi.fn(),
	focusNativeTaskPane: vi.fn(),
	writeNativeTaskPane: vi.fn(),
	setNativeTaskPaneLayout: vi.fn(),
	nativeTaskPaneLayout: vi.fn(),
	recoverNativeTaskPanes: vi.fn(),
	nativeTaskPaneCommandsStrict: vi.fn(),
	nativeTaskPaneCommandsOf: vi.fn(() => []),
}));

vi.mock("../native-task-terminal", () => ({
	bindNativeTaskPane: mocks.bindNativeTaskPane,
	NATIVE_PANE_TITLE_ENV: "DEV3_PANE_TITLE",
}));

const TASK_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const LAUNCH = { executable: "/bin/bash", argv: [] };

/** One pane, already spawned — the state the factory is in when binding runs. */
function spawnedPane() {
	return {
		taskId: TASK_ID,
		panes: [{ paneId: "pane-1", sessionId: `dev3-task-${TASK_ID}-pane-1`, hostPid: 4242, shellPid: 4243, cols: 80, rows: 24, alive: true }],
		layout: "",
		activePaneId: "pane-1",
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.stopNativeTaskPanes.mockResolvedValue(undefined);
});

describe("createNativeTaskSession rollback", () => {
	it("tears the spawned panes down when binding the first pane fails", async () => {
		mocks.startNativeTaskPanes.mockResolvedValue(spawnedPane());
		mocks.bindNativeTaskPane.mockRejectedValue(new Error("host died mid-handshake"));
		const { createNativeTaskSession } = await import("../pty-server");

		await expect(
			createNativeTaskSession(TASK_ID, "proj", "/tmp/wt", LAUNCH as never),
		).rejects.toThrow("host died mid-handshake");
		expect(mocks.stopNativeTaskPanes).toHaveBeenCalledWith(TASK_ID);
	});

	it("tears them down when the pane vanishes right after creation", async () => {
		mocks.startNativeTaskPanes.mockResolvedValue(spawnedPane());
		// A null bind is the "vanished" case — no error, but no usable session either.
		mocks.bindNativeTaskPane.mockResolvedValue(null);
		const { createNativeTaskSession } = await import("../pty-server");

		await expect(
			createNativeTaskSession(TASK_ID, "proj", "/tmp/wt", LAUNCH as never),
		).rejects.toThrow(/vanished/);
		expect(mocks.stopNativeTaskPanes).toHaveBeenCalledWith(TASK_ID);
	});

	it("tears them down when the coordinator reports zero panes", async () => {
		mocks.startNativeTaskPanes.mockResolvedValue({ ...spawnedPane(), panes: [] });
		const { createNativeTaskSession } = await import("../pty-server");

		await expect(
			createNativeTaskSession(TASK_ID, "proj", "/tmp/wt", LAUNCH as never),
		).rejects.toThrow(/zero panes/);
		expect(mocks.stopNativeTaskPanes).toHaveBeenCalledWith(TASK_ID);
	});

	it("does not roll back a session that bound successfully", async () => {
		mocks.startNativeTaskPanes.mockResolvedValue(spawnedPane());
		mocks.bindNativeTaskPane.mockResolvedValue({ paneId: "pane-1", hostPid: 4242, shellPid: 4243, detach: vi.fn() });
		const { createNativeTaskSession } = await import("../pty-server");

		await createNativeTaskSession(TASK_ID, "proj", "/tmp/wt", LAUNCH as never);
		expect(mocks.stopNativeTaskPanes).not.toHaveBeenCalled();
	});
});
