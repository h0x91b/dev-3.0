import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	collectWorktreeReport,
	formatBytes,
	parseDurationDays,
	prune,
	renderPruneOutcomes,
	renderWorktreeReport,
	type WorktreeEntry,
	type WorktreeScanDeps,
} from "../commands/doctor-worktrees";
import { handleDoctor, type DoctorDeps } from "../commands/doctor";
import { projectStorageKey } from "../../shared/project-storage-key";
import {
	CLI_EXIT_CODE_PRUNE_INCOMPLETE,
	CLI_EXIT_CODE_SUCCESS,
	CLI_EXIT_CODE_USAGE_ERROR,
} from "../../shared/cli-exit-codes";

const HOME = "/home/tester/.dev3.0";
const REPO = "/src/repoA";
const SLUG = projectStorageKey(REPO);
const GONE_SLUG = projectStorageKey("/src/deletedRepo");
const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const GB = 1024 ** 3;
const MB = 1024 ** 2;

function daysAgo(days: number): string {
	return new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
}

const TASKS = [
	{ id: "aaaaaaaa-0000-0000-0000-000000000000", seq: 10, status: "in-progress", createdAt: daysAgo(1), statusEnteredAt: daysAgo(1) },
	{ id: "bbbbbbbb-0000-0000-0000-000000000000", seq: 11, status: "completed", createdAt: daysAgo(40), movedAt: daysAgo(38) },
	{ id: "dddddddd-0000-0000-0000-000000000000", seq: 12, status: "completed", createdAt: daysAgo(120), movedAt: daysAgo(90) },
	{ id: "eeeeeeee-0000-0000-0000-000000000000", seq: 13, status: "completed", createdAt: daysAgo(4), movedAt: daysAgo(3) },
	{ id: "99999999-0000-0000-0000-000000000000", seq: 14, status: "todo", createdAt: daysAgo(200) },
];

/**
 * Fixture disk: one live project with an open task, a finished task whose
 * teardown never ran, an orphan on an unmerged branch, two metadata-only dirs of
 * different ages, a metadata-only dir of a still-open task, plus a whole slug
 * whose project no longer exists.
 */
function fixtureDeps(overrides: Partial<WorktreeScanDeps> = {}): WorktreeScanDeps {
	const dirsWithWorktree = new Set([
		`${HOME}/worktrees/${SLUG}/aaaaaaaa`,
		`${HOME}/worktrees/${SLUG}/bbbbbbbb`,
		`${HOME}/worktrees/${SLUG}/cccccccc`,
		`${HOME}/worktrees/${GONE_SLUG}/ffffffff`,
	]);
	const taskDirs = [
		...dirsWithWorktree,
		`${HOME}/worktrees/${SLUG}/dddddddd`,
		`${HOME}/worktrees/${SLUG}/eeeeeeee`,
		`${HOME}/worktrees/${SLUG}/99999999`,
	];
	const sizes = new Map<string, number>([
		[`${HOME}/worktrees/${SLUG}/aaaaaaaa`, 2 * GB],
		[`${HOME}/worktrees/${SLUG}/aaaaaaaa/worktree`, 2 * GB - 10 * MB],
		[`${HOME}/worktrees/${SLUG}/bbbbbbbb`, 1 * GB],
		[`${HOME}/worktrees/${SLUG}/bbbbbbbb/worktree`, 900 * MB],
		[`${HOME}/worktrees/${SLUG}/cccccccc`, 3 * GB],
		[`${HOME}/worktrees/${SLUG}/cccccccc/worktree`, 3 * GB - 5 * MB],
		[`${HOME}/worktrees/${GONE_SLUG}/ffffffff`, 500 * MB],
		[`${HOME}/worktrees/${GONE_SLUG}/ffffffff/worktree`, 490 * MB],
		[`${HOME}/worktrees/${SLUG}/dddddddd`, 40 * MB],
		[`${HOME}/worktrees/${SLUG}/eeeeeeee`, 20 * MB],
		[`${HOME}/worktrees/${SLUG}/99999999`, 5 * MB],
	]);

	return {
		dev3Home: HOME,
		now: NOW,
		platform: "linux",
		listDirs: (dir) => {
			if (dir === `${HOME}/worktrees`) return [SLUG, GONE_SLUG];
			if (dir === `${HOME}/worktrees/${SLUG}`) return ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee", "99999999", "not-a-task-dir"];
			if (dir === `${HOME}/worktrees/${GONE_SLUG}`) return ["ffffffff"];
			throw new Error(`ENOENT: ${dir}`);
		},
		exists: (path) =>
			new Set([
				`${HOME}/worktrees`,
				REPO,
				...taskDirs,
				...[...dirsWithWorktree].map((d) => `${d}/worktree`),
			]).has(path),
		readFile: (path) => {
			if (path === `${HOME}/projects.json`) {
				return JSON.stringify([{ id: "p1", name: "repoA", path: REPO, defaultBaseBranch: "main" }]);
			}
			if (path === `${HOME}/data/${SLUG}/tasks.json`) return JSON.stringify(TASKS);
			throw new Error(`ENOENT: ${path}`);
		},
		mtimeMs: () => NOW - 200 * 24 * 60 * 60 * 1000,
		dirSizes: (dirs) => new Map(dirs.map((d) => [d, sizes.get(d) ?? 0])),
		git: (repo, args) => {
			if (repo !== REPO) return { status: 1, stdout: "" };
			if (args[0] === "worktree" && args[1] === "list") {
				return {
					status: 0,
					stdout: [...dirsWithWorktree]
						.filter((d) => d.includes(SLUG))
						.map((d) => `worktree ${d}/worktree`)
						.join("\n\n"),
				};
			}
			if (args[0] === "for-each-ref") {
				return { status: 0, stdout: "dev3/task-bbbbbbbb\ndev3/task-cccccccc\n" };
			}
			if (args[0] === "rev-parse") return { status: 1, stdout: "" };
			if (args[0] === "branch" && args[1] === "--merged") return { status: 0, stdout: "dev3/task-bbbbbbbb\n" };
			return { status: 0, stdout: "" };
		},
		remove: () => {},
		...overrides,
	};
}

