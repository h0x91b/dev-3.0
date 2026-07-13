import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/dev3-test",
}));

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import { writeFileSync } from "fs";
import { join } from "path";
import { createTestRepo, cleanup, g, type TestRepo } from "./git-test-helpers";
import { getTaskDiff, _resetFetchState } from "../git";

// `recent` mode diffs `HEAD~N..HEAD`, clamped to the branch's own commits (never
// into base-branch history). These exercise the real git range against a repo
// whose `origin/main` marks the branch point (see git-test-helpers template).
describe("getTaskDiff recent mode", () => {
	let repo: TestRepo;

	// Adds three own commits on top of origin/main, each touching a distinct file
	// so the effective range is unambiguous from the file set alone.
	function makeThreeCommits(local: string): void {
		writeFileSync(join(local, "a.ts"), "export const a = 1;\n");
		g("git add a.ts", local);
		g('git commit -m "commit A: a.ts"', local);

		writeFileSync(join(local, "b.ts"), "export const b = 2;\n");
		g("git add b.ts", local);
		g('git commit -m "commit B: b.ts"', local);

		writeFileSync(join(local, "c.ts"), "export const c = 3;\n");
		g("git add c.ts", local);
		g('git commit -m "commit C: c.ts"', local);
	}

	beforeEach(() => {
		repo = createTestRepo();
		_resetFetchState();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("N=1 shows only the last commit", async () => {
		makeThreeCommits(repo.local);

		const result = await getTaskDiff(repo.local, "recent", { baseBranch: "main", count: 1 });

		expect(result.mode).toBe("recent");
		expect(result.recentCount).toBe(1);
		expect(result.files.map((f) => f.displayPath)).toEqual(["c.ts"]);
	});

	it("N=3 shows the last three commits", async () => {
		makeThreeCommits(repo.local);

		const result = await getTaskDiff(repo.local, "recent", { baseBranch: "main", count: 3 });

		expect(result.recentCount).toBe(3);
		expect(result.files.map((f) => f.displayPath).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("clamps N to the branch's own commits and relabels the effective count", async () => {
		makeThreeCommits(repo.local); // only 3 own commits above origin/main

		const result = await getTaskDiff(repo.local, "recent", { baseBranch: "main", count: 10 });

		// Clamped to 3 — never reaches into base-branch history (the "initial" commit).
		expect(result.recentCount).toBe(3);
		expect(result.files.map((f) => f.displayPath).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
		// The clamp must not surface the base commit's file.
		expect(result.files.map((f) => f.displayPath)).not.toContain("app.ts");
	});

	it("returns an empty diff (recentCount 0) when the branch has no commits of its own", async () => {
		// Fresh branch sitting exactly on origin/main — zero own commits.
		g("git checkout -b fresh origin/main", repo.local);

		const result = await getTaskDiff(repo.local, "recent", { baseBranch: "main", count: 5 });

		expect(result.recentCount).toBe(0);
		expect(result.files).toEqual([]);
		expect(result.skippedFiles).toEqual([]);
		expect(result.summary.files).toBe(0);
	});

	it("excludes uncommitted working-tree edits", async () => {
		makeThreeCommits(repo.local);
		// Dirty the working tree with an edit that is NOT committed.
		writeFileSync(join(repo.local, "b.ts"), "export const b = 2;\nexport const dirty = true;\n");

		const result = await getTaskDiff(repo.local, "recent", { baseBranch: "main", count: 1 });

		// N=1 is only commit C (c.ts); the uncommitted b.ts edit must not appear.
		expect(result.files.map((f) => f.displayPath)).toEqual(["c.ts"]);
	});

	it("defaults to the last commit (N=1) when count is omitted", async () => {
		makeThreeCommits(repo.local);

		const result = await getTaskDiff(repo.local, "recent", { baseBranch: "main" });

		expect(result.recentCount).toBe(1);
		expect(result.files.map((f) => f.displayPath)).toEqual(["c.ts"]);
	});
});
