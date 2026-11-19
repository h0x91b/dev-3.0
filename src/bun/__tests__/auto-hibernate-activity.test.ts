import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";

vi.mock("../pty-server", () => ({ getNativeTaskOutputTime: vi.fn(), getSessionTmuxName: vi.fn(() => "dev3-task") }));
vi.mock("../tmux", () => ({ PEEK_PANE_FORMAT: "activity", PANE_SPLIT_LAYOUT_FORMAT: "layout", DEFAULT_TMUX_SOCKET: "default", tmux: { listPanes: vi.fn() } }));
vi.mock("../native-task-panes", () => ({ nativeTaskPanesState: vi.fn() }));
vi.mock("../instance-broadcast", () => ({ discoverPeerSockets: vi.fn(() => []) }));
vi.mock("../rpc-handlers/tmux-pty/dev-servers", () => ({ readLiveDevServerNames: vi.fn(async () => []) }));

import { readAutoHibernateOutputAt } from "../auto-hibernate-activity";
import { getNativeTaskOutputTime } from "../pty-server";
import { tmux, PEEK_PANE_FORMAT, PANE_SPLIT_LAYOUT_FORMAT } from "../tmux";
import { nativeTaskPanesState } from "../native-task-panes";
import { discoverPeerSockets } from "../instance-broadcast";
import { readLiveDevServerNames } from "../rpc-handlers/tmux-pty/dev-servers";

const task = { id: "task", projectId: "project", terminalBackend: "tmux", tmuxSocket: "task-socket" } as Task;
const pane = { paneId: "%1", windowActivity: 20, agentTag: "1", dead: false };
const native = { ...task, terminalBackend: "native", sessionState: { panes: [{ paneId: "one", agentCmd: "claude" }] } } as Task;

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(discoverPeerSockets).mockReturnValue([]);
	vi.mocked(readLiveDevServerNames).mockResolvedValue([]);
	vi.mocked(tmux.listPanes).mockResolvedValue([pane] as never);
	vi.mocked(nativeTaskPanesState).mockResolvedValue({ panes: [{ paneId: "one", alive: true }] } as never);
	vi.mocked(getNativeTaskOutputTime).mockReturnValue(30_000);
});

describe("real automatic hibernation eligibility probe", () => {
	it("requires exactly one marked agent pane across every tmux window on the task socket", async () => {
		expect(await readAutoHibernateOutputAt(task)).toBe(20_000);
		expect(tmux.listPanes).toHaveBeenCalledWith(PANE_SPLIT_LAYOUT_FORMAT, { target: "dev3-task", scope: "session", socket: "task-socket" });
		expect(tmux.listPanes).toHaveBeenCalledWith(PEEK_PANE_FORMAT, { target: "dev3-task", scope: "session", socket: "task-socket" });
	});

	it.each([[], [{ ...pane, agentTag: "" }], [{ ...pane, dead: true }], [pane, { ...pane, paneId: "%2", windowId: "@2" }]].map(panes => ({ panes })))("protects a terminal without sole agent ownership (%j)", async ({ panes }) => {
		vi.mocked(tmux.listPanes).mockResolvedValue(panes as never);
		expect(await readAutoHibernateOutputAt(task)).toBeNull();
	});

	it.each([0, NaN, Infinity])("cannot declare invalid tmux clocks inactive (%s)", async windowActivity => {
		vi.mocked(tmux.listPanes).mockResolvedValue([{ ...pane, windowActivity }] as never);
		expect(await readAutoHibernateOutputAt(task)).toBeNull();
	});

	it("protects a pane split between ownership and output observations", async () => {
		vi.mocked(tmux.listPanes).mockResolvedValueOnce([pane] as never).mockResolvedValueOnce([pane, { ...pane, paneId: "%2" }] as never);
		expect(await readAutoHibernateOutputAt(task)).toBeNull();
	});

	it("requires a sole live native agent with recorded attribution", async () => {
		expect(await readAutoHibernateOutputAt(native)).toBe(30_000);
		expect(getNativeTaskOutputTime).toHaveBeenCalledWith(task.id, ["one"]);
		expect(tmux.listPanes).not.toHaveBeenCalled();
		expect(await readAutoHibernateOutputAt({ ...native, sessionState: null })).toBeNull();
		vi.mocked(nativeTaskPanesState).mockResolvedValue({ panes: [{ paneId: "one", alive: true }, { paneId: "two", alive: true }] } as never);
		expect(await readAutoHibernateOutputAt(native)).toBeNull();
	});

	it("does not mistake a parked conversation or a replacement shell for its agent", async () => {
		const entry = native.sessionState!.panes[0];
		expect(await readAutoHibernateOutputAt({ ...native, sessionState: { panes: [{ ...entry, parked: true }] } })).toBeNull();
		expect(await readAutoHibernateOutputAt({ ...native, sessionState: { panes: [{ ...entry, paneId: "old-pane" }] } })).toBeNull();
	});

	it("cannot declare missing or unobserved native output inactive", async () => {
		vi.mocked(getNativeTaskOutputTime).mockReturnValue(null);
		expect(await readAutoHibernateOutputAt(native)).toBeNull();
		vi.mocked(nativeTaskPanesState).mockResolvedValue(null);
		expect(await readAutoHibernateOutputAt(native)).toBeNull();
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

	it("propagates unknown server and terminal state so callers keep tasks awake", async () => {
		vi.mocked(readLiveDevServerNames).mockRejectedValueOnce(new Error("unreadable server"));
		await expect(readAutoHibernateOutputAt(task)).rejects.toThrow("unreadable server");
		vi.mocked(tmux.listPanes).mockRejectedValueOnce(new Error("unreadable terminal"));
		await expect(readAutoHibernateOutputAt(task)).rejects.toThrow("unreadable terminal");
	});
});
