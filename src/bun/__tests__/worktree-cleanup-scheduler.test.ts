/**
 * The daily worktree cleanup: runs once per 24 h across restarts and across
 * app versions sharing one ~/.dev3.0, never within the first hour after launch,
 * and — through the real `prune()` — never touches an open task or an unmerged branch.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeScanDeps } from "../../cli/commands/doctor-worktrees";
import { projectStorageKey } from "../../shared/project-storage-key";
import { runWorktreeCleanup, type WorktreeCleanupResult } from "../worktree-cleanup-job";
import {
	checkWorktreeCleanup,
	cleanupDue,
	INITIAL_DELAY_MS,
	startWorktreeCleanupScheduler,
	stopWorktreeCleanupScheduler,
	type WorktreeCleanupDeps,
	type WorktreeCleanupState,
} from "../worktree-cleanup-scheduler";

vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-28T12:00:00.000Z");

const EMPTY_RESULT: WorktreeCleanupResult = {
	scannedDirs: 3,
	bytesBefore: 100,
	removedDirs: 1,
	freedBytes: 40,
	skipped: 0,
	failed: 0,
	outcomes: [],
};

/** One on-disk state file shared by every "app version", with a real mutex. */
function sharedDisk() {
	let state: WorktreeCleanupState = {};
	let queue = Promise.resolve();
	const withState: WorktreeCleanupDeps["withState"] = (fn) => {
		const run = queue.then(() => {
			const { next, result } = fn(structuredClone(state));
			if (next) state = next;
			return result;
		});
		queue = run.then(() => undefined, () => undefined);
		return run;
	};
	return { withState, read: () => state };
}

function appVersion(disk: ReturnType<typeof sharedDisk>, clock: { now: number }, overrides: Partial<WorktreeCleanupDeps> = {}) {
	const run = vi.fn(async () => EMPTY_RESULT);
	const deps: WorktreeCleanupDeps = {
		now: () => clock.now,
		enabled: async () => true,
		canRun: () => true,
		withState: disk.withState,
		run,
		...overrides,
	};
	return { deps, run };
}

describe("cleanupDue", () => {
	it("is due with no previous run, and again only after 24 h", () => {
		expect(cleanupDue({}, T0)).toBe(true);
		const ran = { lastStartedAt: new Date(T0).toISOString() };
		expect(cleanupDue(ran, T0 + 23 * HOUR)).toBe(false);
		expect(cleanupDue(ran, T0 + DAY)).toBe(true);
	});

	it("does not let a stamp from the far future block cleanup forever", () => {
		expect(cleanupDue({ lastStartedAt: new Date(T0 + 3 * DAY).toISOString() }, T0)).toBe(true);
	});
});

describe("checkWorktreeCleanup", () => {
	it("runs once per day, not on every launch", async () => {
		const disk = sharedDisk();
		const clock = { now: T0 };

		const first = appVersion(disk, clock);
		expect(await checkWorktreeCleanup(first.deps)).toBe("ran");
		expect(disk.read().lastStartedAt).toBe(new Date(T0).toISOString());
		expect(disk.read().lastResult?.freedBytes).toBe(40);

		// A restart two hours later reads the persisted stamp and skips.
		clock.now = T0 + 2 * HOUR;
		const restarted = appVersion(disk, clock);
		expect(await checkWorktreeCleanup(restarted.deps)).toBe("not-due");
		expect(restarted.run).not.toHaveBeenCalled();

		clock.now = T0 + DAY + HOUR;
		expect(await checkWorktreeCleanup(restarted.deps)).toBe("ran");
		expect(restarted.run).toHaveBeenCalledTimes(1);
	});

	it("lets only one of two versions sharing ~/.dev3.0 run it", async () => {
		const disk = sharedDisk();
		const clock = { now: T0 };
		const a = appVersion(disk, clock);
		const b = appVersion(disk, clock);
		const outcomes = await Promise.all([checkWorktreeCleanup(a.deps), checkWorktreeCleanup(b.deps)]);
		expect(outcomes.sort()).toEqual(["not-due", "ran"]);
		expect(a.run.mock.calls.length + b.run.mock.calls.length).toBe(1);
	});

	it("stays off when the user opted out", async () => {
		const { deps, run } = appVersion(sharedDisk(), { now: T0 }, { enabled: async () => false });
		expect(await checkWorktreeCleanup(deps)).toBe("disabled");
		expect(run).not.toHaveBeenCalled();
	});

	it("never claims the day when the worker is missing", async () => {
		const disk = sharedDisk();
		const { deps, run } = appVersion(disk, { now: T0 }, { canRun: () => false });
		expect(await checkWorktreeCleanup(deps)).toBe("unavailable");
		expect(run).not.toHaveBeenCalled();
		expect(disk.read().lastStartedAt).toBeUndefined();
	});

	it("keeps the claim after a failed run, so a crash does not retry on every launch", async () => {
		const disk = sharedDisk();
		const clock = { now: T0 };
		const { deps } = appVersion(disk, clock, { run: async () => { throw new Error("boom"); } });
		expect(await checkWorktreeCleanup(deps)).toBe("failed");
		expect(disk.read().lastError).toContain("boom");
		clock.now = T0 + HOUR;
		expect(await checkWorktreeCleanup(deps)).toBe("not-due");
	});
});

describe("startWorktreeCleanupScheduler", () => {
	afterEach(() => {
		stopWorktreeCleanupScheduler();
		vi.useRealTimers();
	});

	it("does nothing during the first hour after launch, then checks hourly", async () => {
		vi.useFakeTimers();
		const enabled = vi.fn(async () => false);
		const { deps } = appVersion(sharedDisk(), { now: T0 }, { enabled });
		expect(INITIAL_DELAY_MS).toBeGreaterThanOrEqual(HOUR);

		startWorktreeCleanupScheduler(deps);
		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1000);
		expect(enabled).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1000);
		expect(enabled).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(HOUR);
		expect(enabled).toHaveBeenCalledTimes(2);
	});
});

