/**
 * Tests for simple git wrapper functions using mocked spawn() responses.
 *
 * These functions are thin wrappers around git CLI commands. Instead of
 * spinning up real git repos, we mock spawn() with recorded responses
 * — making tests instant (~0ms each).
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
}));

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

// Queue of canned responses for spawn() calls
let spawnResponses: Array<{ exitCode: number; stdout: string; stderr: string }> = [];

/** Enqueue a canned response for the next spawn() call. */
function queueResponse(exitCode: number, stdout: string, stderr = "") {
	spawnResponses.push({ exitCode, stdout, stderr });
}

vi.mock("../spawn", () => ({
	spawn: spawnMock,
}));

function makeFakeProc(stdout: string, stderr: string, exitCode: number) {
	const encoder = new TextEncoder();
	return {
		exited: Promise.resolve(exitCode),
		stdout: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(stdout));
				controller.close();
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(stderr));
				controller.close();
			},
		}),
	};
}

spawnMock.mockImplementation(() => {
		const response = spawnResponses.shift() ?? { exitCode: 1, stdout: "", stderr: "no response queued" };
		return makeFakeProc(response.stdout, response.stderr, response.exitCode);
});

import {
	getCurrentBranch,
	isWorktreeDirty,
	getUnpushedCount,
	getBehindOriginCount,
	getBranchStatus,
	canRebaseCleanly,
	getUncommittedChanges,
	getTaskDiff,
	listBranches,
	detectDefaultCompareRef,
	getOriginUrl,
	deriveForkUrl,
	fetchFork,
	isForeignBranchRef,
	localBranchNameForRef,
	refAuthorAndSubject,
	pullOrigin,
	_resetFetchState,
	_resetCompareRefCache,
} from "../git";

beforeEach(() => {
	spawnResponses = [];
	_resetFetchState();
	_resetCompareRefCache();
	spawnMock.mockClear();
	spawnMock.mockImplementation(() => {
		const response = spawnResponses.shift() ?? { exitCode: 1, stdout: "", stderr: "no response queued" };
		return makeFakeProc(response.stdout, response.stderr, response.exitCode);
	});
});

// ─── getCurrentBranch ────────────────────────────────────────────────────────

describe("getCurrentBranch", () => {
	it("returns the branch name (slashes included), and null on detached HEAD or git failure", async () => {
		queueResponse(0, "dev3/fix-login-bug\n");
		expect(await getCurrentBranch("/repo")).toBe("dev3/fix-login-bug");
		queueResponse(0, "HEAD\n");
		expect(await getCurrentBranch("/repo")).toBeNull();
		queueResponse(128, "", "fatal: not a git repository");
		expect(await getCurrentBranch("/not-a-repo")).toBeNull();
	});
});

// ─── pullOrigin ──────────────────────────────────────────────────────────────

describe("pullOrigin", () => {
	it("returns ok/stdout on success and ok=false/stderr on failure", async () => {
		queueResponse(0, "Already up to date.\n");
		expect(await pullOrigin("/repo", "main")).toEqual({ ok: true, stdout: "Already up to date.", stderr: "" });

		queueResponse(1, "", "fatal: unable to access 'https://...': Could not resolve host\n");
		const failed = await pullOrigin("/repo", "main");
		expect(failed.ok).toBe(false);
		expect(failed.stderr).toMatch(/unable to access/);
	});

	it("retries exactly once on 'Cannot fast-forward to multiple branches', and never on unrelated failures", async () => {
		queueResponse(128, "", "fatal: Cannot fast-forward to multiple branches.\n");
		queueResponse(0, "Updating abc..def\nFast-forward\n");
		const retried = await pullOrigin("/repo", "main", { retryDelayMs: 0 });
		expect(retried.ok).toBe(true);
		expect(retried.stdout).toMatch(/Fast-forward/);
		expect(spawnMock).toHaveBeenCalledTimes(2);

		spawnMock.mockClear();
		queueResponse(128, "", "fatal: Cannot fast-forward to multiple branches.\n");
		queueResponse(128, "", "fatal: Cannot fast-forward to multiple branches.\n");
		const twice = await pullOrigin("/repo", "main", { retryDelayMs: 0 });
		expect(twice.ok).toBe(false);
		expect(twice.stderr).toMatch(/Cannot fast-forward to multiple branches/);
		expect(spawnMock).toHaveBeenCalledTimes(2);

		spawnMock.mockClear();
		queueResponse(1, "", "fatal: unable to access 'https://...': Could not resolve host\n");
		const unrelated = await pullOrigin("/repo", "main", { retryDelayMs: 0 });
		expect(unrelated.ok).toBe(false);
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});
});

