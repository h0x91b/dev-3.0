import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Project, Task } from "../../shared/types";

const tempHome = mkdtempSync(join(tmpdir(), "dev3-data-race-"));
const dev3Home = join(tempHome, ".dev3.0");
const originalHome = process.env.HOME;

function makeProject(overrides?: Partial<Project>): Project {
	return {
		id: "proj-1",
		name: "Race Test Project",
		path: "/tmp/race-test-project",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-04-15T00:00:00.000Z",
		labels: [],
		...overrides,
	};
}

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "task-1",
		seq: 1,
		projectId: "proj-1",
		title: "Race task",
		description: "Race task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-04-15T00:00:00.000Z",
		updatedAt: "2026-04-15T00:00:00.000Z",
		notes: [],
		...overrides,
	};
}

describe("data race-safe mutators", () => {
	beforeEach(() => {
		vi.resetModules();
		process.env.HOME = tempHome;
		rmSync(tempHome, { recursive: true, force: true });
		mkdirSync(dev3Home, { recursive: true });
	});

	afterAll(() => {
		process.env.HOME = originalHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("preserves both concurrent project label appends", async () => {
		const data = await import("../data");
		const project = makeProject({
			labels: [{ id: "base", name: "Base", color: "#ef4444" }],
		});
		writeFileSync(join(dev3Home, "projects.json"), JSON.stringify([project], null, 2));

		const results = await Promise.all([
			data.updateProjectWith(project.id, async (currentProject) => ({
				updates: {
					labels: [...(currentProject.labels ?? []), { id: "one", name: "One", color: "#3b82f6" }],
				},
				result: undefined,
			})),
			data.updateProjectWith(project.id, async (currentProject) => ({
				updates: {
					labels: [...(currentProject.labels ?? []), { id: "two", name: "Two", color: "#22c55e" }],
				},
				result: undefined,
			})),
		]);

		expect(results.map(({ project: updatedProject }) => updatedProject.labels?.length ?? 0).sort()).toEqual([2, 3]);
		const mergedLabels = results.find(({ project: updatedProject }) => (updatedProject.labels?.length ?? 0) === 3)?.project.labels;
		expect(mergedLabels?.map((label) => label.name).sort()).toEqual(["Base", "One", "Two"]);
	});

	it("preserves both concurrent task note appends", async () => {
		const data = await import("../data");
		const project = makeProject();
		const task = makeTask({
			notes: [{ id: "base-note", content: "Base", source: "user", createdAt: "2026-04-15T00:00:00.000Z", updatedAt: "2026-04-15T00:00:00.000Z" }],
		});
		writeFileSync(join(dev3Home, "projects.json"), JSON.stringify([project], null, 2));
		mkdirSync(join(dev3Home, "data", "tmp-race-test-project"), { recursive: true });
		writeFileSync(join(dev3Home, "data", "tmp-race-test-project", "tasks.json"), JSON.stringify([task], null, 2));

		const results = await Promise.all([
			data.updateTaskWith(project, task.id, async (currentTask) => ({
				updates: {
					notes: [...(currentTask.notes ?? []), { id: "note-1", content: "One", source: "user", createdAt: "2026-04-15T00:00:01.000Z", updatedAt: "2026-04-15T00:00:01.000Z" }],
				},
				result: undefined,
			})),
			data.updateTaskWith(project, task.id, async (currentTask) => ({
				updates: {
					notes: [...(currentTask.notes ?? []), { id: "note-2", content: "Two", source: "ai", createdAt: "2026-04-15T00:00:02.000Z", updatedAt: "2026-04-15T00:00:02.000Z" }],
				},
				result: undefined,
			})),
		]);

		expect(results.map(({ task: updatedTask }) => updatedTask.notes?.length ?? 0).sort()).toEqual([2, 3]);
		const mergedNotes = results.find(({ task: updatedTask }) => (updatedTask.notes?.length ?? 0) === 3)?.task.notes;
		expect(mergedNotes?.map((note) => note.content).sort()).toEqual(["Base", "One", "Two"]);
	});
});
