import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import type { Project } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-projects-backup`);

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
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

import { addProject, backupProjectsDaily, backupProjectsHourly, updateProject } from "../data";

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

describe("hourly projects.json backups", () => {
	const HOURLY_DIR = `${TEST_HOME}/projects-backups`;
	const LAST_GOOD = `${TEST_HOME}/projects-last-known-good.json`;

	function listHourly(): string[] {
		return existsSync(HOURLY_DIR)
			? readdirSync(HOURLY_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}T\d{2}Z\.json$/.test(f)).sort()
			: [];
	}

	it("snapshots on a timer tick with no save at all", async () => {
		// The measured defect: 28-30 Aug 2026 have no copy because both schemes
		// only fired on a save or at startup, and the app stayed up for days.
		seedProjects([{ id: "a", name: "A", path: "/tmp/a" } as Project]);

		await backupProjectsHourly();

		expect(listHourly()).toHaveLength(1);
		expect(JSON.parse(readFileSync(`${HOURLY_DIR}/${listHourly()[0]}`, "utf-8"))).toHaveLength(1);
	});

	it("keeps one snapshot per hour and prunes beyond 72", async () => {
		seedProjects([{ id: "a", name: "A", path: "/tmp/a" } as Project]);
		const hour = new Date("2026-08-31T10:00:00.000Z");

		await backupProjectsHourly(hour);
		await backupProjectsHourly(new Date("2026-08-31T10:59:59.000Z"));
		expect(listHourly()).toEqual(["2026-08-31T10Z.json"]);

		for (let i = 0; i < 80; i++) {
			writeFileSync(`${HOURLY_DIR}/2026-05-${String((i % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}Z.json`, "[]");
		}
		await backupProjectsHourly(new Date("2026-08-31T12:00:00.000Z"));
		expect(listHourly().length).toBeLessThanOrEqual(72);
	});

	it("keeps a good copy that no rotation can evict", async () => {
		seedProjects(Array.from({ length: 29 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, path: `/tmp/p${i}` }) as Project));
		await backupProjectsHourly(new Date("2026-08-31T10:00:00.000Z"));
		expect(JSON.parse(readFileSync(LAST_GOOD, "utf-8"))).toHaveLength(29);

		// The wreck arrives as the next hour's pre-write content.
		seedProjects([{ id: "only", name: "dev-3.0", path: "/tmp/only" } as Project]);
		await backupProjectsHourly(new Date("2026-08-31T11:00:00.000Z"));

		// The hourly slot faithfully holds the wreck; the good copy is untouched.
		expect(JSON.parse(readFileSync(`${HOURLY_DIR}/2026-08-31T11Z.json`, "utf-8"))).toHaveLength(1);
		expect(JSON.parse(readFileSync(LAST_GOOD, "utf-8"))).toHaveLength(29);
	});

	it("still advances the good copy when a user deletes a project or two", async () => {
		// A rule that refused every shrink would freeze this file forever and go on
		// holding projects the user meant to be rid of.
		seedProjects(Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, path: `/tmp/p${i}` }) as Project));
		await backupProjectsHourly(new Date("2026-08-31T10:00:00.000Z"));

		seedProjects(Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, path: `/tmp/p${i}` }) as Project));
		await backupProjectsHourly(new Date("2026-08-31T11:00:00.000Z"));

		expect(JSON.parse(readFileSync(LAST_GOOD, "utf-8"))).toHaveLength(8);
	});

	it("never lets unreadable bytes become the good copy", async () => {
		seedProjects([{ id: "a", name: "A", path: "/tmp/a" } as Project]);
		await backupProjectsHourly(new Date("2026-08-31T10:00:00.000Z"));

		writeFileSync(PROJECTS_FILE, "{ truncated");
		await backupProjectsHourly(new Date("2026-08-31T11:00:00.000Z"));

		expect(JSON.parse(readFileSync(LAST_GOOD, "utf-8"))).toHaveLength(1);
	});
});