function entry(entries: WorktreeEntry[], shortId: string): WorktreeEntry {
	const found = entries.find((e) => e.shortId === shortId);
	if (!found) throw new Error(`no entry for ${shortId}`);
	return found;
}

describe("collectWorktreeReport — classification", () => {
	const report = collectWorktreeReport(fixtureDeps());

	it("keeps a worktree whose task is still open", () => {
		const e = entry(report.entries, "aaaaaaaa");
		expect(e.category).toBe("live-open");
		expect(e.reclaimableBytes).toBe(0);
		expect(e.seq).toBe("10");
	});

	it("flags a worktree whose task already completed as an unfinished teardown", () => {
		const e = entry(report.entries, "bbbbbbbb");
		expect(e.category).toBe("abandoned-teardown");
		// Only the worktree is reclaimable — the task still exists and its diffs stay.
		expect(e.reclaimableBytes).toBe(900 * MB);
		expect(e.needsForce).toBe(false);
	});

	it("flags a worktree with no task record as orphaned and locks an unmerged branch", () => {
		const e = entry(report.entries, "cccccccc");
		expect(e.category).toBe("orphaned");
		expect(e.reclaimableBytes).toBe(3 * GB);
		expect(e.branch).toBe("dev3/task-cccccccc");
		expect(e.branchMerged).toBe(false);
		expect(e.needsForce).toBe(true);
		expect(e.recommendation).toContain("--force-unmerged");
	});

	it("reports a slug whose project no longer exists, with git facts unknown", () => {
		const e = entry(report.entries, "ffffffff");
		expect(e.category).toBe("orphaned");
		expect(e.projectName).toBeNull();
		expect(e.registeredInGit).toBeNull();
		expect(e.branch).toBeNull();
		expect(e.needsForce).toBe(false);
	});

	it("recommends deleting metadata of a task finished over a month ago", () => {
		const e = entry(report.entries, "dddddddd");
		expect(e.category).toBe("metadata-only");
		expect(e.ageBucket).toBe("stale");
		expect(e.reclaimableBytes).toBe(40 * MB);
	});

	it("keeps metadata of a recently finished task", () => {
		const e = entry(report.entries, "eeeeeeee");
		expect(e.ageBucket).toBe("recent");
		expect(e.reclaimableBytes).toBe(0);
	});

	it("never reclaims metadata of a task that is still open", () => {
		const e = entry(report.entries, "99999999");
		expect(e.category).toBe("metadata-only");
		expect(e.ageBucket).toBe("stale");
		expect(e.reclaimableBytes).toBe(0);
		expect(e.recommendation).toContain("keep");
	});

	it("ignores directories that are not 8-hex task ids", () => {
		expect(report.entries.some((e) => e.shortId === "not-a-task-dir")).toBe(false);
	});

	it("totals disk and reclaimable bytes, and says how much needs the force flag", () => {
		expect(report.totalBytes).toBe(2 * GB + 1 * GB + 3 * GB + 500 * MB + 40 * MB + 20 * MB + 5 * MB);
		expect(report.totalReclaimableBytes).toBe(900 * MB + 3 * GB + 500 * MB + 40 * MB);
		expect(report.unmergedBytes).toBe(3 * GB);
	});

	it("sorts projects by reclaimable size", () => {
		expect(report.projects[0]!.slug).toBe(SLUG);
		expect(report.projects.map((p) => p.projectName)).toEqual(["repoA", null]);
	});

	it("returns an empty report when the worktree root does not exist", () => {
		const empty = collectWorktreeReport(fixtureDeps({ exists: () => false }));
		expect(empty.rootMissing).toBe(true);
		expect(empty.entries).toEqual([]);
	});

	it("falls back to directory mtime when there is no task record", () => {
		const e = entry(report.entries, "cccccccc");
		expect(e.ageDays).toBe(200);
		expect(e.lastActivity).not.toBeNull();
	});
});

