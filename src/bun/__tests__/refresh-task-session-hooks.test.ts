import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	listSessions: vi.fn(),
	installPaneExitedHooks: vi.fn(async (_session: string, _socket: string) => {}),
	loadProjects: vi.fn(),
	loadVirtualProjects: vi.fn(),
	loadTasks: vi.fn(),
}));

vi.mock("../logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("../data", () => ({ loadProjects: mocks.loadProjects, loadVirtualProjects: mocks.loadVirtualProjects, loadTasks: mocks.loadTasks }));
vi.mock("../pty-server", () => ({ installPaneExitedHooks: mocks.installPaneExitedHooks }));
vi.mock("../tmux", async (importOriginal) => ({
	...(await importOriginal<typeof import("../tmux")>()),
	DEFAULT_TMUX_SOCKET: "dev3",
	tmux: { listSessions: mocks.listSessions },
}));

import { refreshTaskSessionHooks } from "../refresh-task-session-hooks";

const rows = (...names: string[]) => names.map((name) => ({ name, windowCount: 1, createdAt: 0, cwd: "/" }));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadProjects.mockResolvedValue([{ id: "p1" }]);
	mocks.loadVirtualProjects.mockResolvedValue([]);
	mocks.loadTasks.mockResolvedValue([{ id: "t1" }, { id: "t2", tmuxSocket: "dev3-side" }]);
	mocks.listSessions.mockImplementation(async (_format: unknown, opts: { socket: string }) =>
		opts.socket === "dev3" ? rows("dev3-aaaaaaaa", "dev3-pt-bbbbbbbb", "dev3-dev-cccccccc", "dev3-cl-dddddddd", "main") : rows("dev3-eeeeeeee"));
});

describe("refreshTaskSessionHooks", () => {
	it("re-points the hooks of every live task session, on the default socket and on task-specific ones", async () => {
		await refreshTaskSessionHooks();
		expect(mocks.installPaneExitedHooks.mock.calls).toEqual([["dev3-aaaaaaaa", "dev3"], ["dev3-eeeeeeee", "dev3-side"]]);
	});

	it("leaves project terminals, dev servers, cleanup sessions and foreign sessions alone", async () => {
		await refreshTaskSessionHooks();
		const touched = mocks.installPaneExitedHooks.mock.calls.map((call) => call[0]);
		expect(touched).not.toContain("dev3-pt-bbbbbbbb");
		expect(touched).not.toContain("dev3-dev-cccccccc");
		expect(touched).not.toContain("dev3-cl-dddddddd");
		expect(touched).not.toContain("main");
	});

	it("still refreshes the default socket when the task list cannot be read, and skips a socket with no tmux server", async () => {
		mocks.loadProjects.mockRejectedValue(new Error("disk"));
		await refreshTaskSessionHooks();
		expect(mocks.installPaneExitedHooks.mock.calls).toEqual([["dev3-aaaaaaaa", "dev3"]]);

		mocks.installPaneExitedHooks.mockClear();
		mocks.listSessions.mockRejectedValue(new Error("no server"));
		await expect(refreshTaskSessionHooks()).resolves.toBeUndefined();
		expect(mocks.installPaneExitedHooks).not.toHaveBeenCalled();
	});
});
