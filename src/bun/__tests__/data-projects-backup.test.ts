import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import type { Project } from "../../shared/types";

const TEST_HOME = "/tmp/dev3-test-projects-backup";

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/dev3-test-projects-backup",
}));

vi.mock("../cow-clone", () => ({
	detectClonePaths: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
});

import { addProject, backupProjectsDaily, updateProject } from "../data";

const PROJECTS_FILE = `${TEST_HOME}/projects.json`;

function todayBackupFile(): string {
	return `${TEST_HOME}/projects-${new Date().toISOString().slice(0, 10)}.json.bak`;
}

function listBackups(): string[] {
	return readdirSync(TEST_HOME)
		.filter((f) => /^projects-\d{4}-\d{2}-\d{2}\.json\.bak$/.test(f))
		.sort();
}

function seedProjects(projects: Partial<Project>[]): void {
	writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

describe("daily projects.json backups", () => {
	it("writes a daily .bak with the pre-save content on first save of the day", async () => {
		seedProjects([{ id: "old", name: "Old", path: "/tmp/old" } as Project]);

		await addProject("/tmp/new-repo", "New Repo");

		const backup = todayBackupFile();
		expect(existsSync(backup)).toBe(true);
		const backedUp = JSON.parse(readFileSync(backup, "utf-8"));
		expect(backedUp).toHaveLength(1);
		expect(backedUp[0].id).toBe("old");
	});

	it("does not overwrite the same day's backup on subsequent saves", async () => {
		seedProjects([{ id: "old", name: "Old", path: "/tmp/old" } as Project]);

		const added = await addProject("/tmp/new-repo", "New Repo");
		await updateProject(added.id, { devScript: "bun run dev" });

		const backedUp = JSON.parse(readFileSync(todayBackupFile(), "utf-8"));
		expect(backedUp).toHaveLength(1);
		expect(backedUp[0].id).toBe("old");
	});

	it("skips backup when there is no projects.json yet", async () => {
		await addProject("/tmp/first-repo", "First Repo");

		expect(listBackups()).toHaveLength(0);
	});

	it("prunes backups older than 7 days, keeping the newest 7", async () => {
		seedProjects([{ id: "old", name: "Old", path: "/tmp/old" } as Project]);
		for (let i = 1; i <= 9; i++) {
			writeFileSync(`${TEST_HOME}/projects-2026-05-0${i}.json.bak`, "[]");
		}

		await addProject("/tmp/new-repo", "New Repo");

		const backups = listBackups();
		expect(backups).toHaveLength(7);
		expect(backups).not.toContain("projects-2026-05-01.json.bak");
		expect(backups).not.toContain("projects-2026-05-02.json.bak");
		expect(backups).not.toContain("projects-2026-05-03.json.bak");
		expect(backups[backups.length - 1]).toBe(todayBackupFile().split("/").pop());
	});

	it("backupProjectsDaily can be called standalone (startup hook)", async () => {
		seedProjects([{ id: "p", name: "P", path: "/tmp/p" } as Project]);

		await backupProjectsDaily();

		expect(existsSync(todayBackupFile())).toBe(true);
	});
});
