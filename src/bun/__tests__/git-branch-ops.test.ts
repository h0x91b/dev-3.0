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
	getBranchStatus,
	canRebaseCleanly,
	getUncommittedChanges,
	getTaskDiff,
	listBranches,
	detectDefaultCompareRef,
	getOriginUrl,
	deriveForkUrl,
	fetchFork,
	pullOrigin,
	_resetFetchState,
} from "../git";

beforeEach(() => {
	spawnResponses = [];
	_resetFetchState();
	spawnMock.mockClear();
	spawnMock.mockImplementation(() => {
		const response = spawnResponses.shift() ?? { exitCode: 1, stdout: "", stderr: "no response queued" };
		return makeFakeProc(response.stdout, response.stderr, response.exitCode);
	});
});

// ─── getCurrentBranch ────────────────────────────────────────────────────────

describe("getCurrentBranch", () => {
	it("returns current branch name", async () => {
		queueResponse(0, "main\n");
		const result = await getCurrentBranch("/repo");
		expect(result).toBe("main");
	});

	it("returns feature branch name with slashes", async () => {
		queueResponse(0, "dev3/fix-login-bug\n");
		const result = await getCurrentBranch("/repo");
		expect(result).toBe("dev3/fix-login-bug");
	});

	it("returns null on detached HEAD", async () => {
		queueResponse(0, "HEAD\n");
		const result = await getCurrentBranch("/repo");
		expect(result).toBeNull();
	});

	it("returns null when command fails", async () => {
		queueResponse(128, "", "fatal: not a git repository");
		const result = await getCurrentBranch("/not-a-repo");
		expect(result).toBeNull();
	});
});

// ─── pullOrigin ──────────────────────────────────────────────────────────────

describe("pullOrigin", () => {
	it("returns ok=true with stdout when pull succeeds", async () => {
		queueResponse(0, "Already up to date.\n");
		const result = await pullOrigin("/repo", "main");
		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("Already up to date.");
		expect(result.stderr).toBe("");
	});

	it("returns ok=false with stderr when pull fails", async () => {
		queueResponse(1, "", "fatal: unable to access 'https://...': Could not resolve host\n");
		const result = await pullOrigin("/repo", "main");
		expect(result.ok).toBe(false);
		expect(result.stderr).toMatch(/unable to access/);
	});

	it("passes branch name through to git pull", async () => {
		queueResponse(0, "Updating abc..def\nFast-forward\n");
		const result = await pullOrigin("/repo", "master");
		expect(result.ok).toBe(true);
		expect(result.stdout).toMatch(/Fast-forward/);
	});
});

// ─── isWorktreeDirty ────────────────────────────────────────────────────────

describe("isWorktreeDirty", () => {
	it("returns false for clean working tree", async () => {
		queueResponse(0, "");
		const result = await isWorktreeDirty("/repo");
		expect(result).toBe(false);
	});

	it("returns true when tracked changes exist", async () => {
		queueResponse(0, " M src/app.ts\n");
		const result = await isWorktreeDirty("/repo");
		expect(result).toBe(true);
	});

	it("returns true when only untracked files exist", async () => {
		queueResponse(0, "?? scratch.txt\n");
		const result = await isWorktreeDirty("/repo");
		expect(result).toBe(true);
	});

	it("returns false when git status fails", async () => {
		queueResponse(128, "", "fatal: not a git repository");
		const result = await isWorktreeDirty("/repo");
		expect(result).toBe(false);
	});
});

// ─── getUnpushedCount ────────────────────────────────────────────────────────

describe("getUnpushedCount", () => {
	it("returns 0 for empty branch name", async () => {
		const result = await getUnpushedCount("/repo", "");
		expect(result).toBe(0);
	});

	it("returns -1 when branch was never pushed (no remote tracking)", async () => {
		queueResponse(128, "", "fatal: Needed a single revision");
		const result = await getUnpushedCount("/repo", "dev3/task-branch");
		expect(result).toBe(-1);
	});

	it("returns 0 when all commits are pushed", async () => {
		queueResponse(0, "abc123\n"); // rev-parse --verify origin/branch
		queueResponse(0, "0\n");      // rev-list --count
		const result = await getUnpushedCount("/repo", "dev3/task-branch");
		expect(result).toBe(0);
	});

	it("returns N for N unpushed commits", async () => {
		queueResponse(0, "abc123\n");
		queueResponse(0, "3\n");
		const result = await getUnpushedCount("/repo", "dev3/task-branch");
		expect(result).toBe(3);
	});

	it("returns 0 when rev-list fails", async () => {
		queueResponse(0, "abc123\n");
		queueResponse(1, "", "error");
		const result = await getUnpushedCount("/repo", "dev3/task-branch");
		expect(result).toBe(0);
	});
});