// ─── isWorktreeDirty ────────────────────────────────────────────────────────

describe("isWorktreeDirty", () => {
	it("is dirty on tracked or untracked changes, clean on empty status or git failure", async () => {
		const cases: Array<[string, number, string, boolean]> = [
			["clean", 0, "", false],
			["tracked change", 0, " M src/app.ts\n", true],
			["untracked only", 0, "?? scratch.txt\n", true],
			["git failure", 128, "", false],
		];
		for (const [name, code, stdout, expected] of cases) {
			queueResponse(code, stdout);
			expect(await isWorktreeDirty("/repo"), name).toBe(expected);
		}
	});
});

// ─── getUnpushedCount ────────────────────────────────────────────────────────

describe("getUnpushedCount", () => {
	it("returns 0 for an empty name, -1 when never pushed, else the rev-list count (0 if it fails)", async () => {
		expect(await getUnpushedCount("/repo", "")).toBe(0);
		queueResponse(128, "", "fatal: Needed a single revision");
		expect(await getUnpushedCount("/repo", "dev3/task-branch")).toBe(-1);
		queueResponse(0, "abc123\n"); // rev-parse --verify origin/branch
		queueResponse(0, "3\n");      // rev-list --count
		expect(await getUnpushedCount("/repo", "dev3/task-branch")).toBe(3);
		queueResponse(0, "abc123\n");
		queueResponse(1, "", "error");
		expect(await getUnpushedCount("/repo", "dev3/task-branch")).toBe(0);
	});
});

// ─── getBehindOriginCount ────────────────────────────────────────────────────

describe("getBehindOriginCount", () => {
	it("returns 0 for an empty name or missing origin ref, else the rev-list count (0 if it fails)", async () => {
		expect(await getBehindOriginCount("/repo", "")).toBe(0);
		queueResponse(128, "", "fatal: Needed a single revision");
		expect(await getBehindOriginCount("/repo", "main")).toBe(0);
		queueResponse(0, "abc123\n"); // rev-parse --verify origin/main
		queueResponse(0, "5\n");      // rev-list --count HEAD..origin/main
		expect(await getBehindOriginCount("/repo", "main")).toBe(5);
		queueResponse(0, "abc123\n");
		queueResponse(1, "", "error");
		expect(await getBehindOriginCount("/repo", "main")).toBe(0);
	});
});

// ─── getBranchStatus ─────────────────────────────────────────────────────────

describe("getBranchStatus", () => {
	it("returns ahead-only counts directly, and zero when git fails", async () => {
		queueResponse(0, "0\t2\n"); // "behind\tahead"
		expect(await getBranchStatus("/repo", "origin/main")).toMatchObject({ ahead: 2, behind: 0 });
		queueResponse(1, "", "error");
		expect(await getBranchStatus("/repo", "origin/main")).toMatchObject({ ahead: 0, behind: 0 });
	});

	// Ahead AND behind is the one shape a missing fork point can also produce,
	// so this path probes `git merge-base` before trusting the counts.
	it("trusts ahead+behind counts only when merge-base finds a fork point", async () => {
		queueResponse(0, "1\t2\n");
		queueResponse(0, "abc1234\n");
		expect(await getBranchStatus("/repo", "origin/main")).toMatchObject({ ahead: 2, behind: 1, baseUnreachable: false });

		queueResponse(0, "1\t2\n");
		queueResponse(1, "", "fatal: refusing to merge unrelated histories");
		expect(await getBranchStatus("/repo", "origin/main")).toEqual({ ahead: 0, behind: 0, baseUnreachable: true });
	});
});

