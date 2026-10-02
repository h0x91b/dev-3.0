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

import { createHash } from "crypto";
import { readFileSync, statSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { createTestRepo, cleanup, g, spawnedCommands, type TestRepo } from "./git-test-helpers";
import { isWorktreeDirty, run, withGitDefaults, _resetFetchState } from "../git";

const NOL = "--no-optional-locks";

function indexSignature(repo: string): string {
	const index = join(repo, ".git", "index");
	const { ino, mtimeMs } = statSync(index);
	return `${ino}:${mtimeMs}:${createHash("sha1").update(readFileSync(index)).digest("hex")}`;
}

/** Content unchanged, mtime moved: the index now holds stale stat data for app.ts. */
function makeStatOnlyDirty(repo: string): void {
	const past = new Date("2020-01-01T00:00:00Z");
	utimesSync(join(repo, "app.ts"), past, past);
}

describe("withGitDefaults", () => {
	it("adds --no-optional-locks to git status, wherever the global options put it", () => {
		expect(withGitDefaults(["git", "status", "--porcelain"])).toEqual([
			"git", NOL, "-c", "core.quotepath=false", "status", "--porcelain",
		]);
		expect(withGitDefaults(["git", "-C", "/wt", "status", "--porcelain"])[1]).toBe(NOL);
		expect(withGitDefaults(["git", "-c", "a.b=c", "status"])[1]).toBe(NOL);
		expect(withGitDefaults(["git", "--git-dir=/x/.git", "status"])[1]).toBe(NOL);
	});

	it("leaves every other subcommand, writes included, without the flag", () => {
		for (const sub of ["add", "commit", "stash", "checkout", "rebase", "merge", "worktree", "diff", "ls-files", "rev-parse", "fetch"]) {
			expect(withGitDefaults(["git", sub, "x"])).toEqual(["git", "-c", "core.quotepath=false", sub, "x"]);
		}
	});

	it("reads the value of -C as a path, not as the subcommand", () => {
		expect(withGitDefaults(["git", "-C", "status", "log"])).not.toContain(NOL);
	});

	it("does not touch non-git commands", () => {
		expect(withGitDefaults(["gh", "status"])).toEqual(["gh", "status"]);
	});
});

describe("git status through dev3 takes no optional index lock", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		_resetFetchState();
		spawnedCommands.length = 0;
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("control: a plain git status rewrites the index of a stat-dirty worktree", () => {
		// Proves the fixture can detect the write-back the next test says is gone.
		makeStatOnlyDirty(repo.local);
		const before = indexSignature(repo.local);
		g("git status --porcelain", repo.local);
		expect(indexSignature(repo.local)).not.toBe(before);
	});

	it("isWorktreeDirty leaves the index untouched and still answers correctly", async () => {
		makeStatOnlyDirty(repo.local);
		const before = indexSignature(repo.local);

		expect(await isWorktreeDirty(repo.local)).toBe(false);
		expect(indexSignature(repo.local)).toBe(before);
		expect(spawnedCommands.find((cmd) => cmd.includes("status"))).toContain(NOL);

		writeFileSync(join(repo.local, "app.ts"), "changed\n");
		expect(await isWorktreeDirty(repo.local)).toBe(true);
		writeFileSync(join(repo.local, "new.ts"), "untracked\n");
		expect(await isWorktreeDirty(repo.local)).toBe(true);
	});

	it("reports the same porcelain output with or without the flag", async () => {
		writeFileSync(join(repo.local, "app.ts"), "changed\n");
		writeFileSync(join(repo.local, "new.ts"), "untracked\n");
		const viaDev3 = await run(["git", "status", "--porcelain", "--untracked-files=all"], repo.local);
		const plain = g("git -c core.quotepath=false status --porcelain --untracked-files=all", repo.local).trim();
		expect(viaDev3).toMatchObject({ ok: true, stdout: plain });
	});

	it("still answers while another process holds index.lock", async () => {
		writeFileSync(join(repo.local, ".git", "index.lock"), "");
		writeFileSync(join(repo.local, "app.ts"), "changed\n");
		expect(await isWorktreeDirty(repo.local)).toBe(true);
	});

	it("keeps required locks: a write still fails on a held index.lock", async () => {
		writeFileSync(join(repo.local, ".git", "index.lock"), "");
		writeFileSync(join(repo.local, "app.ts"), "changed\n");
		const add = await run(["git", "add", "app.ts"], repo.local);
		expect(add.ok).toBe(false);
		expect(add.stderr).toContain("index.lock");
	});
});
