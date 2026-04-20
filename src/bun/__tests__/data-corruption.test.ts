import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Project, Task } from "../../shared/types";

const tempHome = mkdtempSync(join(tmpdir(), "dev3-data-corruption-"));
const dev3Home = join(tempHome, ".dev3.0");
const originalHome = process.env.HOME;

function makeProject(overrides?: Partial<Project>): Project {
	return {
		id: "proj-1",
		name: "Existing Project",
		path: "/tmp/existing-project",
		setupScript: "",
		setupScriptLaunchMode: "parallel",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-04-15T00:00:00.000Z",
		labels: [],
		customColumns: [],
		...overrides,
	};
}

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "task-1",
		seq: 1,
		projectId: "proj-1",
		title: "Existing task",
		description: "Existing task",
		status: "todo",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-04-15T00:00:00.000Z",
		updatedAt: "2026-04-15T00:00:00.000Z",
		labelIds: [],
		notes: [],
		customTitle: null,
		customColumnId: null,
		...overrides,
	};
}

describe("data corruption guards", () => {
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

	it("refuses to overwrite projects.json after a parse failure", async () => {
		const existingProject = makeProject();
		const projectsFile = join(dev3Home, "projects.json");
		writeFileSync(projectsFile, JSON.stringify([existingProject], null, 2));
		writeFileSync(projectsFile, "{");

		const data = await import("../data");

		await expect(data.loadProjects()).resolves.toEqual([]);
		await expect(data.addProject("/tmp/new-project", "New Project")).rejects.toThrow(data.DataFileReadError);
		expect(readFileSync(projectsFile, "utf8")).toBe("{");
	});

	it("refuses to overwrite tasks.json after a parse failure", async () => {
		const project = makeProject();
		const existingTask = makeTask();
		const tasksDir = join(dev3Home, "data", "tmp-existing-project");
		const tasksFile = join(tasksDir, "tasks.json");

		writeFileSync(join(dev3Home, "projects.json"), JSON.stringify([project], null, 2));
		mkdirSync(tasksDir, { recursive: true });
		writeFileSync(tasksFile, JSON.stringify([existingTask], null, 2));
		writeFileSync(tasksFile, "{");

		const data = await import("../data");

		await expect(data.loadTasks(project)).resolves.toEqual([]);
		await expect(data.addTask(project, "New task")).rejects.toThrow(data.DataFileReadError);
		expect(readFileSync(tasksFile, "utf8")).toBe("{");
	});
});
