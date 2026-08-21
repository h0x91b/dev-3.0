import { describe, expect, it } from "vitest";
import type { Project, Task } from "../../../shared/types";
import { lifecycleStateFromTask } from "../state";

const project: Project = {
	id: "p1",
	name: "Test",
	path: "/tmp/p1",
	createdAt: new Date(0).toISOString(),
} as Project;

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "t1",
		seq: 1,
		projectId: "p1",
		title: "Test task",
		description: "A test task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		branchName: "dev3/task-test",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		...overrides,
	} as Task;
}

describe("lifecycleStateFromTask — completion ownership", () => {
	it("reads the explicit flag for an ordinary task", () => {
		expect(lifecycleStateFromTask(project, makeTask()).facts.manualCompletion).toBe(false);
		expect(
			lifecycleStateFromTask(project, makeTask({ manualCompletion: true })).facts.manualCompletion,
		).toBe(true);
	});

	// A coordinator outlives any branch it merged, so merge detection must never
	// offer to close it — no matter what the stored flag says.
	it("always hands a coordinator's completion to the human", () => {
		expect(
			lifecycleStateFromTask(project, makeTask({ taskType: "coordinator" })).facts.manualCompletion,
		).toBe(true);
		expect(
			lifecycleStateFromTask(
				project,
				makeTask({ taskType: "coordinator", manualCompletion: false }),
			).facts.manualCompletion,
		).toBe(true);
	});
});
