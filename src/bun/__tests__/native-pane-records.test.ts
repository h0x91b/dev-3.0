import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

const records = vi.hoisted(() => ({
	listCoordinatorIds: vi.fn((): string[] => []),
	readMultipaneRecord: vi.fn(),
	readRecord: vi.fn(),
}));
vi.mock("../native-terminal-multipane/record", async (importActual) => ({
	...(await importActual<typeof import("../native-terminal-multipane/record")>()),
	listCoordinatorIds: records.listCoordinatorIds,
	readMultipaneRecord: records.readMultipaneRecord,
}));
vi.mock("../native-terminal-registry/record", async (importActual) => ({
	...(await importActual<typeof import("../native-terminal-registry/record")>()),
	readRecord: records.readRecord,
}));

import { nativeTaskIdsOnDisk, nativeTaskPaneRecords } from "../native-task-panes";

const TASK = "natv1234-aaaa-bbbb-cccc-ddddeeeeffff";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("native pane records seam", () => {
	it("lists only task coordinators, as task ids", () => {
		records.listCoordinatorIds.mockReturnValue([`dev3-task-${TASK}`, "other-coordinator"]);
		expect(nativeTaskIdsOnDisk()).toEqual([TASK]);
	});

	it("reads each pane's host, shell and command from the records, skipping a pane with no record", () => {
		records.readMultipaneRecord.mockReturnValue({
			panes: [{ paneId: "pane-1", sessionId: "s1" }, { paneId: "pane-2", sessionId: "s2" }],
		});
		records.readRecord.mockImplementation((id: string) =>
			id === "s1" ? { host: { pid: 10 }, shell: { pid: 11, command: ["sh", "run.sh"] } } : null);

		expect(nativeTaskPaneRecords(TASK)).toEqual([{ paneId: "pane-1", hostPid: 10, shellPid: 11, command: ["sh", "run.sh"] }]);
		expect(records.readMultipaneRecord).toHaveBeenCalledWith(`dev3-task-${TASK}`);
	});

	it("is empty when the task has no coordinator record", () => {
		records.readMultipaneRecord.mockReturnValue(null);
		expect(nativeTaskPaneRecords(TASK)).toEqual([]);
	});
});
