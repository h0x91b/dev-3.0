import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The scheduler imports the task-creation pipeline (which transitively pulls in
// Electrobun); stub the heavy modules out and drive ticks via fake timers.
vi.mock("../data", () => ({
	loadProjects: vi.fn(async () => []),
	loadVirtualProjects: vi.fn(async () => []),
	loadTasks: vi.fn(async () => []),
	updateTask: vi.fn(async () => undefined),
}));
vi.mock("../rpc-handlers/task-lifecycle", () => ({ fireScheduledLaunch: vi.fn(async () => undefined) }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as data from "../data";
import { fireScheduledLaunch } from "../rpc-handlers/task-lifecycle";
import { startScheduledLaunchScheduler, stopScheduledLaunchScheduler } from "../scheduled-launch-scheduler";

const project = { id: "proj-1" } as never;

function makeTask(overrides: Record<string, unknown> = {}) {
	return {
		id: "task-12345678",
		status: "todo",
		scheduledLaunch: { at: new Date(Date.now() - 1000).toISOString() },
		...overrides,
	};
}

async function flush() {
	// Let the immediate first tick's promise chain settle.
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
	vi.mocked(data.loadProjects).mockResolvedValue([project]);
	vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
});

afterEach(() => {
	stopScheduledLaunchScheduler();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("scheduled-launch scheduler", () => {
	it("fires a due launch on the first (startup) tick — offline catch-up", async () => {
		const task = makeTask();
		vi.mocked(data.loadTasks).mockResolvedValue([task] as never);
		startScheduledLaunchScheduler();
		await flush();
		expect(fireScheduledLaunch).toHaveBeenCalledTimes(1);
		expect(fireScheduledLaunch).toHaveBeenCalledWith(project, task);
	});

	it("does not fire launches scheduled in the future", async () => {
		const task = makeTask({ scheduledLaunch: { at: new Date(Date.now() + 3_600_000).toISOString() } });
		vi.mocked(data.loadTasks).mockResolvedValue([task] as never);
		startScheduledLaunchScheduler();
		await flush();
		expect(fireScheduledLaunch).not.toHaveBeenCalled();
	});

	it("ignores stale scheduledLaunch on non-todo tasks", async () => {
		const task = makeTask({ status: "in-progress" });
		vi.mocked(data.loadTasks).mockResolvedValue([task] as never);
		startScheduledLaunchScheduler();
		await flush();
		expect(fireScheduledLaunch).not.toHaveBeenCalled();
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("clears an unparseable schedule instead of firing", async () => {
		const task = makeTask({ scheduledLaunch: { at: "not-a-date" } });
		vi.mocked(data.loadTasks).mockResolvedValue([task] as never);
		startScheduledLaunchScheduler();
		await flush();
		expect(fireScheduledLaunch).not.toHaveBeenCalled();
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { scheduledLaunch: null });
	});

	it("clears the schedule when firing fails (no retry-forever)", async () => {
		const task = makeTask();
		vi.mocked(data.loadTasks).mockResolvedValue([task] as never);
		vi.mocked(fireScheduledLaunch).mockRejectedValueOnce(new Error("boom"));
		startScheduledLaunchScheduler();
		await flush();
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { scheduledLaunch: null });
	});

	it("start is idempotent and a failing project does not block others", async () => {
		const project2 = { id: "proj-2" } as never;
		vi.mocked(data.loadProjects).mockResolvedValue([project, project2]);
		const task = makeTask();
		vi.mocked(data.loadTasks)
			.mockRejectedValueOnce(new Error("proj-1 unreadable"))
			.mockResolvedValueOnce([task] as never);
		startScheduledLaunchScheduler();
		startScheduledLaunchScheduler(); // second call must be a no-op
		await flush();
		expect(fireScheduledLaunch).toHaveBeenCalledTimes(1);
		expect(fireScheduledLaunch).toHaveBeenCalledWith(project2, task);
	});
});
