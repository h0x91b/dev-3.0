import { describe, expect, it } from "vitest";
import {
	allProjectWorktreesRoots,
	inProjectDataDir,
	inProjectRoot,
	isInProjectTaskPath,
	legacyProjectDataDir,
	parseInProjectTaskPath,
	projectDataDir,
	projectTasksFile,
	projectWorktreesRoot,
	storesInProject,
	taskDirFor,
} from "../../shared/project-storage";

const HOME = "/home/u/.dev3.0";
const HOME_PROJECT = { path: "/src/repo" };
const IN_PROJECT = { path: "/src/repo", storageRoot: "project" as const };
const TASK_ID = "abcd1234-0000-0000-0000-000000000000";

describe("storesInProject", () => {
	it("is true only for a non-virtual project with storageRoot project", () => {
		expect(storesInProject(IN_PROJECT)).toBe(true);
		expect(storesInProject(HOME_PROJECT)).toBe(false);
		expect(storesInProject({ ...IN_PROJECT, kind: "virtual" })).toBe(false);
	});
});

describe("data dirs", () => {
	it("resolves home layout by default", () => {
		expect(legacyProjectDataDir(HOME, "/src/repo")).toBe(`${HOME}/data/src-repo`);
		expect(projectDataDir(HOME, HOME_PROJECT)).toBe(`${HOME}/data/src-repo`);
		expect(projectTasksFile(HOME, HOME_PROJECT)).toBe(`${HOME}/data/src-repo/tasks.json`);
	});

	it("resolves the project folder when the project stores in-project", () => {
		expect(inProjectRoot("/src/repo/")).toBe("/src/repo/.dev3");
		expect(inProjectDataDir("/src/repo")).toBe("/src/repo/.dev3/data");
		expect(projectDataDir(HOME, IN_PROJECT)).toBe("/src/repo/.dev3/data");
		expect(projectTasksFile(HOME, IN_PROJECT)).toBe("/src/repo/.dev3/data/tasks.json");
	});

	it("keeps a virtual board in the home layout even with the flag set", () => {
		expect(projectDataDir(HOME, { ...IN_PROJECT, kind: "virtual" })).toBe(`${HOME}/data/src-repo`);
	});
});

describe("worktrees roots", () => {
	it("picks the root by location", () => {
		expect(projectWorktreesRoot(HOME, "/src/repo")).toBe(`${HOME}/worktrees/src-repo`);
		expect(projectWorktreesRoot(HOME, "/src/repo", "project")).toBe("/src/repo/.dev3/worktrees");
	});

	it("lists both roots", () => {
		expect(allProjectWorktreesRoots(HOME, "/src/repo")).toEqual([`${HOME}/worktrees/src-repo`, "/src/repo/.dev3/worktrees"]);
	});
});

describe("taskDirFor", () => {
	it("follows the task's stamp, not the project's current setting", () => {
		expect(taskDirFor(HOME, IN_PROJECT, { id: TASK_ID })).toBe(`${HOME}/worktrees/src-repo/abcd1234`);
		expect(taskDirFor(HOME, HOME_PROJECT, { id: TASK_ID, taskDirLocation: "project" })).toBe("/src/repo/.dev3/worktrees/abcd1234");
	});

	it("prefers a stored worktreePath under either root", () => {
		const inProjectStored = "/src/repo/.dev3/worktrees/abcd1234/worktree";
		expect(taskDirFor(HOME, HOME_PROJECT, { id: TASK_ID, worktreePath: inProjectStored })).toBe("/src/repo/.dev3/worktrees/abcd1234");
		const homeStored = `${HOME}/worktrees/src-repo/abcd1234/worktree`;
		expect(taskDirFor(HOME, IN_PROJECT, { id: TASK_ID, taskDirLocation: "project", worktreePath: homeStored })).toBe(
			`${HOME}/worktrees/src-repo/abcd1234`,
		);
	});

	it("ignores a stored worktreePath that matches neither root", () => {
		expect(taskDirFor(HOME, HOME_PROJECT, { id: TASK_ID, worktreePath: "/elsewhere/abcd1234/worktree" })).toBe(
			`${HOME}/worktrees/src-repo/abcd1234`,
		);
	});
});

describe("parseInProjectTaskPath", () => {
	it("flags the worktree and anything below it as inWorktree", () => {
		const expected = { projectPath: "/src/repo", shortId: "abcd1234", taskDir: "/src/repo/.dev3/worktrees/abcd1234" };
		expect(parseInProjectTaskPath("/src/repo/.dev3/worktrees/abcd1234/worktree")).toEqual({ ...expected, inWorktree: true });
		expect(parseInProjectTaskPath("/src/repo/.dev3/worktrees/abcd1234/worktree/src/a.ts")).toEqual({ ...expected, inWorktree: true });
	});

	it("reports task-dir siblings as not inWorktree", () => {
		expect(parseInProjectTaskPath("/src/repo/.dev3/worktrees/abcd1234/logs")?.inWorktree).toBe(false);
		expect(parseInProjectTaskPath("/src/repo/.dev3/worktrees/abcd1234")?.inWorktree).toBe(false);
		expect(parseInProjectTaskPath("/src/repo/.dev3/worktrees/abcd1234/worktree-old")?.inWorktree).toBe(false);
	});

	it("accepts a trailing slash", () => {
		expect(parseInProjectTaskPath("/src/repo/.dev3/worktrees/abcd1234/worktree/")?.projectPath).toBe("/src/repo");
	});

	it("returns null for paths that are not in-project task dirs", () => {
		expect(parseInProjectTaskPath("/src/repo")).toBeNull();
		expect(parseInProjectTaskPath("/src/repo/.dev3/data/tasks.json")).toBeNull();
		expect(parseInProjectTaskPath("/src/repo/.dev3/worktrees/not-hex-id/worktree")).toBeNull();
		expect(parseInProjectTaskPath(`${HOME}/worktrees/src-repo/abcd1234/worktree`)).toBeNull();
		expect(isInProjectTaskPath("/src/repo/.dev3/worktrees/abcd1234/worktree")).toBe(true);
		expect(isInProjectTaskPath("/src/repo/other")).toBe(false);
	});
});
