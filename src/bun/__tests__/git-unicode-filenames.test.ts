import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { getBranchDiffStats, getUncommittedChanges, _resetFetchState } from "../git";

describe("git Unicode filenames", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		_resetFetchState();
		g("git config core.quotePath true", repo.local);
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("returns branch diff filenames as readable Unicode paths", async () => {
		g("git checkout -b fix/unicode-diff-names", repo.local);
		writeFileSync(join(repo.local, "Справочник.md"), "hello\n");
		g("git add Справочник.md", repo.local);
		g('git commit -m "add unicode file"', repo.local);

		const result = await getBranchDiffStats(repo.local, "origin/main");

		expect(result.files).toBe(1);
		expect(result.fileStats.map((f) => f.path)).toEqual(["Справочник.md"]);
	});

	it("counts untracked Unicode files in uncommitted stats", async () => {
		writeFileSync(join(repo.local, "Индекс.md"), "line 1\nline 2\n");

		const result = await getUncommittedChanges(repo.local);

		expect(result.insertions).toBe(2);
		expect(result.deletions).toBe(0);
	});
});
