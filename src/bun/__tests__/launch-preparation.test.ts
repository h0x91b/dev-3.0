import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";

vi.mock("../data", () => ({ getTask: vi.fn() }));

import * as data from "../data";
import { awaitLaunchPreparation, preparationOutcomeOf } from "../cli-socket/launch-preparation";

const PROJECT = { id: "p1" } as Project;

function task(overrides: Partial<Task>): Task {
	return { id: "t1", status: "in-progress", ...overrides } as Task;
}

describe("preparationOutcomeOf", () => {
	it("reads a running task in its active column as started", () => {
		expect(preparationOutcomeOf(task({ runtimeState: { runtime: "running", updatedAt: 1 } }))).toEqual({ state: "started" });
	});

	it("carries the persisted preparation error", () => {
		expect(preparationOutcomeOf(task({ status: "todo", preparationError: "worktree missing" })))
			.toEqual({ state: "failed", error: "worktree missing" });
	});

	it("treats a task back in To Do without an error as failed, never as started", () => {
		expect(preparationOutcomeOf(task({ status: "todo" })).state).toBe("failed");
	});

	it("keeps a run in flight as still preparing, legacy flag included", () => {
		expect(preparationOutcomeOf(task({ preparing: true })).state).toBe("still-preparing");
		expect(preparationOutcomeOf(task({ runtimeState: { runtime: "preparing", updatedAt: 1 } })).state).toBe("still-preparing");
	});
});

describe("awaitLaunchPreparation", () => {
	beforeEach(() => vi.clearAllMocks());

	it("gives up at the budget and says it is still preparing", async () => {
		vi.mocked(data.getTask).mockResolvedValue(task({ preparing: true }));

		await expect(awaitLaunchPreparation(PROJECT, "t1", { budgetMs: 0, pollMs: 1 })).resolves.toEqual({ state: "still-preparing" });
	});

	it("polls until the run settles", async () => {
		vi.mocked(data.getTask)
			.mockResolvedValueOnce(task({ preparing: true }))
			.mockResolvedValueOnce(task({ preparing: true }))
			.mockResolvedValue(task({ runtimeState: { runtime: "running", updatedAt: 1 } }));

		await expect(awaitLaunchPreparation(PROJECT, "t1", { pollMs: 1 })).resolves.toEqual({ state: "started" });
		expect(data.getTask).toHaveBeenCalledTimes(3);
	});

	it("reports a task deleted mid-preparation as failed", async () => {
		vi.mocked(data.getTask).mockRejectedValue(new Error("Task not found: t1"));

		await expect(awaitLaunchPreparation(PROJECT, "t1", { pollMs: 1 })).resolves.toMatchObject({ state: "failed" });
	});
});
