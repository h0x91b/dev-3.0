import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../shared/types";

vi.mock("../../data", () => ({ getProject: vi.fn(), getTask: vi.fn() }));
vi.mock("../../settings", () => ({ loadSettings: vi.fn(async () => ({ autoHibernateMinutes: 10 })) }));
vi.mock("../../auto-hibernate-activity", () => ({ readAutoHibernateOutputAt: vi.fn() }));
vi.mock("../executor", () => ({ executeLifecycleEffect: vi.fn(async () => ({})), launchLifecycleColumnAgent: vi.fn() }));
vi.mock("../../preparation-runtime", () => ({ forgetTaskPreparation: vi.fn(), markTaskPreparationCancelled: vi.fn() }));
vi.mock("../../claude-session-watch", () => ({ claudeSessionWatches: { close: vi.fn(), forgetTask: vi.fn() } }));
vi.mock("../../rpc-handlers/shared", () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

import * as data from "../../data";
import { readAutoHibernateOutputAt } from "../../auto-hibernate-activity";
import { executeLifecycleEffect } from "../executor";
import { dispatchGuardedLifecycleEvent, _resetLifecycleActorsForTest } from "../service";
import { confirmAutoHibernate } from "../../auto-hibernate-guard";
import { forgetTaskActivity } from "../../task-activity";

const now = Date.UTC(2026, 9, 26);
const lastActivityAt = now - 10 * 60_000;
const task = { id: "task", projectId: "project", status: "user-questions", worktreePath: "/worktree", terminalBackend: "tmux", createdAt: new Date(lastActivityAt).toISOString() } as Task;

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(Date, "now").mockReturnValue(now);
	vi.mocked(data.getProject).mockResolvedValue({ id: "project" } as Project);
	vi.mocked(data.getTask).mockResolvedValue(task);
});

afterEach(async () => {
	await _resetLifecycleActorsForTest();
	forgetTaskActivity(task.id);
	vi.restoreAllMocks();
});

describe("automatic hibernation actor recheck", () => {
	it.each([now, null])("cancels teardown if terminal output became fresh or unreadable (%s)", async outputAt => {
		vi.mocked(readAutoHibernateOutputAt).mockResolvedValue(outputAt);
		await dispatchGuardedLifecycleEvent("project", task.id,
			{ type: "hibernateRequested", inactivity: { lastActivityAt, timeoutMinutes: 10 } },
			current => confirmAutoHibernate(current, { lastActivityAt, timeoutMinutes: 10 }));
		expect(readAutoHibernateOutputAt).toHaveBeenCalledWith(task);
		expect(executeLifecycleEffect).not.toHaveBeenCalled();
	});

	it("cancels teardown if the fresh activity probe fails", async () => {
		vi.mocked(readAutoHibernateOutputAt).mockRejectedValue(new Error("probe failed"));
		await dispatchGuardedLifecycleEvent("project", task.id,
			{ type: "hibernateRequested", inactivity: { lastActivityAt, timeoutMinutes: 10 } },
			current => confirmAutoHibernate(current, { lastActivityAt, timeoutMinutes: 10 }));
		expect(executeLifecycleEffect).not.toHaveBeenCalled();
	});

	it("executes ordinary hibernation after confirming the terminal is still inactive", async () => {
		vi.mocked(readAutoHibernateOutputAt).mockResolvedValue(lastActivityAt);
		await dispatchGuardedLifecycleEvent("project", task.id,
			{ type: "hibernateRequested", inactivity: { lastActivityAt, timeoutMinutes: 10 } },
			current => confirmAutoHibernate(current, { lastActivityAt, timeoutMinutes: 10 }));
		expect(executeLifecycleEffect).toHaveBeenCalled();
	});
});