describe("renderWorktreeReport", () => {
	it("leads with the per-project table and ends with the reclaim headline", () => {
		const out = renderWorktreeReport(collectWorktreeReport(fixtureDeps()));
		expect(out).toContain("PROJECT");
		expect(out).toContain("RECLAIMABLE");
		expect(out).toContain("repoA");
		expect(out).toMatch(/Reclaim [\d.]+ GB: dev3 doctor --worktrees --prune-orphans/);
		expect(out).toContain("--force-unmerged");
	});

	it("says nothing is reclaimable instead of printing an empty headline", () => {
		const deps = fixtureDeps({
			readFile: (path) => {
				if (path === `${HOME}/projects.json`) {
					return JSON.stringify([{ id: "p1", name: "repoA", path: REPO, defaultBaseBranch: "main" }]);
				}
				if (path === `${HOME}/data/${projectStorageKey(REPO)}/tasks.json`) {
					// Everything on disk belongs to an open task.
					return JSON.stringify([
						...["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee", "99999999", "ffffffff"].map((id, i) => ({
							id: `${id}-0000-0000-0000-000000000000`,
							seq: 100 + i,
							status: "in-progress",
							createdAt: daysAgo(1),
						})),
					]);
				}
				throw new Error(`ENOENT: ${path}`);
			},
		});
		const out = renderWorktreeReport(collectWorktreeReport(deps));
		expect(out).toContain("Nothing reclaimable");
	});

	it("says how many reclaimable rows it did not print instead of truncating silently", () => {
		const many: WorktreeEntry[] = Array.from({ length: 20 }, (_, i) => ({
			projectName: "repoA",
			projectPath: REPO,
			slug: SLUG,
			shortId: String(i).padStart(8, "0"),
			dir: `${HOME}/worktrees/${SLUG}/${String(i).padStart(8, "0")}`,
			category: "orphaned",
			seq: null,
			taskStatus: null,
			branch: null,
			branchMerged: null,
			registeredInGit: true,
			bytes: MB,
			worktreeBytes: MB,
			lastActivity: daysAgo(90),
			ageDays: 90,
			ageBucket: "stale",
			reclaimableBytes: MB,
			needsForce: false,
			recommendation: "orphan",
		}));
		const out = renderWorktreeReport({
			projects: [],
			entries: many,
			totalBytes: 20 * MB,
			totalReclaimableBytes: 20 * MB,
			unmergedBytes: 0,
			worktreesRoot: `${HOME}/worktrees`,
			rootMissing: false,
		});
		expect(out).toContain("5 more not shown");
	});
});

describe("parseDurationDays", () => {
	it.each([
		["30d", 30],
		["2w", 14],
		["6m", 180],
		["1y", 365],
		["45", 45],
	])("parses %s", (raw, days) => {
		expect(parseDurationDays(raw)).toBe(days);
	});

	it.each(["", "soon", "-5d", "0d", "3 months", "1.5w"])("rejects %s", (raw) => {
		expect(parseDurationDays(raw)).toBeNull();
	});
});

