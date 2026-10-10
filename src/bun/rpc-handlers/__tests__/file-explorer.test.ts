import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "dev3-file-explorer-"));
const worktree = join(tmp, "worktree");
const projectDir = join(tmp, "project");

vi.mock("../../data", () => ({
	getProject: vi.fn(async (projectId: string) => {
		if (projectId === "virtual") return { id: "virtual", kind: "virtual", path: "" };
		return { id: "proj-1", kind: "git", path: projectDir };
	}),
	getTask: vi.fn(async (_project: unknown, taskId: string) => {
		if (taskId === "no-worktree") return { id: taskId, worktreePath: null };
		return { id: "task-1", worktreePath: worktree };
	}),
}));
vi.mock("../shared", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The fixtures are plain temp dirs: `git ls-files --ignored` is served from here.
let ignoredOutput: string[] | null = [];
const runGit = vi.fn(async (_cmd: string[], _cwd: string) =>
	ignoredOutput === null
		? { ok: false, stdout: "", stderr: "not a git repository" }
		: { ok: true, stdout: ignoredOutput.join("\0"), stderr: "" },
);
vi.mock("../../git", () => ({ run: (...args: unknown[]) => runGit(...(args as [string[], string])) }));

import { fileExplorerHandlers } from "../file-explorer";

const list = fileExplorerHandlers.listExplorerDirectory;

beforeAll(() => {
	mkdirSync(join(worktree, ".git"), { recursive: true });
	mkdirSync(join(worktree, "src", "deep"), { recursive: true });
	mkdirSync(join(worktree, "node_modules"), { recursive: true });
	mkdirSync(join(worktree, "Zeta"), { recursive: true });
	writeFileSync(join(worktree, "README.md"), "# hi\n");
	writeFileSync(join(worktree, "a.log"), "log\n");
	writeFileSync(join(worktree, ".env.example"), "X=1\n");
	writeFileSync(join(worktree, "file10.ts"), "");
	writeFileSync(join(worktree, "file2.ts"), "");
	writeFileSync(join(worktree, "src", "index.ts"), "export {};\n");
	symlinkSync(join(worktree, "missing-target"), join(worktree, "broken-link"));
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, "main.txt"), "main\n");
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
	ignoredOutput = [];
	runGit.mockClear();
});

describe("listExplorerDirectory", () => {
	it("lists the task worktree root: directories first, natural order, .git hidden, dotfiles kept", async () => {
		const listing = await list({ projectId: "proj-1", taskId: "task-1" });
		expect(listing.root).toBe(worktree);
		expect(listing.error).toBeUndefined();
		expect(listing.entries.map((e) => e.name)).toEqual([
			"node_modules", "src", "Zeta",
			".env.example", "a.log", "file2.ts", "file10.ts", "README.md",
		]);
		const src = listing.entries.find((e) => e.name === "src");
		expect(src).toMatchObject({ kind: "directory", relPath: "src", path: join(worktree, "src") });
	});

	it("marks direct children that git reports as ignored, not deeper ones", async () => {
		ignoredOutput = ["a.log", "node_modules/", "src/deep/", "src/deep/x.log"];
		const listing = await list({ projectId: "proj-1", taskId: "task-1" });
		const ignored = listing.entries.filter((e) => e.ignored).map((e) => e.name);
		expect(ignored).toEqual(["node_modules", "a.log"]);
		expect(runGit.mock.calls[0][0]).toContain("--ignored");
		expect(runGit.mock.calls[0][1]).toBe(worktree);
	});

	it("lists a nested directory by relative path and keys ignored names to it", async () => {
		ignoredOutput = ["src/deep/"];
		const listing = await list({ projectId: "proj-1", taskId: "task-1", relPath: "src/" });
		expect(listing.relPath).toBe("src");
		expect(listing.entries.map((e) => [e.relPath, e.ignored])).toEqual([
			["src/deep", true],
			["src/index.ts", false],
		]);
	});

	it("still lists, undimmed, when the root is not a git repo", async () => {
		ignoredOutput = null;
		const listing = await list({ projectId: "proj-1", taskId: "task-1" });
		expect(listing.entries.length).toBeGreaterThan(0);
		expect(listing.entries.every((e) => !e.ignored)).toBe(true);
	});

	it("uses the project checkout when no task is given", async () => {
		const listing = await list({ projectId: "proj-1" });
		expect(listing.root).toBe(projectDir);
		expect(listing.entries.map((e) => e.name)).toEqual(["main.txt"]);
	});

	it("refuses a relative path that escapes the root", async () => {
		for (const relPath of ["..", "../project", "src/../../project"]) {
			const listing = await list({ projectId: "proj-1", taskId: "task-1", relPath });
			expect(listing.error).toBe("outside-root");
			expect(listing.entries).toEqual([]);
		}
	});

	it("reports a missing directory and a file as not-found", async () => {
		expect((await list({ projectId: "proj-1", taskId: "task-1", relPath: "nope" })).error).toBe("not-found");
		expect((await list({ projectId: "proj-1", taskId: "task-1", relPath: "README.md" })).error).toBe("not-found");
	});

	it("has no root for a virtual project or a task without a worktree", async () => {
		expect((await list({ projectId: "virtual" })).error).toBe("no-root");
		expect((await list({ projectId: "proj-1", taskId: "no-worktree" })).error).toBe("no-root");
	});
});
