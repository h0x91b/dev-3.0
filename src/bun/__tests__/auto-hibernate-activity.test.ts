import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";

vi.mock("../pty-server", () => ({ getNativeTaskOutputTime: vi.fn(), getSessionTmuxName: vi.fn(() => "dev3-task") }));
vi.mock("../tmux", () => ({ PEEK_PANE_FORMAT: {}, DEFAULT_TMUX_SOCKET: "default", tmux: { listPanes: vi.fn() } }));
vi.mock("../native-task-panes", () => ({ nativeTaskPanesState: vi.fn() }));
vi.mock("../instance-broadcast", () => ({ discoverPeerSockets: vi.fn(() => []) }));
vi.mock("../rpc-handlers/shared", () => ({ getActiveContext: vi.fn(() => ({ taskId: null })), isAppForeground: vi.fn(() => false) }));
vi.mock("../rpc-handlers/tmux-pty/dev-servers", () => ({ readLiveDevServerNames: vi.fn(async () => []) }));

import { readAutoHibernateOutputAt } from "../auto-hibernate-activity";
import { getNativeTaskOutputTime } from "../pty-server";
import { tmux } from "../tmux";
import { nativeTaskPanesState } from "../native-task-panes";
import { discoverPeerSockets } from "../instance-broadcast";
import { getActiveContext, isAppForeground } from "../rpc-handlers/shared";
import { readLiveDevServerNames } from "../rpc-handlers/tmux-pty/dev-servers";
import { forgetTaskActivity, isTaskBeingViewed, reportTaskViewer } from "../task-activity";

const task = { id: "task", projectId: "project", terminalBackend: "tmux", tmuxSocket: "task-socket" } as Task;
const rows = (...times: number[]) => times.map(windowActivity => ({ windowActivity })) as never;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(discoverPeerSockets).mockReturnValue([]);
	vi.mocked(isAppForeground).mockReturnValue(false);
	vi.mocked(getActiveContext).mockReturnValue({ taskId: null, projectId: null });
	vi.mocked(readLiveDevServerNames).mockResolvedValue([]);
	vi.mocked(tmux.listPanes).mockResolvedValue(rows(10, 20));
});

afterEach(() => {
	reportTaskViewer("window-a", null, false);
	reportTaskViewer("window-b", null, false);
	forgetTaskActivity(task.id);
});

describe("real automatic hibernation activity probe", () => {
	it("reads the newest tmux window from the task's own socket", async () => {
		expect(await readAutoHibernateOutputAt(task)).toBe(20_000);
		expect(tmux.listPanes).toHaveBeenCalledWith(expect.anything(), { target: "dev3-task", scope: "session", socket: "task-socket" });
	});

	it.each([[], [0], [NaN], [10, Infinity]].map(times => ({ times })))("cannot declare incomplete tmux clocks inactive ($times)", async ({ times }) => {
		vi.mocked(tmux.listPanes).mockResolvedValue(rows(...times));
		expect(await readAutoHibernateOutputAt(task)).toBeNull();
	});

	it("does not borrow a native pane's clock when other panes are unobserved", async () => {
		const native = { ...task, terminalBackend: "native" } as Task;
		vi.mocked(nativeTaskPanesState).mockResolvedValue({ panes: [{ paneId: "one" }, { paneId: "two" }] } as never);
		vi.mocked(getNativeTaskOutputTime).mockReturnValue(null);
		expect(await readAutoHibernateOutputAt(native)).toBeNull();
		expect(getNativeTaskOutputTime).toHaveBeenCalledWith(task.id, ["one", "two"]);
		expect(tmux.listPanes).not.toHaveBeenCalled();
		vi.mocked(getNativeTaskOutputTime).mockReturnValue(30_000);
		expect(await readAutoHibernateOutputAt(native)).toBe(30_000);
	});

	it("cannot declare a missing native session inactive", async () => {
		vi.mocked(nativeTaskPanesState).mockResolvedValue(null);
		expect(await readAutoHibernateOutputAt({ ...task, terminalBackend: "native" })).toBeNull();
	});

	it("protects a live dev server even after its declaration is removed", async () => {
		vi.mocked(readLiveDevServerNames).mockResolvedValue(["removed-from-config"]);
		expect(await readAutoHibernateOutputAt(task)).toBeNull();
		expect(tmux.listPanes).not.toHaveBeenCalled();
	});

	it("pauses when another dev3 instance is running", async () => {
		vi.mocked(discoverPeerSockets).mockReturnValue(["other-instance"]);
		expect(await readAutoHibernateOutputAt(task)).toBeNull();
		expect(readLiveDevServerNames).not.toHaveBeenCalled();
	});

	it("protects the foreground task even without user input", async () => {
		vi.mocked(getActiveContext).mockReturnValue({ taskId: task.id, projectId: task.projectId });
		vi.mocked(isAppForeground).mockReturnValue(true);
		expect(await readAutoHibernateOutputAt(task)).toBeNull();
	});

	it("protects a task viewed by any window or remote client", async () => {
		reportTaskViewer("window-a", task.id, true);
		reportTaskViewer("window-b", task.id, true);
		reportTaskViewer("window-a", null, false);
		expect(await readAutoHibernateOutputAt(task)).toBeNull();
	});

	it("expires a disconnected viewer's lease", () => {
		reportTaskViewer("window-a", task.id, true, 1_000);
		expect(isTaskBeingViewed(task.id, 30_999)).toBe(true);
		expect(isTaskBeingViewed(task.id, 31_000)).toBe(false);
	});

	it("propagates unreadable dev-server and terminal state so callers keep the task awake", async () => {
		vi.mocked(readLiveDevServerNames).mockRejectedValueOnce(new Error("unreadable server"));
		await expect(readAutoHibernateOutputAt(task)).rejects.toThrow("unreadable server");
		vi.mocked(tmux.listPanes).mockRejectedValueOnce(new Error("unreadable terminal"));
		await expect(readAutoHibernateOutputAt(task)).rejects.toThrow("unreadable terminal");
	});
});
