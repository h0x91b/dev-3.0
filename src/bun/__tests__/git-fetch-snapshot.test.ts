import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Project, Task } from "../../shared/types";

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

import {
	fetchOrigin,
	_resetFetchState,
	saveDiffSnapshot,
	taskDir,
} from "../git";
import { createTestRepo, cleanup, makeTaskCommits, g, type TestRepo } from "./git-test-helpers";

// ─── fetchOrigin ─────────────────────────────────────────────────────────────

describe("fetchOrigin", () => {
	let repo: TestRepo;

	beforeEach(() => {
		_resetFetchState();
		repo = createTestRepo();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("returns true on successful fetch", async () => {
		const ok = await fetchOrigin(repo.local);
		expect(ok).toBe(true);
	});

	it("returns false when project has no remote", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-no-remote-"));
		const local = join(dir, "repo");
		g(`git init "${local}"`, dir);
		g("git config user.email test@test.com", local);
		g("git config user.name Test", local);
		writeFileSync(join(local, "file.txt"), "test");
		g("git add file.txt", local);
		g('git commit -m "init"', local);

		try {
			const ok = await fetchOrigin(local);
			expect(ok).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deduplicates concurrent fetches for the same project", async () => {
		const results = await Promise.all([
			fetchOrigin(repo.local),
			fetchOrigin(repo.local),
			fetchOrigin(repo.local),
		]);
		expect(results).toEqual([true, true, true]);
	});

	it("skips fetch within cooldown period", async () => {
		const ok1 = await fetchOrigin(repo.local);
		expect(ok1).toBe(true);

		const ok2 = await fetchOrigin(repo.local);
		expect(ok2).toBe(true);
	});

	it("allows fetch for different projects concurrently", async () => {
		const repo2 = createTestRepo();
		try {
			const [ok1, ok2] = await Promise.all([
				fetchOrigin(repo.local),
				fetchOrigin(repo2.local),
			]);
			expect(ok1).toBe(true);
			expect(ok2).toBe(true);
		} finally {
			cleanup(repo2);
		}
	});
});

// ─── saveDiffSnapshot ────────────────────────────────────────────────────────

describe("saveDiffSnapshot", () => {
	let repo: TestRepo;
	const project: Project = { id: "proj-1", name: "Test", path: "" } as Project;
	const task: Task = { id: "task-1000-0000-0000" } as Task;

	beforeEach(() => {
		repo = createTestRepo();
		project.path = repo.local;
		(task as { worktreePath: string }).worktreePath = repo.local;
	});

	afterEach(() => cleanup(repo));

	it("saves a .patch file when there are changes", async () => {
		makeTaskCommits(repo.local);
		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		expect(existsSync(diffsDir)).toBe(true);

		const files = readdirSync(diffsDir).filter((f: string) => f.endsWith(".patch"));
		expect(files).toHaveLength(1);

		const content = readFileSync(join(diffsDir, files[0]), "utf-8");
		expect(content).toContain("feature.ts");
		expect(content).toContain("add");
	});

	it("skips saving when there is no diff", async () => {
		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = readdirSync(diffsDir).filter((f: string) => f.endsWith(".patch"));
		expect(files).toHaveLength(0);
	});

	it("skips saving when diff is unchanged from the last snapshot", async () => {
		makeTaskCommits(repo.local);

		await saveDiffSnapshot(project, task, "origin/main");
		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = readdirSync(diffsDir).filter((f: string) => f.endsWith(".patch"));
		expect(files).toHaveLength(1);
	});

	it("saves a new file when diff changes", async () => {
		makeTaskCommits(repo.local);
		await saveDiffSnapshot(project, task, "origin/main");

		writeFileSync(join(repo.local, "extra.ts"), "export const x = 42;\n");
		g("git add extra.ts", repo.local);
		g('git commit -m "add extra"', repo.local);

		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.advanceTimersByTime(60_000);
		await saveDiffSnapshot(project, task, "origin/main");
		vi.useRealTimers();

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = readdirSync(diffsDir).filter((f: string) => f.endsWith(".patch"));
		expect(files).toHaveLength(2);
	});

	it("prunes old snapshots beyond MAX_DIFF_SNAPSHOTS", async () => {
		makeTaskCommits(repo.local);
		const diffsDir = join(taskDir(project, task), "diffs");
		mkdirSync(diffsDir, { recursive: true });

		for (let i = 0; i < 55; i++) {
			const name = `2025-01-01T00-00-${String(i).padStart(2, "0")}.patch`;
			writeFileSync(join(diffsDir, name), `patch-${i}`);
		}

		await saveDiffSnapshot(project, task, "origin/main");

		const files = readdirSync(diffsDir).filter((f: string) => f.endsWith(".patch"));
		expect(files.length).toBeLessThanOrEqual(50);
	});

	it("skips saving when diff exceeds 1 MB", async () => {
		const bigContent = "x".repeat(1_100_000) + "\n";
		writeFileSync(join(repo.local, "big.txt"), bigContent);
		g("git add big.txt", repo.local);
		g('git commit -m "add big file"', repo.local);

		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = readdirSync(diffsDir).filter((f: string) => f.endsWith(".patch"));
		expect(files).toHaveLength(0);
	});
});
