import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyHomeDataIntoProject, copyProjectDataToHome } from "../project-storage-switch";
import { inProjectDataDir, legacyProjectDataDir } from "../../shared/project-storage";
import { storageSwitchBlocker } from "../../shared/types";

let root: string;
let home: string;
let project: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "storage-switch-"));
	home = join(root, "home");
	project = join(root, "proj");
	mkdirSync(home, { recursive: true });
	mkdirSync(project, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seedHome() {
	const dir = legacyProjectDataDir(home, project);
	mkdirSync(join(dir, "task-blobs"), { recursive: true });
	writeFileSync(join(dir, "tasks.json"), "[1]");
	writeFileSync(join(dir, "task-blobs", "a.json"), "{}");
	return dir;
}

describe("copyHomeDataIntoProject", () => {
	it("copies the tree, writes ignore files and leaves the source intact", async () => {
		const src = seedHome();
		expect(await copyHomeDataIntoProject(home, project)).toBe(2);
		expect(readFileSync(join(inProjectDataDir(project), "tasks.json"), "utf8")).toBe("[1]");
		expect(readFileSync(join(inProjectDataDir(project), "task-blobs", "a.json"), "utf8")).toBe("{}");
		expect(readFileSync(join(src, "tasks.json"), "utf8")).toBe("[1]");
	});

	it("keeps a destination file that is newer than its source", async () => {
		const src = seedHome();
		utimesSync(join(src, "tasks.json"), 1000, 1000);
		mkdirSync(inProjectDataDir(project), { recursive: true });
		writeFileSync(join(inProjectDataDir(project), "tasks.json"), "\"newer\"");
		await copyHomeDataIntoProject(home, project);
		expect(readFileSync(join(inProjectDataDir(project), "tasks.json"), "utf8")).toBe("\"newer\"");
	});

	it("copes with a project that has no home data yet", async () => {
		expect(await copyHomeDataIntoProject(home, project)).toBe(0);
		expect(existsSync(inProjectDataDir(project))).toBe(false);
	});
});

describe("copyProjectDataToHome", () => {
	it("copies back and never deletes the in-project data", async () => {
		mkdirSync(inProjectDataDir(project), { recursive: true });
		writeFileSync(join(inProjectDataDir(project), "tasks.json"), "[2]");
		expect(await copyProjectDataToHome(home, project)).toBe(1);
		expect(readFileSync(join(legacyProjectDataDir(home, project), "tasks.json"), "utf8")).toBe("[2]");
		expect(readFileSync(join(inProjectDataDir(project), "tasks.json"), "utf8")).toBe("[2]");
	});
});

describe("restamping unstarted tasks", () => {
	const board = [
		{ id: "a", status: "todo" },
		{ id: "b", status: "todo", worktreePath: "/wt" },
		{ id: "c", status: "in-progress" },
	];

	it("stamps only unstarted tasks on enable and clears the stamp on disable", async () => {
		const src = legacyProjectDataDir(home, project);
		mkdirSync(src, { recursive: true });
		writeFileSync(join(src, "tasks.json"), JSON.stringify(board));
		await copyHomeDataIntoProject(home, project);
		const inProject = JSON.parse(readFileSync(join(inProjectDataDir(project), "tasks.json"), "utf8"));
		expect(inProject.map((t: any) => t.taskDirLocation)).toEqual(["project", undefined, undefined]);

		inProject[0].taskDirLocation = "project";
		writeFileSync(join(inProjectDataDir(project), "tasks.json"), JSON.stringify(inProject));
		utimesSync(join(src, "tasks.json"), 1000, 1000);
		await copyProjectDataToHome(home, project);
		const back = JSON.parse(readFileSync(join(src, "tasks.json"), "utf8"));
		expect(back[0].taskDirLocation).toBeUndefined();
	});

	it("leaves a started task's stamp alone", async () => {
		mkdirSync(inProjectDataDir(project), { recursive: true });
		writeFileSync(join(inProjectDataDir(project), "tasks.json"), JSON.stringify([{ id: "s", status: "in-progress", taskDirLocation: "project" }]));
		await copyProjectDataToHome(home, project);
		const back = JSON.parse(readFileSync(join(legacyProjectDataDir(home, project), "tasks.json"), "utf8"));
		expect(back[0].taskDirLocation).toBe("project");
	});
});

describe("storageSwitchBlocker", () => {
	it("blocks a virtual board", () => {
		expect(storageSwitchBlocker({ kind: "virtual" }, [])).toEqual({ reason: "virtual" });
	});
	it("blocks preparing and non-idle tasks only", () => {
		const tasks = [
			{ preparing: true },
			{ runtimeState: { runtime: "running" } },
			{ runtimeState: { runtime: "idle" } },
			{},
		] as any;
		expect(storageSwitchBlocker({ kind: "git" }, tasks)).toEqual({ reason: "live-tasks", count: 2 });
		expect(storageSwitchBlocker({ kind: "git" }, [{}] as any)).toBeNull();
	});
});
