import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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

// Replace Bun.spawn with a real Node.js child_process implementation so
// git.ts functions run actual git commands in integration tests.
vi.mock("../spawn", async () => {
	const { spawn: cpSpawn } = await import("child_process");
	return {
		spawn: (cmd: string[], opts?: Record<string, unknown>) => {
			const child = cpSpawn(cmd[0], cmd.slice(1), {
				cwd: opts?.cwd as string | undefined,
				env: (opts?.env as NodeJS.ProcessEnv | undefined) ?? process.env,
				stdio: ["pipe", "pipe", "pipe"],
			});

			if (opts?.stdin instanceof Blob) {
				(opts.stdin as Blob).arrayBuffer().then((buf) => {
					child.stdin!.write(Buffer.from(buf));
					child.stdin!.end();
				});
			} else {
				child.stdin?.end();
			}

			const toWebStream = (readable: NodeJS.ReadableStream) =>
				new ReadableStream({
					start(controller) {
						readable.on("data", (chunk: Buffer) =>
							controller.enqueue(new Uint8Array(chunk)),
						);
						readable.on("end", () => controller.close());
						readable.on("error", (err: Error) => controller.error(err));
					},
				});

			return {
				exited: new Promise<number>((resolve) =>
					child.on("close", (code: number | null) => resolve(code ?? 1)),
				),
				stdout: toWebStream(child.stdout!),
				stderr: toWebStream(child.stderr!),
			};
		},
	};
});

import { isContentMergedInto } from "../git";

// ─── Helpers ────────────────────────────────────────────────────────────────

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

function g(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, env: GIT_ENV, stdio: "pipe", encoding: "utf-8" });
}

interface TestRepo {
	dir: string;
	local: string; // working clone (task branch checked out here)
}

function createTestRepo(): TestRepo {
	const dir = mkdtempSync(join(tmpdir(), "dev3-git-test-"));
	const origin = join(dir, "origin.git");
	const local = join(dir, "local");

	g(`git init --bare "${origin}"`, dir);
	g(`git clone "${origin}" "${local}"`, dir);
	g("git config user.email test@test.com", local);
	g("git config user.name Test", local);

	// Initial commit with a file that later tests will also modify (to simulate
	// context drift from other PRs touching the same file after the task merge).
	writeFileSync(join(local, "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
	g("git add app.ts", local);
	g('git commit -m "initial"', local);
	g("git branch -M main", local); // ensure branch is named 'main' regardless of git default
	g("git push -u origin main", local);

	return { dir, local };
}

function cleanup({ dir }: TestRepo): void {
	rmSync(dir, { recursive: true, force: true });
}

/** Create two commits on the current branch that add/modify feature.ts */
function makeTaskCommits(local: string): void {
	writeFileSync(
		join(local, "feature.ts"),
		"export const add = (a: number, b: number) => a + b;\n",
	);
	g("git add feature.ts", local);
	g('git commit -m "feat: add function"', local);

	writeFileSync(
		join(local, "feature.ts"),
		"export const add = (a: number, b: number) => a + b;\n" +
			"export const sub = (a: number, b: number) => a - b;\n",
	);
	g("git add feature.ts", local);
	g('git commit -m "feat: add sub function"', local);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("isContentMergedInto", () => {
	let repo: TestRepo | undefined;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => {
		if (repo) cleanup(repo);
		repo = undefined;
	});

	it("returns false when task branch has not been merged", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(false);
	});

	it("returns true after squash merge", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		g("git checkout main", repo.local);
		g("git merge --squash task-branch", repo.local);
		g('git commit -m "squash: task (#1)"', repo.local);
		g("git push origin main", repo.local);

		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns true after squash merge even when main diverges further with commits to the same files (the actual bug scenario)", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		// Squash merge the task
		g("git checkout main", repo.local);
		g("git merge --squash task-branch", repo.local);
		g('git commit -m "squash: task (#1)"', repo.local);

		// Simulate other PRs landing on main that touch the same file —
		// this is what caused the false positive before the patch-id fix.
		writeFileSync(
			join(repo.local, "feature.ts"),
			"export const add = (a: number, b: number) => a + b;\n" +
				"export const sub = (a: number, b: number) => a - b;\n" +
				"export const mul = (a: number, b: number) => a * b;\n",
		);
		g("git add feature.ts", repo.local);
		g('git commit -m "feat: add mul (unrelated PR)"', repo.local);
		g("git push origin main", repo.local);

		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns true after rebase merge", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		// Rebase onto main using a temp branch so task-branch keeps its original SHAs,
		// simulating GitHub's "rebase and merge" which creates new SHAs on main but
		// leaves the original task branch untouched.
		g("git checkout -b temp-rebase task-branch", repo.local);
		g("git rebase main", repo.local);
		g("git checkout main", repo.local);
		g("git merge --ff-only temp-rebase", repo.local);
		g("git push origin main", repo.local);
		g("git branch -D temp-rebase", repo.local);

		// task-branch still has original commits (original SHAs, not the rebased ones)
		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns true after rebase merge even when main diverges further with commits to the same files", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		// Rebase merge (GitHub "rebase and merge")
		g("git checkout -b temp-rebase task-branch", repo.local);
		g("git rebase main", repo.local);
		g("git checkout main", repo.local);
		g("git merge --ff-only temp-rebase", repo.local);
		g("git branch -D temp-rebase", repo.local);

		// Simulate another PR landing on main that touches the same file
		writeFileSync(
			join(repo.local, "feature.ts"),
			"export const add = (a: number, b: number) => a + b;\n" +
				"export const sub = (a: number, b: number) => a - b;\n" +
				"export const mul = (a: number, b: number) => a * b;\n",
		);
		g("git add feature.ts", repo.local);
		g('git commit -m "feat: add mul (unrelated PR)"', repo.local);
		g("git push origin main", repo.local);

		// task-branch still has original commits
		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns false when only some task commits are present in main (partial merge)", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		// Cherry-pick only the first commit to main, leaving the second unmerged
		const firstSha = g("git log --format=%H", repo.local).trim().split("\n")[1]; // parent = first commit
		g("git checkout main", repo.local);
		g(`git cherry-pick ${firstSha}`, repo.local);
		g("git push origin main", repo.local);

		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(false);
	});
});
