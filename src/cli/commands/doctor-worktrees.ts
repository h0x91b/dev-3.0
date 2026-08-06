/**
 * `dev3 doctor --worktrees` — what dev3 keeps on disk, and what of it is garbage.
 *
 * Nobody could see this before: `~/.dev3.0/worktrees/<slug>/<shortId>/` grows one
 * directory per task forever, and some of those directories belong to task records
 * that no longer exist. A worktree whose task record is gone is invisible in the UI
 * and no code path will ever re-run teardown for it, so it stays until the disk
 * fills (measured: 83 GB total, 11.8 GB of it fully orphaned).
 *
 * Report-only by default, like `--processes`: it reads directories, task records and
 * `git worktree list`, and prints what could be reclaimed. Deletion happens only
 * behind an explicit flag the user typed, never implicitly and never at startup.
 * An orphan whose branch is not merged into the base branch is never deleted
 * without a second, separate force flag — that is unpushed human work.
 */

import { readdirSync, readFileSync, rmSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { projectStorageKey } from "../../shared/project-storage-key";
import { DEV3_HOME } from "../../bun/paths";

/** How a task directory relates to the task records dev3 still has. */
export type WorktreeCategory =
	/** Worktree present, task still open — the legitimate cost of an active task. */
	| "live-open"
	/** Worktree present, task already completed/cancelled — teardown never finished. */
	| "abandoned-teardown"
	/** Worktree present, NO task record in any project — invisible, unreclaimable by the app. */
	| "orphaned"
	/** No `worktree/` left: just the `diffs/` + `logs/` backup of a finished task. */
	| "metadata-only";

/** Age since the task's last activity, bucketed into the three answers that matter. */
export type AgeBucket = "recent" | "borderline" | "stale";

const RECENT_DAYS = 14;
const BORDERLINE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);

export interface WorktreeEntry {
	/** Configured project name, or null when no project owns this slug any more. */
	projectName: string | null;
	/** Repo path, or null when no project owns this slug (git checks impossible). */
	projectPath: string | null;
	slug: string;
	shortId: string;
	/** Absolute task directory (`~/.dev3.0/worktrees/<slug>/<shortId>`). */
	dir: string;
	category: WorktreeCategory;
	/** Human task number when a task record still exists. */
	seq: string | null;
	taskStatus: string | null;
	/** `dev3/task-<shortId>` when that branch still exists in the repo. */
	branch: string | null;
	/** True/false when checkable, null when there is no repo or no branch. */
	branchMerged: boolean | null;
	/** Whether `git worktree list` still registers this worktree; null without a repo. */
	registeredInGit: boolean | null;
	/** Whole task directory, bytes. */
	bytes: number;
	/** The `worktree/` subtree alone, bytes (0 when there is none). */
	worktreeBytes: number;
	lastActivity: string | null;
	ageDays: number | null;
	ageBucket: AgeBucket | null;
	/** What deleting this entry would actually free — 0 when it must be kept. */
	reclaimableBytes: number;
	/** Reclaimable, but only with the explicit unmerged-branch force flag. */
	needsForce: boolean;
	recommendation: string;
}

export interface ProjectWorktreeTotals {
	projectName: string | null;
	slug: string;
	dirs: number;
	bytes: number;
	reclaimableBytes: number;
	counts: Record<WorktreeCategory, number>;
}

export interface WorktreeReport {
	projects: ProjectWorktreeTotals[];
	entries: WorktreeEntry[];
	totalBytes: number;
	totalReclaimableBytes: number;
	/** Part of `totalReclaimableBytes` locked behind `--force-unmerged`. */
	unmergedBytes: number;
	/** Set when `~/.dev3.0/worktrees` does not exist at all. */
	worktreesRoot: string;
	rootMissing: boolean;
}

