import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Project, Task } from "../../shared/types";

// Mock node:fs/promises so we can simulate a crash *during* the JSON payload
// write (power loss / kill -9 between truncate and full write). Backups and
// every other fs operation use the real implementation. The crash is injected
// only when explicitly armed, and only for the main projects.json / tasks.json
// payload write (NOT the *.bak sibling).
let crashArmed = false;
vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	const isMainPayloadWrite = (p: string): boolean => {
		if (p.includes(".bak")) return false;
		return p.includes("projects.json") || p.includes("tasks.json");
	};
	return {
		...actual,
		writeFile: vi.fn(async (path: any, data: any, opts?: any) => {
			const p = String(path);
			if (crashArmed && isMainPayloadWrite(p)) {
				// Emulate truncate + partial write, then the process dies.
				await actual.writeFile(p, String(data).slice(0, 3));
				throw new Error("simulated crash mid-write");
			}
			return actual.writeFile(path, data, opts);
		}),
	};
});

const tempHome = mkdtempSync(join(tmpdir(), "dev3-atomic-write-"));
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

function listTempSiblings(dir: string): string[] {
	return readdirSync(dir).filter((f) => f.includes(".tmp"));
}

describe("atomic JSON writes survive a crash mid-write", () => {
	beforeEach(() => {
		crashArmed = false;
		vi.resetModules();
		process.env.HOME = tempHome;
		rmSync(tempHome, { recursive: true, force: true });
		mkdirSync(dev3Home, { recursive: true });
	});

	afterEach(() => {
		crashArmed = false;
	});

	afterAll(() => {
		process.env.HOME = originalHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("keeps projects.json valid when the save crashes mid-write", async () => {
		const original = [makeProject()];
		const projectsFile = join(dev3Home, "projects.json");
		writeFileSync(projectsFile, JSON.stringify(original, null, 2));

		const data = await import("../data");

		crashArmed = true;
		await expect(data.saveProjects([makeProject(), makeProject({ id: "proj-2", path: "/tmp/p2" })])).rejects.toThrow();
		crashArmed = false;

		// The atomic write must NOT have corrupted the live file.
		const content = readFileSync(projectsFile, "utf8");
		expect(() => JSON.parse(content)).not.toThrow();
		expect(JSON.parse(content)).toEqual(original);

		// No leftover temp file after the failed save.
		expect(listTempSiblings(dev3Home)).toHaveLength(0);
	});

	it("keeps tasks.json valid when the save crashes mid-write", async () => {
		const project = makeProject();
		const original = [makeTask()];
		const tasksDir = join(dev3Home, "data", "tmp-existing-project");
		const tasksFile = join(tasksDir, "tasks.json");
		writeFileSync(join(dev3Home, "projects.json"), JSON.stringify([project], null, 2));
		mkdirSync(tasksDir, { recursive: true });
		writeFileSync(tasksFile, JSON.stringify(original, null, 2));

		const data = await import("../data");

		crashArmed = true;
		await expect(
			data.saveTasks(project, [makeTask(), makeTask({ id: "task-2", seq: 2 })]),
		).rejects.toThrow();
		crashArmed = false;

		const content = readFileSync(tasksFile, "utf8");
		expect(() => JSON.parse(content)).not.toThrow();
		expect(JSON.parse(content)).toEqual(original);

		expect(listTempSiblings(tasksDir)).toHaveLength(0);
	});
});

describe("atomic JSON writes stay backward-compatible on success", () => {
	beforeEach(() => {
		crashArmed = false;
		vi.resetModules();
		process.env.HOME = tempHome;
		rmSync(tempHome, { recursive: true, force: true });
		mkdirSync(dev3Home, { recursive: true });
	});

	afterAll(() => {
		process.env.HOME = originalHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("writes projects.json with the exact same JSON format as the old in-place path", async () => {
		const projects = [makeProject(), makeProject({ id: "proj-2", path: "/tmp/p2" })];
		const projectsFile = join(dev3Home, "projects.json");

		const data = await import("../data");
		await data.saveProjects(projects);

		const content = readFileSync(projectsFile, "utf8");
		// Byte-identical to what an older version writes (JSON.stringify(.., null, 2)).
		expect(content).toBe(JSON.stringify(projects, null, 2));
		// Old read path parses it unchanged.
		expect(JSON.parse(content)).toEqual(projects);
		// No temp file leftover after a successful save.
		expect(listTempSiblings(dev3Home)).toHaveLength(0);
	});

	it("writes tasks.json with the exact same JSON format and keeps the backup layout", async () => {
		const project = makeProject();
		const tasksDir = join(dev3Home, "data", "tmp-existing-project");
		const tasksFile = join(tasksDir, "tasks.json");
		mkdirSync(tasksDir, { recursive: true });
		// Seed an existing tasks.json so a backup is produced on the next save.
		writeFileSync(tasksFile, JSON.stringify([makeTask()], null, 2));

		const tasks = [makeTask(), makeTask({ id: "task-2", seq: 2 })];

		const data = await import("../data");
		await data.saveTasks(project, tasks);

		const content = readFileSync(tasksFile, "utf8");
		expect(content).toBe(JSON.stringify(tasks, null, 2));
		expect(JSON.parse(content)).toEqual(tasks);
		expect(listTempSiblings(tasksDir)).toHaveLength(0);

		// Backup dir + filename pattern unchanged: tasks-backups/YYYY-MM-DDTHHZ.json
		const backupDir = join(tasksDir, "tasks-backups");
		const backups = readdirSync(backupDir);
		expect(backups).toHaveLength(1);
		expect(backups[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}Z\.json$/);
	});
});