describe("runWorktreeCleanup (the real prune, 14 days)", () => {
	const HOME = "/home/tester/.dev3.0";
	const REPO = "/src/repo";
	const SLUG = projectStorageKey(REPO);
	const root = `${HOME}/worktrees/${SLUG}`;
	const ago = (days: number) => new Date(T0 - days * DAY).toISOString();

	// open: an old To Do task with only diffs/logs; live: an old in-progress task
	// with a worktree; unmerged: a finished task whose branch never merged;
	// merged: a finished task whose branch merged; fresh: finished 5 days ago;
	// young/old teardown: finished, worktree left behind, branch unmerged, 40d/70d ago.
	const tasks = [
		{ id: "0aaaaaaa-0000", status: "todo", createdAt: ago(200) },
		{ id: "0bbbbbbb-0000", status: "in-progress", createdAt: ago(90), statusEnteredAt: ago(60) },
		{ id: "0ccccccc-0000", status: "completed", createdAt: ago(40), movedAt: ago(20) },
		{ id: "0ddddddd-0000", status: "completed", createdAt: ago(40), movedAt: ago(20) },
		{ id: "0eeeeeee-0000", status: "cancelled", createdAt: ago(6), movedAt: ago(5) },
		{ id: "0fffffff-0000", status: "completed", createdAt: ago(50), movedAt: ago(40) },
		{ id: "0a0a0a0a-0000", status: "completed", createdAt: ago(80), movedAt: ago(70) },
	];
	// 01111111 has no task record at all: an orphan whose dir was last touched 300 days ago.
	const shortIds = [...tasks.map((t) => t.id.slice(0, 8)), "01111111"];
	const withWorktree = new Set([`${root}/0bbbbbbb`, `${root}/0fffffff`, `${root}/0a0a0a0a`, `${root}/01111111`]);
	const dirs = shortIds.map((id) => `${root}/${id}`);

	function deps(removed: string[], gitCalls: string[][]): WorktreeScanDeps {
		return {
			dev3Home: HOME,
			now: T0,
			platform: "linux",
			listDirs: (dir) => {
				if (dir === `${HOME}/worktrees`) return [SLUG];
				if (dir === root) return shortIds;
				throw new Error(`ENOENT: ${dir}`);
			},
			exists: (path) =>
				path === `${HOME}/worktrees` || path === REPO || dirs.includes(path) || [...withWorktree].some((d) => path === `${d}/worktree`),
			readFile: (path) => {
				if (path === `${HOME}/projects.json`) return JSON.stringify([{ id: "p", name: "repo", path: REPO }]);
				if (path === `${HOME}/data/${SLUG}/tasks.json`) return JSON.stringify(tasks);
				throw new Error(`ENOENT: ${path}`);
			},
			mtimeMs: () => T0 - 300 * DAY,
			dirSizes: (list) => new Map(list.map((d) => [d, 10])),
			git: (_repo, args) => {
				gitCalls.push(args);
				if (args[0] === "worktree" && args[1] === "list") return { status: 0, stdout: [...withWorktree].map((d) => `worktree ${d}/worktree`).join("\n") };
				if (args[0] === "for-each-ref") return { status: 0, stdout: "dev3/task-0ccccccc\ndev3/task-0ddddddd\ndev3/task-0fffffff\ndev3/task-0a0a0a0a\n" };
				if (args[0] === "rev-parse") return { status: 1, stdout: "" };
				if (args[0] === "branch" && args[1] === "--merged") return { status: 0, stdout: "dev3/task-0ddddddd\n" };
				return { status: 0, stdout: "" };
			},
			remove: (path) => removed.push(path),
		};
	}

	it("deletes only what no open task owns, older than 14 days, and keeps every unmerged branch", () => {
		const removed: string[] = [];
		const gitCalls: string[][] = [];
		const result = runWorktreeCleanup(deps(removed, gitCalls));

		expect(removed.sort()).toEqual([`${root}/01111111`, `${root}/0a0a0a0a/worktree`, `${root}/0ccccccc`, `${root}/0ddddddd`]);
		expect(result.removedDirs).toBe(3);
		expect(result.skipped).toBe(1);

		// A leftover worktree on an unmerged branch waits for the 60-day floor.
		expect(removed.some((p) => p.startsWith(`${root}/0fffffff`))).toBe(false);
		expect(gitCalls.some((c) => c[0] === "worktree" && c[1] === "remove" && c[c.length - 1]?.includes("0fffffff"))).toBe(false);

		// The open task's dir and the live worktree survive however old they are.
		expect(removed).not.toContain(`${root}/0aaaaaaa`);
		expect(removed.some((p) => p.startsWith(`${root}/0bbbbbbb`))).toBe(false);
		expect(removed).not.toContain(`${root}/0eeeeeee`);

		// The unmerged branch is never deleted; the merged one only with a safe -d.
		const branchDeletes = gitCalls.filter((c) => c[0] === "branch" && (c[1] === "-d" || c[1] === "-D"));
		expect(branchDeletes).toEqual([["branch", "-d", "dev3/task-0ddddddd"]]);
	});

	it("hands the kept tree to the after-prune step", () => {
		const afterPrune = vi.fn(() => "compressed");
		const result = runWorktreeCleanup(deps([], []), { afterPrune });
		expect(afterPrune).toHaveBeenCalledWith(`${HOME}/worktrees`);
		expect(result.afterPrune).toBe("compressed");
	});
});