// ─── canRebaseCleanly ────────────────────────────────────────────────────────

describe("canRebaseCleanly", () => {
	it("is true when merge-tree succeeds and false when it reports conflicts", async () => {
		queueResponse(0, "abc123treehash\n");
		expect(await canRebaseCleanly("/repo", "origin/main")).toBe(true);
		queueResponse(1, "", "CONFLICT (content): Merge conflict in app.ts");
		expect(await canRebaseCleanly("/repo", "origin/main")).toBe(false);
	});
});

// ─── getUncommittedChanges ───────────────────────────────────────────────────

describe("getUncommittedChanges", () => {
	it("returns zero for a clean tree and falls back to counting when git status fails", async () => {
		queueResponse(0, "");   // git status --porcelain — clean, so no diff runs
		expect(await getUncommittedChanges("/repo")).toEqual({ insertions: 0, deletions: 0 });

		queueResponse(128, "", "fatal: boom");   // git status --porcelain
		queueResponse(0, "4\t2\tapp.ts\n");      // git diff --numstat HEAD
		queueResponse(0, "");                     // git ls-files --others
		expect(await getUncommittedChanges("/repo")).toEqual({ insertions: 4, deletions: 2 });
	});

	it("sums tracked numstat lines, skipping binary (-) entries", async () => {
		queueResponse(0, " M app.ts\n");   // git status --porcelain — dirty
		queueResponse(0, "-\t-\timage.png\n3\t1\tapp.ts\n2\t0\tutils.ts\n");
		queueResponse(0, "");
		expect(await getUncommittedChanges("/repo")).toEqual({ insertions: 5, deletions: 1 });
	});

	describe("untracked files", () => {
		const tmpDir = join(tmpdir(), `git-branch-ops-test-${Date.now()}`);

		beforeEach(() => {
			mkdirSync(tmpDir, { recursive: true });
		});

		afterAll(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("counts lines of untracked text files, skipping binary (null bytes) and >1 MB files", async () => {
			writeFileSync(join(tmpDir, "readme.txt"), "line1\nline2\nline3\n");
			writeFileSync(join(tmpDir, "image.png"), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]));
			writeFileSync(join(tmpDir, "huge.txt"), "x".repeat(1_048_577) + "\n");
			queueResponse(0, " M app.ts\n");                          // git status --porcelain — dirty
			queueResponse(0, "");                                      // git diff --numstat HEAD
			queueResponse(0, "readme.txt\nimage.png\nhuge.txt\n");    // git ls-files --others
			expect(await getUncommittedChanges(tmpDir)).toEqual({ insertions: 3, deletions: 0 });
		});
	});
});

// ─── getTaskDiff ─────────────────────────────────────────────────────────────

