/**
 * `getUnpreservedCount` against real git repos — the completion dialog's "what
 * would deleting this worktree destroy" number. Mocked spawn cannot answer this:
 * the whole question is which refs a real git considers HEAD reachable from.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../paths", () => ({ DEV3_HOME: "/tmp/dev3-test" }));

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import { getUnpreservedCount, getUnpushedCount } from "../git";
import { createTestRepo, cleanup, makeTaskCommits, g, GIT_ENV, type TestRepo } from "./git-test-helpers";

describe("getUnpreservedCount", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		g("git checkout -b dev3/task-branch", repo.local);
		makeTaskCommits(repo.local);
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("pushed under the same name: nothing is at risk", async () => {
		g("git push -u origin dev3/task-branch", repo.local);
		expect(await getUnpreservedCount(repo.local, "dev3/task-branch")).toBe(0);
	});

	it("pushed under the same name, then one more commit: that commit is at risk", async () => {
		g("git push -u origin dev3/task-branch", repo.local);
		writeFileSync(join(repo.local, "later.ts"), "export const later = 1;\n");
		g("git add later.ts", repo.local);
		g('git commit -m "feat: later"', repo.local);
		expect(await getUnpreservedCount(repo.local, "dev3/task-branch")).toBe(1);
	});

	it("pushed under a DIFFERENT name: nothing is at risk (issue #1545)", async () => {
		g("git push origin HEAD:feature/example", repo.local);
		g("git fetch origin", repo.local);

		// The premise of the issue: both refs are the same commit, yet there is no
		// origin/<branch>, which is all the name-based check ever looked at.
		expect(g("git rev-parse HEAD", repo.local).trim())
			.toBe(g("git rev-parse origin/feature/example", repo.local).trim());
		expect(await getUnpushedCount(repo.local, "dev3/task-branch")).toBe(-1);

		expect(await getUnpreservedCount(repo.local, "dev3/task-branch")).toBe(0);
	});

	it("pushed under a different name, then one more commit: still warns", async () => {
		g("git push origin HEAD:feature/example", repo.local);
		g("git fetch origin", repo.local);
		writeFileSync(join(repo.local, "later.ts"), "export const later = 1;\n");
		g("git add later.ts", repo.local);
		g('git commit -m "feat: later"', repo.local);

		expect(await getUnpreservedCount(repo.local, "dev3/task-branch")).toBe(-1);
	});

	it("never pushed at all: warns, loudly", async () => {
		expect(await getUnpreservedCount(repo.local, "dev3/task-branch")).toBe(-1);
	});

	it("never pushed, and a sibling branch is on the remote: still warns", async () => {
		g("git push origin main:main", repo.local);
		g("git fetch origin", repo.local);
		expect(await getUnpreservedCount(repo.local, "dev3/task-branch")).toBe(-1);
	});

	it("repo with no remote at all: warns", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-git-noremote-"));
		execSync("git init -q -b main .", { cwd: dir, env: GIT_ENV });
		writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
		execSync("git add a.ts && git commit -qm initial", { cwd: dir, env: GIT_ENV });
		execSync("git checkout -qb dev3/task-branch", { cwd: dir, env: GIT_ENV });
		writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
		execSync("git add b.ts && git commit -qm work", { cwd: dir, env: GIT_ENV });

		expect(await getUnpreservedCount(dir, "dev3/task-branch")).toBe(-1);
		cleanup({ dir, local: dir });
	});

	it("returns 0 for an empty branch name", async () => {
		expect(await getUnpreservedCount(repo.local, "")).toBe(0);
	});
});