/** Everything the scan and the prune touch outside themselves, injectable for tests. */
export interface WorktreeScanDeps {
	dev3Home: string;
	now: number;
	platform: NodeJS.Platform;
	listDirs: (dir: string) => string[];
	exists: (path: string) => boolean;
	readFile: (path: string) => string;
	/** Directory mtime in ms, or null when unreadable. */
	mtimeMs: (path: string) => number | null;
	/** Batched size lookup: absolute path → bytes. Missing keys mean "unknown" (0). */
	dirSizes: (dirs: string[]) => Map<string, number>;
	git: (repo: string, args: string[]) => { status: number | null; stdout: string };
	/** Recursive delete. Only ever called from a prune flag the user typed. */
	remove: (path: string) => void;
}

export function realWorktreeScanDeps(dev3Home: string = DEV3_HOME): WorktreeScanDeps {
	return {
		dev3Home,
		now: Date.now(),
		platform: process.platform,
		listDirs: (dir) =>
			readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name),
		exists: (path) => {
			try {
				statSync(path);
				return true;
			} catch {
				return false;
			}
		},
		readFile: (path) => readFileSync(path, "utf8"),
		mtimeMs: (path) => {
			try {
				return statSync(path).mtimeMs;
			} catch {
				return null;
			}
		},
		dirSizes: (dirs) => measureSizes(dirs, process.platform),
		git: (repo, args) => {
			try {
				const res = spawnSync("git", args, { cwd: repo, encoding: "utf-8", timeout: 60_000 });
				return { status: res.status, stdout: res.stdout || "" };
			} catch {
				return { status: null, stdout: "" };
			}
		},
		remove: (path) => rmSync(path, { recursive: true, force: true }),
	};
}

/**
 * `du -sk` in batches on POSIX (one spawn per ~200 dirs beats one per dir by an
 * order of magnitude on a 1400-directory tree); a recursive walk on Windows,
 * which has no `du`.
 */
function measureSizes(dirs: string[], platform: NodeJS.Platform): Map<string, number> {
	const sizes = new Map<string, number>();
	if (platform === "win32") {
		for (const dir of dirs) sizes.set(dir, walkSize(dir));
		return sizes;
	}
	const BATCH = 200;
	for (let i = 0; i < dirs.length; i += BATCH) {
		const batch = dirs.slice(i, i + BATCH);
		const res = spawnSync("du", ["-sk", ...batch], { encoding: "utf-8", timeout: 600_000 });
		for (const line of (res.stdout || "").split("\n")) {
			const match = line.match(/^(\d+)\t(.+)$/);
			if (match) sizes.set(match[2]!, Number(match[1]) * 1024);
		}
		// `du` exits non-zero when any single argument was unreadable but still
		// reports the rest, so partial output is kept rather than discarded.
		for (const dir of batch) {
			if (!sizes.has(dir)) sizes.set(dir, walkSize(dir));
		}
	}
	return sizes;
}

function walkSize(dir: string): number {
	let total = 0;
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			total += walkSize(path);
		} else if (entry.isFile()) {
			try {
				total += statSync(path).size;
			} catch {
				/* vanished mid-walk — contributes nothing */
			}
		}
	}
	return total;
}

interface RawProject {
	id: string;
	name: string;
	path: string;
	defaultBaseBranch?: string;
	kind?: string;
	deleted?: boolean;
}

interface RawTask {
	id: string;
	seq?: number | string;
	status?: string;
	createdAt?: string;
	movedAt?: string | null;
	statusEnteredAt?: string;
}

/** Projects from both files; a virtual ("Operations") project has no worktrees. */
function readProjects(deps: WorktreeScanDeps): RawProject[] {
	const out: RawProject[] = [];
	for (const file of [`${deps.dev3Home}/projects.json`, `${deps.dev3Home}/virtual-projects.json`]) {
		try {
			const parsed = JSON.parse(deps.readFile(file)) as RawProject[];
			if (Array.isArray(parsed)) out.push(...parsed);
		} catch {
			/* absent or unreadable — contributes nothing */
		}
	}
	// Virtual ("Operations") projects are kept: they own directories under
	// worktrees/ too, and skipping them would report their task dirs as orphaned.
	// A deleted project is kept for the same reason — its git facts still answer
	// "is this branch merged", which decides whether the GB may be deleted.
	return out;
}

