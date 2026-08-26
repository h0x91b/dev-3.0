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

// Every git call in this suite goes through the replay layer, so a normal run
// spawns no processes and touches no disk. `--record` swaps in real git.
vi.mock("../spawn", async () => {
	const { sessionSpawn } = await import("./git-replay");
	return { spawn: sessionSpawn };
});

import { writeFileSync } from "fs";
import { join } from "path";
import {
	RECORDING,
	endScenario,
	loadTranscript,
	saveTranscript,
	useRecorder,
	useReplay,
	type GitTranscript,
} from "./git-replay";
import { getTaskDiff, _resetFetchState } from "../git";

/**
 * `recent` mode diffs `HEAD~N..HEAD`, clamped to the branch's own commits (never
 * into base-branch history). The clamp and the file set it produces are OUR logic,
 * so the git side is a recorded transcript of real git output rather than a live
 * repository — see git-replay.ts for why that keeps its teeth.
 *
 * git's own behaviour still gets exercised against a real repository elsewhere:
 * rename detection in git-diff-rename.test.ts, filename encoding in
 * git-unicode-filenames.test.ts, the no-remote path in git-diff-no-remote.test.ts.
 *
 * TO REGENERATE the fixtures (needs real git; do not run on CI):
 *   DEV3_GIT_RECORD=1 bunx vitest run --config vitest.config.bun.ts \
 *     src/bun/__tests__/git-diff-recent.test.ts
 * Then read the diff: a changed command means the code changed what it asks git.
 */
const FIXTURES = join(import.meta.dirname, "fixtures", "git-diff-recent");
// Replay never touches the filesystem, so this path only has to be stable.
const REPLAY_WORKTREE = "/replay/worktree/local";

describe("getTaskDiff recent mode", () => {
	let worktree: string;
	let transcript: GitTranscript;
	let fixture: string;
	// Only used while recording; a normal run never imports a repo at all.
	let realRepo: { dir: string; local: string } | null = null;

	// Adds three own commits on top of origin/main, each touching a distinct file
	// so the effective range is unambiguous from the file set alone.
	async function makeThreeCommits(local: string): Promise<void> {
		const { g } = await import("./git-test-helpers");
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

	/**
	 * Installs the scenario named by the current test. In replay that is the
	 * recorded transcript; while recording it builds the real repo, runs `setup`
	 * against it and captures every git call.
	 */
	async function scenario(
		name: string,
		setup: (local: string) => Promise<void> = makeThreeCommits,
	): Promise<void> {
		fixture = join(FIXTURES, `${name}.json`);
		transcript = [];
		if (!RECORDING) {
			worktree = REPLAY_WORKTREE;
			useReplay(loadTranscript(fixture), worktree);
			return;
		}
		const helpers = await import("./git-test-helpers");
		realRepo = helpers.createTestRepo();
		worktree = realRepo.local;
		await setup(worktree);
		useRecorder(helpers.createSpawnMock().spawn, worktree, transcript);
	}

	beforeEach(() => {
		_resetFetchState();
	});

	afterEach(async () => {
		if (RECORDING) {
			saveTranscript(fixture, transcript);
			if (realRepo) (await import("./git-test-helpers")).cleanup(realRepo);
			realRepo = null;
		}
		endScenario();
	});

	it("N=1 shows only the last commit", async () => {
		await scenario("n1-last-commit");

		const result = await getTaskDiff(worktree, "recent", { baseBranch: "main", count: 1 });

		expect(result.mode).toBe("recent");
		expect(result.recentCount).toBe(1);
		expect(result.files.map((f) => f.displayPath)).toEqual(["c.ts"]);
	});

	it("N=3 shows the last three commits", async () => {
		await scenario("n3-three-commits");

		const result = await getTaskDiff(worktree, "recent", { baseBranch: "main", count: 3 });

		expect(result.recentCount).toBe(3);
		expect(result.files.map((f) => f.displayPath).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("clamps N to the branch's own commits and relabels the effective count", async () => {
		await scenario("clamp-to-own-commits"); // only 3 own commits above origin/main

		const result = await getTaskDiff(worktree, "recent", { baseBranch: "main", count: 10 });

		// Clamped to 3 — never reaches into base-branch history (the "initial" commit).
		expect(result.recentCount).toBe(3);
		expect(result.files.map((f) => f.displayPath).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
		// The clamp must not surface the base commit's file.
		expect(result.files.map((f) => f.displayPath)).not.toContain("app.ts");
	});

	it("returns an empty diff (recentCount 0) when the branch has no commits of its own", async () => {
		// Fresh branch sitting exactly on origin/main — zero own commits.
		await scenario("no-own-commits", async (local) => {
			const { g } = await import("./git-test-helpers");
			g("git checkout -b fresh origin/main", local);
		});

		const result = await getTaskDiff(worktree, "recent", { baseBranch: "main", count: 5 });

		expect(result.recentCount).toBe(0);
		expect(result.files).toEqual([]);
		expect(result.skippedFiles).toEqual([]);
		expect(result.summary.files).toBe(0);
	});

	it("excludes uncommitted working-tree edits", async () => {
		await scenario("excludes-uncommitted", async (local) => {
			await makeThreeCommits(local);
			// Dirty the working tree with an edit that is NOT committed.
			writeFileSync(join(local, "b.ts"), "export const b = 2;\nexport const dirty = true;\n");
		});

		const result = await getTaskDiff(worktree, "recent", { baseBranch: "main", count: 1 });

		// N=1 is only commit C (c.ts); the uncommitted b.ts edit must not appear.
		expect(result.files.map((f) => f.displayPath)).toEqual(["c.ts"]);
	});

	it("defaults to the last commit (N=1) when count is omitted", async () => {
		await scenario("default-count");

		const result = await getTaskDiff(worktree, "recent", { baseBranch: "main" });

		expect(result.recentCount).toBe(1);
		expect(result.files.map((f) => f.displayPath)).toEqual(["c.ts"]);
	});
});