describe("prune", () => {
	function pruneWith(options: Parameters<typeof prune>[1], overrides: Partial<WorktreeScanDeps> = {}) {
		const removed: string[] = [];
		const gitCalls: string[][] = [];
		const deps = fixtureDeps({
			remove: (path) => {
				removed.push(path);
			},
			git: (repo, args) => {
				gitCalls.push(args);
				return fixtureDeps().git(repo, args);
			},
			...overrides,
		});
		// The report must come from deps that do NOT record calls, so the
		// assertions below only see what pruning itself did.
		const report = collectWorktreeReport(fixtureDeps());
		return { outcomes: prune(report, options, deps), removed, gitCalls };
	}

	it("removes the whole directory of an orphan but only the worktree of an unfinished teardown", () => {
		const { outcomes, removed } = pruneWith({ orphans: true, olderThanDays: null, forceUnmerged: false });
		expect(removed).toContain(`${HOME}/worktrees/${GONE_SLUG}/ffffffff`);
		expect(removed).toContain(`${HOME}/worktrees/${SLUG}/bbbbbbbb/worktree`);
		expect(removed).not.toContain(`${HOME}/worktrees/${SLUG}/bbbbbbbb`);
		expect(outcomes.find((o) => o.shortId === "bbbbbbbb")!.action).toBe("removed-worktree");
		expect(outcomes.find((o) => o.shortId === "ffffffff")!.action).toBe("removed-dir");
	});

	it("refuses an unmerged orphan and says which flag would delete it", () => {
		const { outcomes, removed } = pruneWith({ orphans: true, olderThanDays: null, forceUnmerged: false });
		const skipped = outcomes.find((o) => o.shortId === "cccccccc")!;
		expect(skipped.action).toBe("skipped");
		expect(skipped.freedBytes).toBe(0);
		expect(skipped.reason).toContain("--force-unmerged");
		expect(removed).not.toContain(`${HOME}/worktrees/${SLUG}/cccccccc`);
	});

	it("deletes the unmerged orphan once the force flag is given", () => {
		const { outcomes, removed, gitCalls } = pruneWith({ orphans: true, olderThanDays: null, forceUnmerged: true });
		expect(removed).toContain(`${HOME}/worktrees/${SLUG}/cccccccc`);
		expect(outcomes.find((o) => o.shortId === "cccccccc")!.action).toBe("removed-dir");
		expect(gitCalls).toContainEqual(["branch", "-D", "dev3/task-cccccccc"]);
	});

	it("deletes a merged branch with -d and never touches an open task", () => {
		const { outcomes, gitCalls } = pruneWith({ orphans: true, olderThanDays: null, forceUnmerged: false });
		expect(gitCalls).toContainEqual(["branch", "-d", "dev3/task-bbbbbbbb"]);
		expect(outcomes.some((o) => o.shortId === "aaaaaaaa")).toBe(false);
	});

	it("prunes git's worktree registry once per repo after deleting", () => {
		const { gitCalls } = pruneWith({ orphans: true, olderThanDays: null, forceUnmerged: true });
		expect(gitCalls.filter((c) => c[0] === "worktree" && c[1] === "prune")).toHaveLength(1);
	});

	it("leaves metadata directories alone unless --prune-older-than selects them", () => {
		const orphansOnly = pruneWith({ orphans: true, olderThanDays: null, forceUnmerged: false });
		expect(orphansOnly.removed).not.toContain(`${HOME}/worktrees/${SLUG}/dddddddd`);

		const byAge = pruneWith({ orphans: false, olderThanDays: 30, forceUnmerged: false });
		expect(byAge.removed).toEqual([`${HOME}/worktrees/${SLUG}/dddddddd`]);
		expect(byAge.outcomes.map((o) => o.shortId)).toEqual(["dddddddd"]);
	});

	it("never selects the metadata of a still-open task, however old", () => {
		const { removed } = pruneWith({ orphans: false, olderThanDays: 30, forceUnmerged: false });
		expect(removed).not.toContain(`${HOME}/worktrees/${SLUG}/99999999`);
	});

	it("reports a failed delete instead of claiming the space back", () => {
		const { outcomes } = pruneWith(
			{ orphans: true, olderThanDays: null, forceUnmerged: false },
			{
				remove: () => {
					throw new Error("EPERM");
				},
			},
		);
		const failed = outcomes.filter((o) => o.action === "failed");
		expect(failed.length).toBeGreaterThan(0);
		expect(failed[0]!.freedBytes).toBe(0);
		expect(failed[0]!.reason).toContain("EPERM");
	});
});

