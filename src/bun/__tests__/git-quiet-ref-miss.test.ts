/**
 * An absent ref is an answer for the existence probes (`getUnpushedCount` on a
 * branch never pushed), and "not an ancestor" is an answer for the ancestry
 * probes (the merged-check reflog loop) — neither may land in the log as WARN.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
}));

vi.mock("../paths", () => ({ DEV3_HOME: "/tmp/dev3-test" }));

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import { getBehindOriginCount, getUnpushedCount, isRefMergedInto, refExists } from "../git";
import { createTestRepo, cleanup, g, type TestRepo } from "./git-test-helpers";

describe("rev-parse --verify misses", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		g("git checkout -b dev3/task-unpushed", repo.local);
		warn.mockClear();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("a branch that was never pushed is not logged as a failed git command", async () => {
		expect(await getUnpushedCount(repo.local, "dev3/task-unpushed")).toBe(-1);
		expect(await getBehindOriginCount(repo.local, "dev3/task-unpushed")).toBe(0);
		expect(await refExists(repo.local, "origin/dev3/task-unpushed")).toBe(false);
		expect(warn).not.toHaveBeenCalledWith("Git command failed", expect.anything());
	});

	it("a real git error is still logged", async () => {
		const notARepo = mkdtempSync(join(tmpdir(), "dev3-not-a-repo-"));
		try {
			expect(await refExists(notARepo, "main")).toBe(false);
			expect(warn).toHaveBeenCalledWith("Git command failed", expect.objectContaining({ exitCode: 128 }));
		} finally {
			rmSync(notARepo, { recursive: true, force: true });
		}
	});
});

describe("merge-base --is-ancestor answers", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		g("git checkout -b feature", repo.local);
		g("git commit --allow-empty -m feature-work", repo.local);
		g("git checkout main", repo.local);
		warn.mockClear();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("a commit that is not an ancestor is not logged as a failed git command", async () => {
		expect(await isRefMergedInto(repo.local, "feature", "main")).toBe(false);
		expect(warn).not.toHaveBeenCalledWith("Git command failed", expect.anything());
	});

	it("an unresolvable ref is still logged", async () => {
		expect(await isRefMergedInto(repo.local, "no-such-branch", "main")).toBe(false);
		expect(warn).toHaveBeenCalledWith("Git command failed", expect.objectContaining({ exitCode: 128 }));
	});
});