function readTasks(deps: WorktreeScanDeps, slug: string): RawTask[] {
	try {
		const parsed = JSON.parse(deps.readFile(`${deps.dev3Home}/data/${slug}/tasks.json`)) as RawTask[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** Newest of the task's own timestamps — the closest thing to "last activity". */
function lastActivityMs(task: RawTask): number | null {
	const stamps = [task.statusEnteredAt, task.movedAt, task.createdAt]
		.map((s) => (s ? Date.parse(s) : Number.NaN))
		.filter((ms) => Number.isFinite(ms));
	return stamps.length > 0 ? Math.max(...stamps) : null;
}

function bucketFor(ageDays: number | null): AgeBucket | null {
	if (ageDays === null) return null;
	if (ageDays < RECENT_DAYS) return "recent";
	if (ageDays <= BORDERLINE_DAYS) return "borderline";
	return "stale";
}

interface RepoFacts {
	registeredShortIds: Set<string>;
	branches: Set<string>;
	mergedBranches: Set<string>;
	usable: boolean;
}

/** One git pass per project: registered worktrees, dev3 branches, merged branches. */
function readRepoFacts(deps: WorktreeScanDeps, project: RawProject | null): RepoFacts {
	const empty: RepoFacts = {
		registeredShortIds: new Set(),
		branches: new Set(),
		mergedBranches: new Set(),
		usable: false,
	};
	if (!project || !deps.exists(project.path)) return empty;

	const list = deps.git(project.path, ["worktree", "list", "--porcelain"]);
	if (list.status !== 0) return empty;
	const registeredShortIds = new Set<string>();
	for (const line of list.stdout.split("\n")) {
		// Path comparison instead of realpath: /private/var vs /var symlink
		// differences make absolute equality unreliable, the trailing
		// `<shortId>/worktree` is not.
		const match = line.match(/^worktree .*[\\/]([0-9a-f]{8})[\\/]worktree$/i);
		if (match) registeredShortIds.add(match[1]!.toLowerCase());
	}

	const refs = deps.git(project.path, ["for-each-ref", "--format=%(refname:short)", "refs/heads/dev3/"]);
	const branches = new Set(refs.stdout.split("\n").map((l) => l.trim()).filter(Boolean));

	// Prefer the remote base: a local `main` that has not been pulled for weeks
	// reports freshly merged branches as unmerged, which would hide reclaimable GB.
	const base = project.defaultBaseBranch || "main";
	const remote = `origin/${base}`;
	const baseRef = deps.git(project.path, ["rev-parse", "--verify", "--quiet", remote]).status === 0 ? remote : base;
	const merged = deps.git(project.path, ["branch", "--merged", baseRef, "--format=%(refname:short)"]);
	const mergedBranches = new Set(
		merged.status === 0 ? merged.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [],
	);

	return { registeredShortIds, branches, mergedBranches, usable: true };
}

function recommend(entry: Omit<WorktreeEntry, "recommendation">): string {
	switch (entry.category) {
		case "live-open":
			return `keep — task ${entry.seq ? `seq:${entry.seq}` : entry.shortId} is ${entry.taskStatus ?? "open"}`;
		case "orphaned":
			if (entry.needsForce) return `orphan; branch ${entry.branch} NOT merged — needs --force-unmerged`;
			return "orphan, no task record — reclaim with --prune-orphans";
		case "abandoned-teardown":
			if (entry.needsForce) return `teardown never finished; branch ${entry.branch} NOT merged — needs --force-unmerged`;
			return "teardown never finished — finish it with --prune-orphans";
		case "metadata-only":
			if (entry.reclaimableBytes > 0) return `diffs/logs of a task last touched ${entry.ageDays}d ago — --prune-older-than 30d`;
			if (entry.taskStatus && !TERMINAL_STATUSES.has(entry.taskStatus)) return `keep — task ${entry.taskStatus}, no worktree`;
			return `keep for now — ${entry.ageBucket ?? "unknown"} (${entry.ageDays ?? "?"}d)`;
	}
}

/** Scan every project's worktree root and classify every task directory. */
export function collectWorktreeReport(deps: WorktreeScanDeps): WorktreeReport {
	const worktreesRoot = `${deps.dev3Home}/worktrees`;
	if (!deps.exists(worktreesRoot)) {
		return {
			projects: [],
			entries: [],
			totalBytes: 0,
			totalReclaimableBytes: 0,
			unmergedBytes: 0,
			worktreesRoot,
			rootMissing: true,
		};
	}

	const projects = readProjects(deps);
	const projectBySlug = new Map<string, RawProject>();
	for (const project of projects) projectBySlug.set(projectStorageKey(project.path), project);

	// A task directory is only orphaned when its id appears in NO project's
	// tasks.json — a task moved between projects keeps its old slug's directory.
	const tasksByShortId = new Map<string, RawTask>();
	const slugsWithData = new Set<string>([...projectBySlug.keys()]);
	for (const slug of slugsWithData) {
		for (const task of readTasks(deps, slug)) {
			if (typeof task.id === "string") tasksByShortId.set(task.id.slice(0, 8).toLowerCase(), task);
		}
	}

	let slugs: string[];
	try {
		slugs = deps.listDirs(worktreesRoot).sort();
	} catch {
		slugs = [];
	}

	// Enumerate first, measure once: one batched size pass beats a spawn per dir.
	const pending: Array<{ slug: string; shortId: string; dir: string; hasWorktree: boolean }> = [];
	for (const slug of slugs) {
		let shortIds: string[];
		try {
			shortIds = deps.listDirs(join(worktreesRoot, slug)).filter((name) => /^[0-9a-f]{8}$/i.test(name));
		} catch {
			continue;
		}
		for (const shortId of shortIds.sort()) {
			const dir = join(worktreesRoot, slug, shortId);
			pending.push({ slug, shortId, dir, hasWorktree: deps.exists(join(dir, "worktree")) });
		}
	}
	const measureTargets = pending.flatMap((p) => (p.hasWorktree ? [p.dir, join(p.dir, "worktree")] : [p.dir]));
	const sizes = measureTargets.length > 0 ? deps.dirSizes(measureTargets) : new Map<string, number>();

	const repoFactsBySlug = new Map<string, RepoFacts>();
	for (const slug of new Set(pending.map((p) => p.slug))) {
		repoFactsBySlug.set(slug, readRepoFacts(deps, projectBySlug.get(slug) ?? null));
	}

	const entries: WorktreeEntry[] = [];
	for (const item of pending) {
		const project = projectBySlug.get(item.slug) ?? null;
		const facts = repoFactsBySlug.get(item.slug)!;
		const task = tasksByShortId.get(item.shortId.toLowerCase()) ?? null;
		const branchName = `dev3/task-${item.shortId}`;
		const branch = facts.branches.has(branchName) ? branchName : null;
		const branchMerged = branch ? facts.mergedBranches.has(branch) : null;

		const activityMs = task ? lastActivityMs(task) : null;
		const fallbackMs = activityMs === null ? deps.mtimeMs(item.dir) : null;
		const effectiveMs = activityMs ?? fallbackMs;
		const ageDays = effectiveMs === null ? null : Math.floor((deps.now - effectiveMs) / DAY_MS);

		const category: WorktreeCategory = !item.hasWorktree
			? "metadata-only"
			: !task
				? "orphaned"
				: TERMINAL_STATUSES.has(task.status ?? "")
					? "abandoned-teardown"
					: "live-open";

		const bytes = sizes.get(item.dir) ?? 0;
		const worktreeBytes = item.hasWorktree ? (sizes.get(join(item.dir, "worktree")) ?? 0) : 0;
		const needsForce = (category === "orphaned" || category === "abandoned-teardown") && branch !== null && branchMerged === false;

		let reclaimableBytes = 0;
		if (category === "orphaned") reclaimableBytes = bytes;
		else if (category === "abandoned-teardown") reclaimableBytes = worktreeBytes;
		else if (category === "metadata-only") {
			const taskOpen = task ? !TERMINAL_STATUSES.has(task.status ?? "") : false;
			if (!taskOpen && bucketFor(ageDays) === "stale") reclaimableBytes = bytes;
		}

		const base: Omit<WorktreeEntry, "recommendation"> = {
			projectName: project?.name ?? null,
			projectPath: project?.path ?? null,
			slug: item.slug,
			shortId: item.shortId,
			dir: item.dir,
			category,
			seq: task?.seq === undefined || task.seq === null ? null : String(task.seq),
			taskStatus: task?.status ?? null,
			branch,
			branchMerged,
			registeredInGit: facts.usable ? facts.registeredShortIds.has(item.shortId.toLowerCase()) : null,
			bytes,
			worktreeBytes,
			lastActivity: effectiveMs === null ? null : new Date(effectiveMs).toISOString(),
			ageDays,
			ageBucket: bucketFor(ageDays),
			reclaimableBytes,
			needsForce,
		};
		entries.push({ ...base, recommendation: recommend(base) });
	}

	const bySlug = new Map<string, ProjectWorktreeTotals>();
	for (const entry of entries) {
		let totals = bySlug.get(entry.slug);
		if (!totals) {
			totals = {
				projectName: entry.projectName,
				slug: entry.slug,
				dirs: 0,
				bytes: 0,
				reclaimableBytes: 0,
				counts: { "live-open": 0, "abandoned-teardown": 0, orphaned: 0, "metadata-only": 0 },
			};
			bySlug.set(entry.slug, totals);
		}
		totals.dirs += 1;
		totals.bytes += entry.bytes;
		totals.reclaimableBytes += entry.reclaimableBytes;
		totals.counts[entry.category] += 1;
	}

	return {
		projects: [...bySlug.values()].sort((a, b) => b.reclaimableBytes - a.reclaimableBytes || b.bytes - a.bytes),
		entries: entries.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes || b.bytes - a.bytes),
		totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
		totalReclaimableBytes: entries.reduce((sum, e) => sum + e.reclaimableBytes, 0),
		unmergedBytes: entries.filter((e) => e.needsForce).reduce((sum, e) => sum + e.reclaimableBytes, 0),
		worktreesRoot,
		rootMissing: false,
	};
}

export function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${bytes} B`;
}

/** Fixed-width table from a header row plus body rows, left-aligned. */
function table(header: string[], body: string[][]): string[] {
	const widths = header.map((_, column) =>
		Math.max(header[column]!.length, ...body.map((cells) => cells[column]!.length)),
	);
	const line = (cells: string[]): string =>
		cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
	return [line(header), ...body.map(line)];
}

const TOP_ENTRIES = 15;
const TOP_PROJECTS = 12;
const LABEL_WIDTH = 34;

/**
 * A dead project's slug can be 60+ characters and would blow the table apart.
 * Those are truncated from the LEFT, because the tail of a slug is what tells two
 * abandoned slugs apart (the head is the same `Users-<name>-…` prefix every time).
 */
function projectLabel(project: ProjectWorktreeTotals): string {
	if (project.projectName) {
		return project.projectName.length <= LABEL_WIDTH
			? project.projectName
			: `${project.projectName.slice(0, LABEL_WIDTH - 1)}…`;
	}
	const slug = project.slug.length <= LABEL_WIDTH - 13 ? project.slug : `…${project.slug.slice(-(LABEL_WIDTH - 14))}`;
	return `(no project: ${slug})`;
}

export function renderWorktreeReport(report: WorktreeReport): string {
	if (report.rootMissing) return `No worktree root at ${report.worktreesRoot} — nothing on disk yet.\n`;
	if (report.entries.length === 0) return `No task directories under ${report.worktreesRoot}.\n`;

	const lines: string[] = [];
	const shownProjects = report.projects.slice(0, TOP_PROJECTS);
	lines.push(
		...table(
			["PROJECT", "DIRS", "ON DISK", "RECLAIMABLE", "OPEN", "ORPHANED", "ABANDONED", "META-ONLY"],
			shownProjects.map((p) => [
				projectLabel(p),
				String(p.dirs),
				formatBytes(p.bytes),
				formatBytes(p.reclaimableBytes),
				String(p.counts["live-open"]),
				String(p.counts.orphaned),
				String(p.counts["abandoned-teardown"]),
				String(p.counts["metadata-only"]),
			]),
		),
	);
	const restProjects = report.projects.slice(TOP_PROJECTS);
	if (restProjects.length > 0) {
		const restBytes = restProjects.reduce((sum, p) => sum + p.bytes, 0);
		const restReclaimable = restProjects.reduce((sum, p) => sum + p.reclaimableBytes, 0);
		lines.push(
			`… ${restProjects.length} more projects with less to reclaim: ${formatBytes(restBytes)} on disk, ${formatBytes(restReclaimable)} reclaimable (--json lists them).`,
		);
	}

	const reclaimable = report.entries.filter((e) => e.reclaimableBytes > 0);
	if (reclaimable.length > 0) {
		lines.push("");
		lines.push(`Largest reclaimable directories (${Math.min(TOP_ENTRIES, reclaimable.length)} of ${reclaimable.length}):`);
		lines.push(
			...table(
				["", "SIZE", "TASK DIR", "CATEGORY", "AGE", "WHY"],
				reclaimable.slice(0, TOP_ENTRIES).map((e) => [
					e.needsForce ? "!" : " ",
					formatBytes(e.reclaimableBytes),
					`${e.projectName ?? e.slug}/${e.shortId}`,
					e.category,
					e.ageDays === null ? "?" : `${e.ageDays}d`,
					e.recommendation,
				]),
			).map((l) => `  ${l}`),
		);
		if (reclaimable.length > TOP_ENTRIES) {
			lines.push(`  … ${reclaimable.length - TOP_ENTRIES} more not shown — use --json for the full list.`);
		}
	}

	lines.push("");
	lines.push(`${formatBytes(report.totalBytes)} on disk under ${report.worktreesRoot}.`);
	if (report.totalReclaimableBytes === 0) {
		lines.push("Nothing reclaimable — every directory belongs to an open task or is still recent.");
	} else {
		lines.push(`Reclaim ${formatBytes(report.totalReclaimableBytes)}: dev3 doctor --worktrees --prune-orphans`);
		if (report.unmergedBytes > 0) {
			lines.push(
				`  ${formatBytes(report.unmergedBytes)} of that sits on UNMERGED dev3/task-* branches (marked "!") and is skipped unless you add --force-unmerged.`,
			);
		}
		lines.push("  Old diffs/logs of finished tasks: dev3 doctor --worktrees --prune-older-than 30d");
	}
	return lines.join("\n") + "\n";
}

export type PruneAction = "removed-dir" | "removed-worktree" | "skipped" | "failed";

export interface PruneOutcome {
	dir: string;
	shortId: string;
	projectName: string | null;
	category: WorktreeCategory;
	action: PruneAction;
	/** Bytes actually freed (0 for skipped/failed). */
	freedBytes: number;
	branchDeleted: string | null;
	reason: string;
}

export interface PruneOptions {
	/** Reclaim orphaned directories and finish abandoned teardowns. */
	orphans: boolean;
	/** Delete metadata-only directories at least this old, in days. */
	olderThanDays: number | null;
	/** Also delete entries whose dev3/task-* branch is NOT merged into the base. */
	forceUnmerged: boolean;
}

/** `30d`, `2w`, `6m`, `1y`, or a bare number of days. Null when unparseable. */
export function parseDurationDays(raw: string): number | null {
	const match = raw.trim().match(/^(\d+)\s*([dwmy])?$/i);
	if (!match) return null;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return null;
	switch ((match[2] || "d").toLowerCase()) {
		case "w":
			return amount * 7;
		case "m":
			return amount * 30;
		case "y":
			return amount * 365;
		default:
			return amount;
	}
}

function deleteBranchIfSafe(deps: WorktreeScanDeps, entry: WorktreeEntry, options: PruneOptions): string | null {
	if (!entry.branch || !entry.projectPath) return null;
	if (entry.branchMerged !== true && !options.forceUnmerged) return null;
	const flag = entry.branchMerged === true ? "-d" : "-D";
	const res = deps.git(entry.projectPath, ["branch", flag, entry.branch]);
	return res.status === 0 ? entry.branch : null;
}

/**
 * Delete what the flags selected. Orphans lose the whole task directory (their
 * diffs/logs describe a task record that no longer exists); an abandoned teardown
 * loses only `worktree/`, because its task still exists and the UI still shows its
 * diffs — removing the worktree is exactly the teardown step that never ran.
 */
export function prune(report: WorktreeReport, options: PruneOptions, deps: WorktreeScanDeps): PruneOutcome[] {
	const outcomes: PruneOutcome[] = [];
	const touchedRepos = new Set<string>();

	for (const entry of report.entries) {
		const selected =
			(options.orphans && (entry.category === "orphaned" || entry.category === "abandoned-teardown")) ||
			(options.olderThanDays !== null &&
				entry.category === "metadata-only" &&
				entry.reclaimableBytes > 0 &&
				entry.ageDays !== null &&
				entry.ageDays >= options.olderThanDays);
		if (!selected) continue;

		const common = {
			dir: entry.dir,
			shortId: entry.shortId,
			projectName: entry.projectName,
			category: entry.category,
		};

		if (entry.needsForce && !options.forceUnmerged) {
			outcomes.push({
				...common,
				action: "skipped",
				freedBytes: 0,
				branchDeleted: null,
				reason: `branch ${entry.branch} is not merged into the base branch — re-run with --force-unmerged to delete it anyway`,
			});
			continue;
		}

		const removeWholeDir = entry.category !== "abandoned-teardown";
		const target = removeWholeDir ? entry.dir : join(entry.dir, "worktree");
		const freed = removeWholeDir ? entry.bytes : entry.worktreeBytes;

		// Let git detach its own registration first; a plain rm leaves a stale
		// entry in .git/worktrees that only `git worktree prune` clears.
		if (entry.projectPath && entry.registeredInGit) {
			deps.git(entry.projectPath, ["worktree", "remove", "--force", "--force", join(entry.dir, "worktree")]);
		}
		try {
			deps.remove(target);
		} catch (err) {
			outcomes.push({
				...common,
				action: "failed",
				freedBytes: 0,
				branchDeleted: null,
				reason: `could not delete ${target}: ${(err as Error).message}`,
			});
			continue;
		}
		if (entry.projectPath) touchedRepos.add(entry.projectPath);
		const branchDeleted = deleteBranchIfSafe(deps, entry, options);
		outcomes.push({
			...common,
			action: removeWholeDir ? "removed-dir" : "removed-worktree",
			freedBytes: freed,
			branchDeleted,
			reason: removeWholeDir ? "whole task directory removed" : "worktree removed, diffs/logs kept",
		});
	}
	// A plain rm leaves a stale entry in .git/worktrees; one prune per repo clears them.
	for (const repo of touchedRepos) deps.git(repo, ["worktree", "prune"]);
	return outcomes;
}

export function renderPruneOutcomes(outcomes: PruneOutcome[]): string {
	if (outcomes.length === 0) return "Nothing matched the prune flags — nothing was deleted.\n";
	const lines = table(
		["", "FREED", "TASK DIR", "ACTION", "DETAIL"],
		outcomes.map((o) => [
			o.action === "failed" ? "✗" : o.action === "skipped" ? "!" : "✓",
			o.freedBytes > 0 ? formatBytes(o.freedBytes) : "—",
			`${o.projectName ?? "?"}/${o.shortId}`,
			o.action,
			o.branchDeleted ? `${o.reason}; deleted branch ${o.branchDeleted}` : o.reason,
		]),
	);
	const freed = outcomes.reduce((sum, o) => sum + o.freedBytes, 0);
	const skipped = outcomes.filter((o) => o.action === "skipped").length;
	const failed = outcomes.filter((o) => o.action === "failed").length;
	lines.push("");
	lines.push(`Freed ${formatBytes(freed)}. ${skipped} skipped, ${failed} failed.`);
	return lines.join("\n") + "\n";
}