// ─── getBranchStatus ─────────────────────────────────────────────────────────

describe("getBranchStatus", () => {
	it("returns ahead count for new commits", async () => {
		queueResponse(0, "0\t2\n"); // "behind\tahead"
		const result = await getBranchStatus("/repo", "origin/main");
		expect(result.ahead).toBe(2);
		expect(result.behind).toBe(0);
	});

	it("returns behind count when base has new commits", async () => {
		queueResponse(0, "1\t2\n");
		const result = await getBranchStatus("/repo", "origin/main");
		expect(result.ahead).toBe(2);
		expect(result.behind).toBe(1);
	});

	it("returns zero for fresh branch with no changes", async () => {
		queueResponse(0, "0\t0\n");
		const result = await getBranchStatus("/repo", "origin/main");
		expect(result.ahead).toBe(0);
		expect(result.behind).toBe(0);
	});

	it("returns zero when command fails", async () => {
		queueResponse(1, "", "error");
		const result = await getBranchStatus("/repo", "origin/main");
		expect(result.ahead).toBe(0);
		expect(result.behind).toBe(0);
	});
});

// ─── canRebaseCleanly ────────────────────────────────────────────────────────

describe("canRebaseCleanly", () => {
	it("returns true when merge-tree succeeds (no conflicts)", async () => {
		queueResponse(0, "abc123treehash\n");
		const result = await canRebaseCleanly("/repo", "origin/main");
		expect(result).toBe(true);
	});

	it("returns false when merge-tree reports conflicts", async () => {
		queueResponse(1, "", "CONFLICT (content): Merge conflict in app.ts");
		const result = await canRebaseCleanly("/repo", "origin/main");
		expect(result).toBe(false);
	});
});

// ─── getUncommittedChanges ───────────────────────────────────────────────────