describe("renderPruneOutcomes", () => {
	it("says nothing was deleted when nothing matched", () => {
		expect(renderPruneOutcomes([])).toContain("nothing was deleted");
	});

	it("totals freed bytes and counts skipped and failed rows", () => {
		const out = renderPruneOutcomes([
			{ dir: "/d/a", shortId: "aaaaaaaa", projectName: "repoA", category: "orphaned", action: "removed-dir", freedBytes: GB, branchDeleted: "dev3/task-aaaaaaaa", reason: "whole task directory removed" },
			{ dir: "/d/b", shortId: "bbbbbbbb", projectName: "repoA", category: "orphaned", action: "skipped", freedBytes: 0, branchDeleted: null, reason: "not merged" },
			{ dir: "/d/c", shortId: "cccccccc", projectName: "repoA", category: "orphaned", action: "failed", freedBytes: 0, branchDeleted: null, reason: "EPERM" },
		]);
		expect(out).toContain("Freed 1.00 GB. 1 skipped, 1 failed.");
		expect(out).toContain("deleted branch dev3/task-aaaaaaaa");
	});
});

describe("formatBytes", () => {
	it.each([
		[0, "0 B"],
		[2048, "2 KB"],
		[5 * MB, "5 MB"],
		[2 * GB + 32 * MB, "2.03 GB"],
	])("formats %i as %s", (bytes, expected) => {
		expect(formatBytes(bytes)).toBe(expected);
	});
});

describe("dev3 doctor --worktrees", () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let outSpy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as never);
		outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		exitSpy.mockRestore();
		outSpy.mockRestore();
		errSpy.mockRestore();
	});

	const unusedDoctorDeps = {} as DoctorDeps;
	const stdout = (): string => outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");

	it("reports without deleting anything and exits 0", async () => {
		const removed: string[] = [];
		const deps = fixtureDeps({ remove: (p) => void removed.push(p) });
		await expect(handleDoctor({ flags: { worktrees: "true" }, positional: [] }, unusedDoctorDeps, deps)).rejects.toThrow("exit");
		expect(removed).toEqual([]);
		expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODE_SUCCESS);
		expect(stdout()).toContain("RECLAIMABLE");
	});

	it("emits the whole report plus prune outcomes as JSON", async () => {
		await expect(
			handleDoctor({ flags: { worktrees: "true", json: "true" }, positional: [] }, unusedDoctorDeps, fixtureDeps()),
		).rejects.toThrow("exit");
		const parsed = JSON.parse(stdout()) as { worktrees: { entries: WorktreeEntry[] }; pruned: unknown[] };
		expect(parsed.worktrees.entries.length).toBe(7);
		expect(parsed.pruned).toEqual([]);
	});

	it("exits with the prune-incomplete code when an unmerged orphan was skipped", async () => {
		await expect(
			handleDoctor({ flags: { worktrees: "true", "prune-orphans": "true" }, positional: [] }, unusedDoctorDeps, fixtureDeps()),
		).rejects.toThrow("exit");
		expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODE_PRUNE_INCOMPLETE);
	});

	it("exits 0 when the prune reclaimed everything it selected", async () => {
		await expect(
			handleDoctor(
				{ flags: { worktrees: "true", "prune-orphans": "true", "force-unmerged": "true" }, positional: [] },
				unusedDoctorDeps,
				fixtureDeps(),
			),
		).rejects.toThrow("exit");
		expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODE_SUCCESS);
	});

	it("rejects a --prune-older-than value it cannot parse", async () => {
		await expect(
			handleDoctor({ flags: { worktrees: "true", "prune-older-than": "soon" }, positional: [] }, unusedDoctorDeps, fixtureDeps()),
		).rejects.toThrow("exit");
		expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODE_USAGE_ERROR);
		expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("30d");
	});

	it("rejects --prune-older-than with no value at all", async () => {
		await expect(
			handleDoctor({ flags: { worktrees: "true", "prune-older-than": "true" }, positional: [] }, unusedDoctorDeps, fixtureDeps()),
		).rejects.toThrow("exit");
		expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODE_USAGE_ERROR);
	});
});
