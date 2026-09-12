/**
 * `peekTaskTerminal` is the renderer's only door to a terminal read, and it is
 * reached from a surface that shows several projects at once. The contract this
 * covers is therefore the scoping: the task is resolved inside the named
 * project, never by sweeping every board, so a stale selection cannot answer
 * with another project's terminal.
 */
import { taskPanesHandlers } from "../rpc-handlers/task-panes";
import * as data from "../data";
import { taskPeek } from "../task-peek";

// The handler's module pulls the pane machinery, which reaches Electrobun's
// native bridge at import time. Neither is exercised here.
vi.mock("electrobun/bun", () => ({
	PATHS: { VIEWS_FOLDER: "/fake/views/" },
	Utils: { showNotification: vi.fn(), quit: vi.fn() },
	Updater: {
		localInfo: {
			version: vi.fn().mockResolvedValue("0.0.0-test"),
			hash: vi.fn().mockResolvedValue("deadbeef"),
			channel: vi.fn().mockResolvedValue("dev"),
		},
		updateInfo: vi.fn().mockReturnValue(null),
	},
}));
vi.mock("bun:ffi", () => ({ dlopen: vi.fn(() => ({ symbols: {} })), FFIType: {} }));
vi.mock("../data", () => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
	loadProjects: vi.fn(async () => []),
	loadVirtualProjects: vi.fn(async () => []),
}));
vi.mock("../task-peek", () => ({ taskPeek: vi.fn(async () => ({ taskId: "task-a" })) }));

const getProject = data.getProject as unknown as ReturnType<typeof vi.fn>;
const getTask = data.getTask as unknown as ReturnType<typeof vi.fn>;
const peek = taskPeek as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
	getProject.mockReset();
	getTask.mockReset();
	peek.mockClear();
});

it("resolves the task inside the named project and forwards the peek options", async () => {
	const project = { id: "proj-1" };
	const task = { id: "task-a" };
	getProject.mockResolvedValue(project);
	getTask.mockResolvedValue(task);

	await taskPanesHandlers.peekTaskTerminal({
		taskId: "task-a",
		projectId: "proj-1",
		pane: "%2",
		lines: 60,
	});

	expect(getProject).toHaveBeenCalledWith("proj-1");
	expect(getTask).toHaveBeenCalledWith(project, "task-a");
	expect(peek).toHaveBeenCalledWith({ task, pane: "%2", lines: 60 });
});

it("fails rather than falling back to another board when the task is not in that project", async () => {
	getProject.mockResolvedValue({ id: "proj-1" });
	getTask.mockRejectedValue(new Error("Task not found: task-a"));

	await expect(
		taskPanesHandlers.peekTaskTerminal({ taskId: "task-a", projectId: "proj-1" }),
	).rejects.toThrow(/Task not found/);
	expect(peek).not.toHaveBeenCalled();
});