describe("getUncommittedChanges", () => {
	it("returns zero for clean working tree", async () => {
		queueResponse(0, "");   // git diff --numstat HEAD
		queueResponse(0, "");   // git ls-files --others
		const result = await getUncommittedChanges("/repo");
		expect(result.insertions).toBe(0);
		expect(result.deletions).toBe(0);
	});

	it("counts insertions and deletions in tracked files", async () => {
		queueResponse(0, "3\t1\tapp.ts\n2\t0\tutils.ts\n");
		queueResponse(0, "");
		const result = await getUncommittedChanges("/repo");
		expect(result.insertions).toBe(5);
		expect(result.deletions).toBe(1);
	});

	it("handles binary files (- instead of numbers)", async () => {
		queueResponse(0, "-\t-\timage.png\n2\t1\tapp.ts\n");
		queueResponse(0, "");
		const result = await getUncommittedChanges("/repo");
		expect(result.insertions).toBe(2);
		expect(result.deletions).toBe(1);
	});

	// Tests for untracked file handling require real files on disk
	describe("untracked files", () => {
		const tmpDir = join(tmpdir(), `git-branch-ops-test-${Date.now()}`);

		beforeEach(() => {
			mkdirSync(tmpDir, { recursive: true });
		});

		afterAll(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("counts lines in untracked text files", async () => {
			writeFileSync(join(tmpDir, "readme.txt"), "line1\nline2\nline3\n");
			queueResponse(0, "");               // git diff --numstat HEAD
			queueResponse(0, "readme.txt\n");   // git ls-files --others
			const result = await getUncommittedChanges(tmpDir);
			expect(result.insertions).toBe(3);
			expect(result.deletions).toBe(0);
		});

		it("skips untracked binary files (null bytes)", async () => {
			// Binary file with null bytes — should be excluded
			const binaryContent = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
			writeFileSync(join(tmpDir, "image.png"), binaryContent);
			// Text file — should be counted
			writeFileSync(join(tmpDir, "app.ts"), "const x = 1;\n");
			queueResponse(0, "");                           // git diff --numstat HEAD
			queueResponse(0, "image.png\napp.ts\n");       // git ls-files --others
			const result = await getUncommittedChanges(tmpDir);
			expect(result.insertions).toBe(1); // only app.ts line, not binary
			expect(result.deletions).toBe(0);
		});

		it("skips untracked files larger than 1 MB", async () => {
			// Create a file larger than 1 MB
			const largeContent = "x".repeat(1_048_577) + "\n";
			writeFileSync(join(tmpDir, "huge.txt"), largeContent);
			writeFileSync(join(tmpDir, "small.ts"), "ok\n");
			queueResponse(0, "");                           // git diff --numstat HEAD
			queueResponse(0, "huge.txt\nsmall.ts\n");      // git ls-files --others
			const result = await getUncommittedChanges(tmpDir);
			expect(result.insertions).toBe(1); // only small.ts
			expect(result.deletions).toBe(0);
		});
	});
});

// ─── getTaskDiff ─────────────────────────────────────────────────────────────

describe("getTaskDiff", () => {
	it("builds a branch diff from git blobs", async () => {
		queueResponse(0, "M\0src/app.ts\0");
		queueResponse(0, "2\t1\tsrc/app.ts\n");
		queueResponse(0, "13\n");
		queueResponse(0, "13\n");
		queueResponse(0, "const a = 1;\n");
		queueResponse(0, "const a = 2;\n");
		queueResponse(0, "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n");

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
				hunks: ["diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;"],
			}),
		]);
	});

	it("builds an uncommitted diff with untracked files from the worktree", async () => {
		const tmpDir = join(tmpdir(), `git-inline-diff-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(join(tmpDir, "notes.txt"), "line 1\nline 2\n");

		queueResponse(0, "");
		queueResponse(0, "notes.txt\0");
		queueResponse(0, "");
		queueResponse(0, "notes.txt\n");
		queueResponse(1, "diff --git a/notes.txt b/notes.txt\nnew file mode 100644\n@@ -0,0 +1,2 @@\n+line 1\n+line 2\n");

		const result = await getTaskDiff(tmpDir, "uncommitted", {
			baseBranch: "main",
		});

		expect(result.compareRef).toBeNull();
		expect(result.summary).toEqual({
			files: 1,
			insertions: 2,
			deletions: 0,
		});
		expect(result.files).toEqual([
			expect.objectContaining({
				status: "untracked",
				displayPath: "notes.txt",
				oldContent: "",
				newContent: "line 1\nline 2\n",
				hunks: ["diff --git a/notes.txt b/notes.txt\nnew file mode 100644\n@@ -0,0 +1,2 @@\n+line 1\n+line 2"],
			}),
		]);

		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("falls back to branch diff when unpushed mode has no upstream", async () => {
		queueResponse(128, "", "fatal: no upstream configured");
		queueResponse(0, "A\0src/new.ts\0");
		queueResponse(0, "4\t0\tsrc/new.ts\n");
		queueResponse(0, "9\n");
		queueResponse(0, "export {};\n");
		queueResponse(0, "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n@@ -0,0 +1 @@\n+export {};\n");

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
			hunks: ["diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n@@ -0,0 +1 @@\n+export {};"],
		}));
	});

	it("reports binary files in skippedFiles with both sides' sizes", async () => {
		queueResponse(0, "M\0image.png\0");
		queueResponse(0, "-\t-\timage.png\n");
		queueResponse(0, "120\n");              // cat-file -s old
		queueResponse(0, "250\n");              // cat-file -s new
		queueResponse(0, "\0binary-old");       // show old (binary content)
		queueResponse(0, "\0binary-new-bytes"); // show new (binary content)

		const result = await getTaskDiff("/repo", "branch", {
			baseBranch: "main",
			compareRef: "origin/main",
			compareLabel: "origin/main",
		});

		expect(result.files).toEqual([]);
		expect(result.skippedFiles).toHaveLength(1);
		const skipped = result.skippedFiles[0];
		expect(skipped.status).toBe("modified");
		expect(skipped.reason).toBe("binary");
		expect(skipped.displayPath).toBe("image.png");
		expect(skipped.oldSize).toBeGreaterThan(0);
		expect(skipped.newSize).toBeGreaterThan(0);
	});

	it("reports added binary files with null oldSize", async () => {
		queueResponse(0, "A\0assets/logo.png\0");
		queueResponse(0, "-\t-\tassets/logo.png\n");
		queueResponse(0, "64\n");             // cat-file -s new
		queueResponse(0, "\0png-new-bytes");  // show new (binary)

		const result = await getTaskDiff("/repo", "branch", {
			baseBranch: "main",
			compareRef: "origin/main",
			compareLabel: "origin/main",
		});

		expect(result.files).toEqual([]);
		expect(result.skippedFiles).toHaveLength(1);
		const skipped = result.skippedFiles[0];
		expect(skipped.status).toBe("added");
		expect(skipped.reason).toBe("binary");
		expect(skipped.oldPath).toBeNull();
		expect(skipped.oldSize).toBeNull();
		expect(skipped.newSize).toBeGreaterThan(0);
	});

	it("reports renamed binary files with old→new paths and sizes", async () => {
		queueResponse(0, "R100\0old.png\0new.png\0");
		queueResponse(0, " 1 file changed, 0 insertions(+), 0 deletions(-)");
		queueResponse(0, "old.png\nnew.png\n");
		queueResponse(0, "80\n");         // cat-file -s old
		queueResponse(0, "82\n");         // cat-file -s new
		queueResponse(0, "\0oldbin");     // show old
		queueResponse(0, "\0newbin2");    // show new

		const result = await getTaskDiff("/repo", "branch", {
			baseBranch: "main",
			compareRef: "origin/main",
			compareLabel: "origin/main",
		});

		expect(result.skippedFiles).toHaveLength(1);
		const skipped = result.skippedFiles[0];
		expect(skipped.status).toBe("renamed");
		expect(skipped.reason).toBe("binary");
		expect(skipped.oldPath).toBe("old.png");
		expect(skipped.newPath).toBe("new.png");
		expect(skipped.oldSize).toBeGreaterThan(0);
		expect(skipped.newSize).toBeGreaterThan(0);
	});
});

// ─── listBranches ────────────────────────────────────────────────────────────

describe("listBranches", () => {
	it("returns local and remote branches", async () => {
		queueResponse(0, "main\nfeature/login\n");            // local
		queueResponse(0, "origin/main\norigin/feature/login\n"); // remote
		const branches = await listBranches("/repo");
		const local = branches.filter((b) => !b.isRemote).map((b) => b.name);
		const remote = branches.filter((b) => b.isRemote).map((b) => b.name);
		expect(local).toEqual(["main", "feature/login"]);
		expect(remote).toEqual(["origin/main", "origin/feature/login"]);
	});

	it("filters out origin/HEAD from remote branches", async () => {
		queueResponse(0, "main\n");
		queueResponse(0, "origin/main\norigin/HEAD\n");
		const branches = await listBranches("/repo");
		const remote = branches.filter((b) => b.isRemote).map((b) => b.name);
		expect(remote).toEqual(["origin/main"]);
	});

	it("handles empty branch lists", async () => {
		queueResponse(0, "");
		queueResponse(0, "");
		const branches = await listBranches("/repo");
		expect(branches).toEqual([]);
	});
});

// ─── detectDefaultCompareRef ────────────────────────────────────────────────

describe("detectDefaultCompareRef", () => {
	it("prefers local main when the last two weeks have one committer", async () => {
		queueResponse(0, "origin\n"); // remotes
		queueResponse(0, "abc123\n"); // rev-parse --verify origin/main
		queueResponse(0, "abc123\n"); // rev-parse --verify main
		queueResponse(0, ""); // branch --set-upstream-to origin/main main
		queueResponse(0, "   10 Arseniy Pavlenko <h0x91b@gmail.com>\n    2 h0x91B <H0X91B@gmail.com>\n"); // shortlog

		const ref = await detectDefaultCompareRef("/repo", "main");

		expect(ref).toBe("main");
	});

	it("prefers origin/main when there are multiple recent committers and a remote main exists", async () => {
		queueResponse(0, "origin\n"); // remotes
		queueResponse(0, "abc123\n"); // rev-parse --verify origin/main
		queueResponse(0, "def456\n"); // rev-parse --verify main
		queueResponse(0, ""); // branch --set-upstream-to origin/main main
		queueResponse(0, "   10 Arseniy Pavlenko <h0x91b@gmail.com>\n    3 roi <roir@wix.com>\n"); // shortlog

		const ref = await detectDefaultCompareRef("/repo", "main");

		expect(ref).toBe("origin/main");
	});

	it("uses origin/master when master is the collaborative base branch", async () => {
		queueResponse(0, "origin\n"); // remotes
		queueResponse(0, "abc123\n"); // rev-parse --verify origin/master
		queueResponse(128, "", "fatal: ambiguous argument 'master'"); // rev-parse --verify master
		queueResponse(0, ""); // branch --track master origin/master
		queueResponse(0, "   10 Arseniy Pavlenko <h0x91b@gmail.com>\n    3 roi <roir@wix.com>\n"); // shortlog

		const ref = await detectDefaultCompareRef("/repo", "master");

		expect(ref).toBe("origin/master");
	});
});

// ─── getOriginUrl ────────────────────────────────────────────────────────────

describe("getOriginUrl", () => {
	it("returns origin URL on success", async () => {
		queueResponse(0, "https://github.com/h0x91b/dev-3.0.git\n");
		const url = await getOriginUrl("/repo");
		expect(url).toBe("https://github.com/h0x91b/dev-3.0.git");
	});

	it("returns null when command fails", async () => {
		queueResponse(1, "", "fatal: not a git repository");
		const url = await getOriginUrl("/not-a-repo");
		expect(url).toBeNull();
	});
});

// ─── deriveForkUrl ───────────────────────────────────────────────────────────

describe("deriveForkUrl", () => {
	it("replaces owner in HTTPS URL", () => {
		const result = deriveForkUrl("https://github.com/h0x91b/dev-3.0.git", "yanive");
		expect(result).toBe("https://github.com/yanive/dev-3.0.git");
	});

	it("replaces owner in SSH URL", () => {
		const result = deriveForkUrl("git@github.com:h0x91b/dev-3.0.git", "yanive");
		expect(result).toBe("git@github.com:yanive/dev-3.0.git");
	});

	it("handles HTTPS URL without .git suffix", () => {
		const result = deriveForkUrl("https://github.com/h0x91b/dev-3.0", "yanive");
		expect(result).toBe("https://github.com/yanive/dev-3.0");
	});

	it("returns null for unrecognized URL format", () => {
		const result = deriveForkUrl("not-a-url", "yanive");
		expect(result).toBeNull();
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

	it("fetches fork branches into remote-tracking refs so the branch selector can see them", async () => {
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
			},
		);
	});

	it("reuses existing remote", async () => {
		queueResponse(0, "https://github.com/h0x91b/dev-3.0.git\n"); // get-url origin
		queueResponse(0, "https://github.com/yanive/dev-3.0.git\n"); // get-url forkOwner (exists)
		queueResponse(0, "");                                            // fetch
		const result = await fetchFork("/repo", "yanive", "feat/cool-stuff");
		expect(result).toBe(true);
	});

	it("returns false when origin URL cannot be determined", async () => {
		queueResponse(1, "", "fatal: not a git repository");
		const result = await fetchFork("/not-a-repo", "yanive", "feat/cool-stuff");
		expect(result).toBe(false);
	});

	it("returns false when fetch fails", async () => {
		queueResponse(0, "https://github.com/h0x91b/dev-3.0.git\n");
		queueResponse(1, "", "fatal: No such remote");
		queueResponse(0, "");                                            // remote add
		queueResponse(1, "", "fatal: couldn't find remote ref");         // fetch fails
		const result = await fetchFork("/repo", "yanive", "nonexistent");
		expect(result).toBe(false);
	});
});