describe("getTaskDiff", () => {
	// Content is read via the `git cat-file` batch protocol: --batch-check emits
	// "<oid> blob <size>" per requested path, --batch emits that header followed
	// by <size> raw bytes and a trailing newline. These helpers mint matching
	// canned responses with a fixed (valid-shaped) object id.
	const OID = "0123456789abcdef0123456789abcdef01234567";
	const enc = new TextEncoder();
	const catCheck = (size: number) => `${OID} blob ${size}\n`;
	const catBlob = (content: string) => `${OID} blob ${enc.encode(content).length}\n${content}\n`;

	it("builds a branch diff from git blobs", async () => {
		queueResponse(0, "M\0src/app.ts\0");        // listDiffEntries (name-status)
		queueResponse(0, "2\t1\tsrc/app.ts\n");     // getBranchDiffStats (summary numstat)
		queueResponse(0, "2\t1\tsrc/app.ts\0");     // getNumstat (per-file, -z)
		queueResponse(0, catCheck(13));             // old ref (origin/main) batch-check
		queueResponse(0, catBlob("const a = 1;\n")); // old ref batch
		queueResponse(0, catCheck(13));             // new ref (HEAD) batch-check
		queueResponse(0, catBlob("const a = 2;\n")); // new ref batch

		const result = await getTaskDiff("/repo", "branch", {
			baseBranch: "main",
			compareRef: "origin/main",
			compareLabel: "origin/main",
		});

		expect(result.compareRef).toBe("origin/main");
		expect(result.compareLabel).toBe("origin/main");
		expect(result.summary).toEqual({
			files: 1,
			insertions: 2,
			deletions: 1,
		});
		expect(result.files).toEqual([
			expect.objectContaining({
				status: "modified",
				displayPath: "src/app.ts",
				oldContent: "const a = 1;\n",
				newContent: "const a = 2;\n",
				hunks: null,
				insertions: 2,
				deletions: 1,
			}),
		]);
	});

	it("builds an uncommitted diff with untracked files from the worktree", async () => {
		const tmpDir = join(tmpdir(), `git-inline-diff-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(join(tmpDir, "notes.txt"), "line 1\nline 2\n");

		queueResponse(0, "?? notes.txt\n"); // git status --porcelain — dirty
		queueResponse(0, "");             // listDiffEntries HEAD (no tracked changes)
		queueResponse(0, "notes.txt\0");  // listUntrackedEntries (ls-files --others -z)
		queueResponse(0, "");             // getUncommittedChanges numstat HEAD
		queueResponse(0, "");             // getNumstat -z HEAD (no tracked changes)
		queueResponse(0, "notes.txt\n");  // getUncommittedChanges ls-files --others

		const result = await getTaskDiff(tmpDir, "uncommitted", {
			baseBranch: "main",
		});

		expect(result.compareRef).toBeNull();
		expect(result.summary).toEqual({
			files: 1,
			insertions: 2,
			deletions: 0,
		});
		// Untracked file: read from the worktree on disk, every line counts as new.
		expect(result.files).toEqual([
			expect.objectContaining({
				status: "untracked",
				displayPath: "notes.txt",
				oldContent: "",
				newContent: "line 1\nline 2\n",
				hunks: null,
				insertions: 2,
				deletions: 0,
			}),
		]);

		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("falls back to branch diff when unpushed mode has no upstream", async () => {
		queueResponse(128, "", "fatal: no upstream configured"); // getUpstreamRef
		queueResponse(0, "A\0src/new.ts\0");        // listDiffEntries
		queueResponse(0, "1\t0\tsrc/new.ts\n");     // getBranchDiffStats
		queueResponse(0, "1\t0\tsrc/new.ts\0");     // getNumstat
		queueResponse(0, catCheck(10));             // new ref (HEAD) batch-check (added file: no old side)
		queueResponse(0, catBlob("export {};\n"));  // new ref batch

		const result = await getTaskDiff("/repo", "unpushed", {
			baseBranch: "main",
			compareRef: "origin/main",
			compareLabel: "origin/main",
		});

		expect(result.fallbackReason).toBe("no-upstream");
		expect(result.compareRef).toBe("origin/main");
		expect(result.summary.files).toBe(1);
		expect(result.files[0]).toEqual(expect.objectContaining({
			status: "added",
			displayPath: "src/new.ts",
			oldContent: "",
			newContent: "export {};\n",
			hunks: null,
			insertions: 1,
			deletions: 0,
		}));
	});

	it("diffs unpushed mode against the merge-base, not the upstream tip (three-dot)", async () => {
		// Regression: when the upstream has diverged from HEAD (rebase / force-push /
		// upstream tracks an advancing base), a two-dot `upstream..HEAD` diff leaks
		// the upstream's independent commits in reverse. Comparing against the
		// merge-base shows only what HEAD added.
		const MERGE_BASE = "abcabcabcabcabcabcabcabcabcabcabcabcabca";
		queueResponse(0, "origin/dev3/feature\n");   // getUpstreamRef (@{upstream})
		queueResponse(0, `${MERGE_BASE}\n`);          // git merge-base origin/dev3/feature HEAD
		queueResponse(0, "M\0src/app.ts\0");          // listDiffEntries (name-status)
		queueResponse(0, "1\t1\tsrc/app.ts\n");       // getDiffShortStat
		queueResponse(0, "1\t1\tsrc/app.ts\0");       // getNumstat
		queueResponse(0, catCheck(13));               // old ref (merge-base) batch-check
		queueResponse(0, catBlob("const a = 1;\n"));  // old ref batch
		queueResponse(0, catCheck(13));               // new ref (HEAD) batch-check
		queueResponse(0, catBlob("const a = 2;\n"));  // new ref batch

		const result = await getTaskDiff("/repo", "unpushed", {
			baseBranch: "main",
			compareRef: "origin/main",
			compareLabel: "origin/main",
		});

		// Upstream is resolved via merge-base before diffing.
		const cmds = spawnMock.mock.calls.map((c) => (c[0] as string[]).join(" "));
		expect(cmds.some((c) => c.includes("merge-base origin/dev3/feature HEAD"))).toBe(true);
		// Every diff endpoint is the merge-base SHA, never the bare upstream tip.
		const diffCmds = cmds.filter((c) => c.includes(" diff "));
		expect(diffCmds.length).toBeGreaterThan(0);
		for (const c of diffCmds) {
			expect(c).toContain(MERGE_BASE);
			expect(c).not.toContain("origin/dev3/feature");
		}
		// Label still reports the upstream the user is comparing against.
		expect(result.fallbackReason).toBeNull();
		expect(result.compareRef).toBe("origin/dev3/feature");
		expect(result.files[0]).toEqual(expect.objectContaining({
			displayPath: "src/app.ts",
			oldContent: "const a = 1;\n",
			newContent: "const a = 2;\n",
		}));
	});


	it("reports modified, added and renamed binary files in skippedFiles with their sizes", async () => {
		const opts = { baseBranch: "main", compareRef: "origin/main", compareLabel: "origin/main" };

		queueResponse(0, "M\0image.png\0");      // name-status
		queueResponse(0, "-\t-\timage.png\n");   // getBranchDiffStats
		queueResponse(0, "-\t-\timage.png\0");   // getNumstat
		queueResponse(0, catCheck(120));         // old ref batch-check
		queueResponse(0, catBlob("\0binary-old")); // old ref batch (null byte ⇒ binary)
		queueResponse(0, catCheck(250));         // new ref batch-check
		queueResponse(0, catBlob("\0binary-new-bytes")); // new ref batch
		const modified = await getTaskDiff("/repo", "branch", opts);
		expect(modified.files).toEqual([]);
		expect(modified.skippedFiles).toHaveLength(1);
		expect(modified.skippedFiles[0]).toMatchObject({ status: "modified", reason: "binary", displayPath: "image.png" });
		expect(modified.skippedFiles[0].oldSize).toBeGreaterThan(0);
		expect(modified.skippedFiles[0].newSize).toBeGreaterThan(0);

		queueResponse(0, "A\0assets/logo.png\0");   // name-status
		queueResponse(0, "-\t-\tassets/logo.png\n"); // getBranchDiffStats
		queueResponse(0, "-\t-\tassets/logo.png\0"); // getNumstat
		queueResponse(0, catCheck(64));             // new ref batch-check (added: no old side)
		queueResponse(0, catBlob("\0png-new-bytes")); // new ref batch
		const added = (await getTaskDiff("/repo", "branch", opts)).skippedFiles[0];
		expect(added).toMatchObject({ status: "added", reason: "binary", oldPath: null, oldSize: null });
		expect(added.newSize).toBeGreaterThan(0);

		queueResponse(0, "R100\0old.png\0new.png\0");  // name-status (rename)
		queueResponse(0, "-\t-\tnew.png\n");            // getBranchDiffStats
		queueResponse(0, "-\t-\t\0old.png\0new.png\0"); // getNumstat (rename, -z layout)
		queueResponse(0, catCheck(80));                 // old ref batch-check (old.png)
		queueResponse(0, catBlob("\0oldbin"));          // old ref batch
		queueResponse(0, catCheck(82));                 // new ref batch-check (new.png)
		queueResponse(0, catBlob("\0newbin2"));         // new ref batch
		const renamed = (await getTaskDiff("/repo", "branch", opts)).skippedFiles[0];
		expect(renamed).toMatchObject({ status: "renamed", reason: "binary", oldPath: "old.png", newPath: "new.png" });
		expect(renamed.oldSize).toBeGreaterThan(0);
		expect(renamed.newSize).toBeGreaterThan(0);
	});
});

// ─── listBranches ────────────────────────────────────────────────────────────

describe("listBranches", () => {
	it("returns local and remote branches without origin/HEAD, and [] when both are empty", async () => {
		queueResponse(0, "main\nfeature/login\n");                          // local
		queueResponse(0, "origin/main\norigin/HEAD\norigin/feature/login\n"); // remote
		const branches = await listBranches("/repo");
		expect(branches.filter((b) => !b.isRemote).map((b) => b.name)).toEqual(["main", "feature/login"]);
		expect(branches.filter((b) => b.isRemote).map((b) => b.name)).toEqual(["origin/main", "origin/feature/login"]);

		queueResponse(0, "");
		queueResponse(0, "");
		expect(await listBranches("/repo")).toEqual([]);
	});
});

// ─── detectDefaultCompareRef ────────────────────────────────────────────────

describe("detectDefaultCompareRef", () => {
	it("prefers origin/main even when a single committer owns the repo", async () => {
		queueResponse(0, "origin\n"); // remotes
		queueResponse(0, "abc123\n"); // rev-parse --verify origin/main
		queueResponse(0, "abc123\n"); // rev-parse --verify main
		queueResponse(0, ""); // branch --set-upstream-to origin/main main

		const ref = await detectDefaultCompareRef("/repo", "main");

		expect(ref).toBe("origin/main");
	});

	it("tracks the local base branch against origin when it does not exist yet", async () => {
		queueResponse(0, "origin\n"); // remotes
		queueResponse(0, "abc123\n"); // rev-parse --verify origin/master
		queueResponse(128, "", "fatal: ambiguous argument 'master'"); // rev-parse --verify master
		queueResponse(0, ""); // branch --track master origin/master

		expect(await detectDefaultCompareRef("/repo", "master")).toBe("origin/master");
		expect(spawnResponses).toHaveLength(0);
	});

	it("falls back to the local base without origin, and to origin/main when the base has no remote ref", async () => {
		queueResponse(0, "\n"); // remotes — none
		queueResponse(0, "abc123\n"); // rev-parse --verify main
		expect(await detectDefaultCompareRef("/repo", "main")).toBe("main");

		queueResponse(0, "origin\n"); // remotes
		queueResponse(128, "", "fatal"); // rev-parse --verify origin/develop
		queueResponse(0, "abc123\n"); // rev-parse --verify develop
		queueResponse(0, "abc123\n"); // rev-parse --verify origin/main
		expect(await detectDefaultCompareRef("/repo", "develop")).toBe("origin/main");
	});

	it("caches per projectPath+baseBranch key (no extra git spawns on repeat)", async () => {
		queueResponse(0, "\n");
		queueResponse(0, "abc123\n");
		expect(await detectDefaultCompareRef("/repo", "main")).toBe("main");
		// Same key hits the cache — nothing queued, no spawn attempted
		const spawnsAfterFirst = spawnMock.mock.calls.length;
		expect(await detectDefaultCompareRef("/repo", "main")).toBe("main");
		expect(spawnMock.mock.calls.length).toBe(spawnsAfterFirst);

		// Different repo: full detection runs again
		queueResponse(0, "origin\n");
		queueResponse(0, "abc123\n");
		queueResponse(0, "def456\n");
		queueResponse(0, "");
		expect(await detectDefaultCompareRef("/other-repo", "main")).toBe("origin/main");
		expect(spawnResponses).toHaveLength(0);
	});

	it("expires the cache after the TTL", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			queueResponse(0, "\n");
			queueResponse(0, "abc123\n");
			expect(await detectDefaultCompareRef("/repo", "main")).toBe("main");

			vi.setSystemTime(Date.now() + 11 * 60_000);

			queueResponse(0, "origin\n");
			queueResponse(0, "abc123\n");
			queueResponse(0, "def456\n");
			queueResponse(0, "");
			expect(await detectDefaultCompareRef("/repo", "main")).toBe("origin/main");
			expect(spawnResponses).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── getOriginUrl ────────────────────────────────────────────────────────────

describe("getOriginUrl", () => {
	it("returns the origin URL, or null when git fails", async () => {
		queueResponse(0, "https://github.com/h0x91b/dev-3.0.git\n");
		expect(await getOriginUrl("/repo")).toBe("https://github.com/h0x91b/dev-3.0.git");
		queueResponse(1, "", "fatal: not a git repository");
		expect(await getOriginUrl("/not-a-repo")).toBeNull();
	});
});

// ─── deriveForkUrl ───────────────────────────────────────────────────────────

describe("deriveForkUrl", () => {
	it("replaces the owner in HTTPS/SSH URLs and rejects unknown formats", () => {
		const cases: Array<[string, string | null]> = [
			["https://github.com/h0x91b/dev-3.0.git", "https://github.com/yanive/dev-3.0.git"],
			["git@github.com:h0x91b/dev-3.0.git", "git@github.com:yanive/dev-3.0.git"],
			["https://github.com/h0x91b/dev-3.0", "https://github.com/yanive/dev-3.0"],
			["not-a-url", null],
		];
		for (const [input, expected] of cases) {
			expect(deriveForkUrl(input, "yanive"), input).toBe(expected);
		}
	});
});


// ─── fetchFork ───────────────────────────────────────────────────────────────

describe("fetchFork", () => {
	it("adds remote and fetches branch successfully", async () => {
		queueResponse(0, "https://github.com/h0x91b/dev-3.0.git\n"); // get-url origin
		queueResponse(1, "", "fatal: No such remote");                  // get-url forkOwner (not found)
		queueResponse(0, "");                                            // remote add
		queueResponse(0, "");                                            // fetch
		const result = await fetchFork("/repo", "yanive", "feat/cool-stuff");
		expect(result).toBe(true);
	});

	it("reuses an existing remote and fetches into remote-tracking refs so the branch selector can see them", async () => {
		queueResponse(0, "https://github.com/h0x91b/dev-3.0.git\n"); // get-url origin
		queueResponse(0, "https://github.com/yanive/dev-3.0.git\n"); // get-url forkOwner (exists)
		queueResponse(0, "");                                            // fetch

		const result = await fetchFork("/repo", "yanive", "feat/cool-stuff");

		expect(result).toBe(true);
		expect(spawnMock).toHaveBeenNthCalledWith(
			3,
			[
				"git",
				"-c",
				"core.quotepath=false",
				"fetch",
				"yanive",
				"+refs/heads/feat/cool-stuff:refs/remotes/yanive/feat/cool-stuff",
				"--quiet",
			],
			{
				cwd: "/repo",
				stdout: "pipe",
				stderr: "pipe",
				detached: process.platform !== "win32",
			},
		);
	});

	it("returns false when the origin URL is unknown or the fetch fails", async () => {
		queueResponse(1, "", "fatal: not a git repository");
		expect(await fetchFork("/not-a-repo", "yanive", "feat/cool-stuff")).toBe(false);

		queueResponse(0, "https://github.com/h0x91b/dev-3.0.git\n");
		queueResponse(1, "", "fatal: No such remote");
		queueResponse(0, "");                                            // remote add
		queueResponse(1, "", "fatal: couldn't find remote ref");         // fetch fails
		expect(await fetchFork("/repo", "yanive", "nonexistent")).toBe(false);
	});
});

// ─── isForeignBranchRef ──────────────────────────────────────────────────────

describe("isForeignBranchRef", () => {
	it("no existingBranch or a local name → own work; a slash alone does not make it foreign", async () => {
		expect(await isForeignBranchRef("/repo", undefined)).toBe(false);
		expect(await isForeignBranchRef("/repo", null)).toBe(false);
		expect(await isForeignBranchRef("/repo", "   ")).toBe(false);
		expect(await isForeignBranchRef("/repo", "feature-login")).toBe(false);
		expect(spawnMock).not.toHaveBeenCalled(); // decided without asking git

		queueResponse(0, "origin\n");
		expect(await isForeignBranchRef("/repo", "feature/login")).toBe(false);
	});

	// The whole reason this asks for remotes instead of `rev-parse refs/remotes/...`:
	// a merged pull request's branch is deleted upstream, and the ref check would
	// then quietly hand the task back its own trust.
	it("origin, fork-remote and refs/remotes/ refs → foreign, even after the upstream branch was deleted", async () => {
		queueResponse(0, "origin\n");
		expect(await isForeignBranchRef("/repo", "origin/feat/x")).toBe(true);
		queueResponse(0, "origin\nyanive\n");
		expect(await isForeignBranchRef("/repo", "yanive/feat/x")).toBe(true);
		queueResponse(0, "origin\n");
		expect(await isForeignBranchRef("/repo", "refs/remotes/origin/feat/x")).toBe(true);
		queueResponse(0, "origin\nyanive\n"); // remote survives, branch does not
		expect(await isForeignBranchRef("/repo", "yanive/merged-and-deleted")).toBe(true);
	});

	it("git failure → foreign, never trusted", async () => {
		queueResponse(1, "", "fatal: not a git repository");
		expect(await isForeignBranchRef("/not-a-repo", "origin/feat/x")).toBe(true);
	});
});

// ─── localBranchNameForRef / refAuthorAndSubject ─────────────────────────────

describe("localBranchNameForRef", () => {
	// The reason this asks git instead of cutting at the first slash: `feat/x` is
	// itself a legal local branch name, and cutting would review `x`.
	it("strips the owning remote (origin or fork) but leaves a local name with a slash alone", async () => {
		queueResponse(0, "abc123\n");
		expect(await localBranchNameForRef("/repo", "origin/feat/x")).toBe("feat/x");
		queueResponse(0, "abc123\n");
		expect(await localBranchNameForRef("/repo", "yanive/feat/x")).toBe("feat/x");
		queueResponse(1, "", "fatal: Needed a single revision");
		expect(await localBranchNameForRef("/repo", "feat/x")).toBe("feat/x");
	});
});

describe("refAuthorAndSubject", () => {
	// A subject can hold anything a commit message's first line holds, including
	// the colons and parentheses the topic condenser later strips.
	it("splits author and subject verbatim, and answers nulls for a missing ref instead of throwing", async () => {
		queueResponse(0, `Ann\0feat(remote): serve it (#12)\n`);
		expect(await refAuthorAndSubject("/repo", "b")).toEqual({
			author: "Ann", subject: "feat(remote): serve it (#12)",
		});
		queueResponse(1, "", "fatal: bad revision");
		expect(await refAuthorAndSubject("/repo", "gone")).toEqual({ author: null, subject: null });
	});
});
