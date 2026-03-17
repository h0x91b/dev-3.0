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
	spawn: () => {
		const response = spawnResponses.shift() ?? { exitCode: 1, stdout: "", stderr: "no response queued" };
		const encoder = new TextEncoder();
		return {
			exited: Promise.resolve(response.exitCode),
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(response.stdout));
					controller.close();
				},
			}),
			stderr: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(response.stderr));
					controller.close();
				},
			}),
		};
	},
}));

import {
	getCurrentBranch,
	getUnpushedCount,
	getBranchStatus,
	canRebaseCleanly,
	getUncommittedChanges,
	listBranches,
	detectDefaultCompareRef,
	getOriginUrl,
	deriveForkUrl,
	fetchFork,
	_resetFetchState,
} from "../git";

beforeEach(() => {
	spawnResponses = [];
	_resetFetchState();
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
