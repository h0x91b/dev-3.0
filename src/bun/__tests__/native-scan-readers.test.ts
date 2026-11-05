import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../../shared/types";

vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

const mocks = vi.hoisted(() => ({
	backend: vi.fn(() => "native"),
	readPanes: vi.fn(),
}));
vi.mock("../task-terminal-backend", () => ({ taskTerminalBackendIdentity: mocks.backend }));
vi.mock("../task-aux-panes", () => ({
	auxPaneMarker: (taskId: string, _purpose: string, slot?: string) => `/tmp/${taskId}-${slot}.`,
}));
vi.mock("../native-task-panes", () => ({
	nativeTaskIdsOnDisk: () => [],
	nativeTaskPaneRecords: mocks.readPanes,
}));

import { setNativePaneRecordsReader } from "../port-scanner";
import { nativePaneRecordsReader, probeNativeDevServer } from "../native-scan-readers";

const task = { id: "aaaabbbb-1111-2222-3333-444455556666" } as Task;
// host 10 -> shell 11 (primary), host 20 -> shell 21 (dev server)
const tree = new Map<number, number[]>([[1, [10, 20]], [10, [11]], [20, [21]]]);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.backend.mockReturnValue("native");
	mocks.readPanes.mockReturnValue([
		{ paneId: "pane-1", hostPid: 10, shellPid: 11, command: ["zsh", "/tmp/agent.sh"] },
		{ paneId: "pane-2", hostPid: 20, shellPid: 21, command: ["sh", `/tmp/${task.id}-dev-web.sh`] },
	]);
	setNativePaneRecordsReader(nativePaneRecordsReader);
});

describe("probeNativeDevServer", () => {
	it("is null for a task on another backend", async () => {
		mocks.backend.mockReturnValue("tmux");
		expect(await probeNativeDevServer(task, "dev3", "web", tree)).toBeNull();
	});

	it("reports the pane running the named server as alive, with its shell pid", async () => {
		expect(await probeNativeDevServer(task, "", "web", tree)).toEqual({ alive: true, rootPid: 21 });
	});

	it("reports a server with no matching pane as not alive", async () => {
		expect(await probeNativeDevServer(task, "", "api", tree)).toEqual({ alive: false, rootPid: null });
	});

	it("reports a pane whose shell is gone as not alive", async () => {
		expect(await probeNativeDevServer(task, "", "web", new Map([[1, [10, 20]], [10, [11]]]))).toEqual({
			alive: false,
			rootPid: null,
		});
	});
});
