import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { Project, Task, TaskHistoryChange, TaskHistoryEntry, TaskStatus, TipState } from "../shared/types";
import { getTaskOverview, getTaskTitle, isStatusGuardBlocked, titleFromDescription } from "../shared/types";
import { createLogger } from "./logger";
import { DEV3_HOME, OPS_DIR } from "./paths";
import { detectClonePaths } from "./cow-clone";
import { withFileLock } from "./file-lock";
import { projectSlug } from "./git";

const log = createLogger("data");

const PROJECTS_FILE = `${DEV3_HOME}/projects.json`;
// Virtual ("Operations") boards live in a SEPARATE file (rule-5 parallel-path
// pattern from AGENTS.md) so older app versions never read it and stay blind to
// the feature — `projects.json` remains 100% valid for them.
const VIRTUAL_PROJECTS_FILE = `${DEV3_HOME}/virtual-projects.json`;
const PROJECTS_BACKUP_RETENTION_DAYS = 7;
const PROJECTS_BACKUP_FILE_PATTERN = /^projects-\d{4}-\d{2}-\d{2}\.json\.bak$/;
const TASK_BACKUPS_DIR = "tasks-backups";
const TASK_BACKUP_RETENTION_HOURS = 72;
const TASK_BACKUP_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}Z\.json$/;
type ProjectUpdates = Partial<Pick<Project, "setupScript" | "setupScriptLaunchMode" | "devScript" | "cleanupScript" | "defaultBaseBranch" | "githubAuthHost" | "githubAuthLogin" | "clonePaths" | "labels" | "customColumns" | "columnOrder" | "autoReviewEnabled" | "peerReviewEnabled" | "sparseCheckoutEnabled" | "sparseCheckoutPaths" | "builtinColumnAgents" | "customStatusLabels">>;

export class DataFileReadError extends Error {
	override name = "DataFileReadError";

	constructor(
		message: string,
		public readonly filePath: string,
		public readonly operation: "projects" | "tasks",
		options?: { cause?: unknown },
	) {
		super(message, options);
	}
}

function tasksFile(project: Project): string {
	return `${DEV3_HOME}/data/${projectSlug(project.path)}/tasks.json`;
}

function tasksBackupDir(project: Project): string {
	return `${DEV3_HOME}/data/${projectSlug(project.path)}/${TASK_BACKUPS_DIR}`;
}

function tasksBackupFileName(now: Date = new Date()): string {
	return `${now.toISOString().slice(0, 13)}Z.json`;
}

function deriveTaskBaseBranch(project: Project, existingBranch?: string | null): string {
	const normalizedExistingBranch = existingBranch?.trim()
		.replace(/^refs\/remotes\//, "")
		.replace(/^origin\//, "");
	return normalizedExistingBranch || project.defaultBaseBranch;
}

async function ensureDir(filePath: string): Promise<void> {
	const dir = filePath.slice(0, filePath.lastIndexOf("/"));
	await mkdir(dir, { recursive: true });
}

/**
 * Crash-safe write: write `content` to a sibling temp file in the SAME
 * directory, then rename() it over `filePath`. rename() within one filesystem
 * is atomic on POSIX, so a crash/power-loss can only ever leave the temp file
 * truncated — never the live file. The temp name (`<file>.tmp-<pid>`) never
 * matches the exact filenames or backup patterns older versions read, so a
 * leftover is harmless; we still clean it up on failure. The final path and
 * byte content are identical to the old in-place writeFile, so older app
 * versions read/write these files unchanged.
 *
 * Exported for sibling data modules (automations-data.ts) — same guarantees.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
	const tmpPath = `${filePath}.tmp-${process.pid}`;
	try {
		await writeFile(tmpPath, content);
		await rename(tmpPath, filePath);
	} catch (err) {
		await unlink(tmpPath).catch(() => {});
		throw err;
	}
}

// ---- Read cache (mtime/size keyed) ----
//
// Background pollers re-read projects.json/tasks.json multiple times per second.
// Caching the parsed result and validating it with a cheap stat() avoids re-reading
// and re-parsing megabytes of JSON when the file hasn't changed. stat() is taken
// BEFORE readFile so a concurrent write can only over-invalidate, never serve stale.
// Cache hits return shallow copies; mutators bypass the cache and saves invalidate it,
// so callers of the public load APIs must treat results as read-only snapshots.

interface FileCacheEntry<T> {
	mtimeMs: number;
	size: number;
	value: T[];
}

const projectsCache = new Map<string, FileCacheEntry<Project>>();
const virtualProjectsCache = new Map<string, FileCacheEntry<Project>>();
const tasksCache = new Map<string, FileCacheEntry<Task>>();

async function cacheLookup<T>(
	cache: Map<string, FileCacheEntry<T>>,
	file: string,
): Promise<{ hit: T[] | null; stat: { mtimeMs: number; size: number } | null }> {
	let fileStat: { mtimeMs: number; size: number } | null = null;
	try {
		const st = await stat(file);
		fileStat = { mtimeMs: st.mtimeMs, size: st.size };
	} catch {
		return { hit: null, stat: null };
	}
	const entry = cache.get(file);
	if (entry && entry.mtimeMs === fileStat.mtimeMs && entry.size === fileStat.size) {
		return { hit: entry.value.map((item) => ({ ...item })), stat: fileStat };
	}
	return { hit: null, stat: fileStat };
}

/** Test-only: clear in-memory read caches. */
export function _resetDataCaches(): void {
	projectsCache.clear();
	virtualProjectsCache.clear();
	tasksCache.clear();
}

// ---- Projects (raw internal helpers — no locking) ----

function toDataFileReadError(
	filePath: string,
	operation: "projects" | "tasks",
	err: unknown,
): DataFileReadError {
	const reason = err instanceof Error ? err.message : String(err);
	return new DataFileReadError(
		`Failed to load ${operation} from ${filePath}: ${reason}`,
		filePath,
		operation,
		{ cause: err },
	);
}

async function rawLoadAllProjects(options?: { strict?: boolean; persistMigrations?: boolean }): Promise<Project[]> {
	// Mutators (strict/persistMigrations) always read fresh from disk.
	const useCache = !options?.strict && !options?.persistMigrations;
	let preReadStat: { mtimeMs: number; size: number } | null = null;
	if (useCache) {
		const { hit, stat: st } = await cacheLookup(projectsCache, PROJECTS_FILE);
		if (hit) return hit;
		preReadStat = st;
	}
	log.debug("Loading all projects", { file: PROJECTS_FILE });
	try {
		const projects = JSON.parse(await readFile(PROJECTS_FILE, "utf8")) as Project[];
		// Backfill labels for projects created before this field existed
		let needsSave = false;
		for (const project of projects) {
			if ((project as any).labels === undefined) {
				project.labels = [];
			}
			if ((project as any).customColumns === undefined) {
				project.customColumns = [];
			}
			// Migrate away from legacy `say` cleanup scripts (was the old default)
			if (project.cleanupScript && /^\s*say\s+/i.test(project.cleanupScript)) {
				project.cleanupScript = "";
				needsSave = true;
			}
			// Migrate legacy aiReview → builtinColumnAgents
			const legacy = (project as any).aiReview;
			if (legacy && !project.builtinColumnAgents) {
				if (legacy.enabled !== false) {
					project.builtinColumnAgents = {
						"review-by-ai": {
							agentId: legacy.agentId ?? "builtin-claude",
							configId: legacy.configId ?? "claude-bypass-sonnet",
							prompt: legacy.reviewPrompt ?? "",
						},
					};
				}
				delete (project as any).aiReview;
				needsSave = true;
			}
		}
		if (needsSave && options?.persistMigrations) {
			log.info("Migrated legacy 'say' cleanup scripts, saving projects");
			await rawSaveProjects(projects);
		}
		log.info(`Loaded ${projects.length} project(s) (including deleted)`);
		if (useCache && preReadStat) {
			projectsCache.set(PROJECTS_FILE, { ...preReadStat, value: projects.map((p) => ({ ...p })) });
		}
		return projects;
	} catch (err: any) {
		if (err.code === "ENOENT") {
			log.info("No projects file yet, returning empty list");
			return [];
		}
		log.error("Failed to load projects", { error: String(err) });
		if (options?.strict) {
			throw toDataFileReadError(PROJECTS_FILE, "projects", err);
		}
		return [];
	}
}

async function rawSaveProjects(projects: Project[]): Promise<void> {
	log.debug("Saving projects", { count: projects.length, file: PROJECTS_FILE });
	await ensureDir(PROJECTS_FILE);
	await backupProjectsDaily().catch((err) => {
		log.warn("Failed to write daily projects backup (non-fatal)", { err });
	});
	await atomicWriteFile(PROJECTS_FILE, JSON.stringify(projects, null, 2));
	projectsCache.delete(PROJECTS_FILE);
	log.info(`Saved ${projects.length} project(s)`);
}

/**
 * Snapshot projects.json to projects-YYYY-MM-DD.json.bak (once per day) and
 * prune snapshots beyond the retention window. Called before every save and
 * once at app startup. Writes new sibling files only — never moves or renames
 * anything under ~/.dev3.0/ (see on-disk layout invariants in AGENTS.md).
 */
export async function backupProjectsDaily(now: Date = new Date()): Promise<void> {
	let currentContent: string;
	try {
		currentContent = await readFile(PROJECTS_FILE, "utf8");
	} catch (err: any) {
		if (err.code === "ENOENT") return;
		throw err;
	}

	const backupFile = `${DEV3_HOME}/projects-${now.toISOString().slice(0, 10)}.json.bak`;
	try {
		await readFile(backupFile, "utf8");
	} catch (err: any) {
		if (err.code !== "ENOENT") throw err;
		await writeFile(backupFile, currentContent);
		log.info("Wrote daily projects backup", { file: backupFile });
	}

	const backupFiles = (await readdir(DEV3_HOME))
		.filter((entry) => PROJECTS_BACKUP_FILE_PATTERN.test(entry))
		.sort();
	for (const staleFile of backupFiles.slice(0, Math.max(0, backupFiles.length - PROJECTS_BACKUP_RETENTION_DAYS))) {
		await unlink(`${DEV3_HOME}/${staleFile}`);
	}
}

// ---- Projects (public API — all mutators use file lock) ----

/** Load active (non-deleted) projects. */
export async function loadProjects(): Promise<Project[]> {
	const all = await rawLoadAllProjects();
	return all.filter((p) => !p.deleted);
}

export async function saveProjects(projects: Project[]): Promise<void> {
	await withFileLock(PROJECTS_FILE, () => rawSaveProjects(projects));
}

// ---- Virtual ("Operations") projects ----
//
// Stored in a SEPARATE virtual-projects.json so older app versions never see
// them (forward-compat). Tasks are NOT special-cased: they live at
// data/<projectSlug(path)>/tasks.json exactly like git projects, so the entire
// task data layer (loadTasks/saveTasks) works unchanged.

async function rawLoadAllVirtualProjects(options?: { strict?: boolean }): Promise<Project[]> {
	const useCache = !options?.strict;
	let preReadStat: { mtimeMs: number; size: number } | null = null;
	if (useCache) {
		const { hit, stat: st } = await cacheLookup(virtualProjectsCache, VIRTUAL_PROJECTS_FILE);
		if (hit) return hit;
		preReadStat = st;
	}
	try {
		const projects = JSON.parse(await readFile(VIRTUAL_PROJECTS_FILE, "utf8")) as Project[];
		for (const project of projects) {
			project.kind = "virtual";
			if ((project as any).labels === undefined) project.labels = [];
			if ((project as any).customColumns === undefined) project.customColumns = [];
		}
		if (useCache && preReadStat) {
			virtualProjectsCache.set(VIRTUAL_PROJECTS_FILE, { ...preReadStat, value: projects.map((p) => ({ ...p })) });
		}
		return projects;
	} catch (err: any) {
		if (err.code === "ENOENT") return [];
		log.error("Failed to load virtual projects", { error: String(err) });
		if (options?.strict) throw toDataFileReadError(VIRTUAL_PROJECTS_FILE, "projects", err);
		return [];
	}
}

async function rawSaveVirtualProjects(projects: Project[]): Promise<void> {
	await ensureDir(VIRTUAL_PROJECTS_FILE);
	await atomicWriteFile(VIRTUAL_PROJECTS_FILE, JSON.stringify(projects, null, 2));
	virtualProjectsCache.delete(VIRTUAL_PROJECTS_FILE);
	log.info(`Saved ${projects.length} virtual project(s)`);
}

/** Load active (non-deleted) virtual projects. */
export async function loadVirtualProjects(): Promise<Project[]> {
	const all = await rawLoadAllVirtualProjects();
	return all.filter((p) => !p.deleted);
}

export async function saveVirtualProjects(projects: Project[]): Promise<void> {
	await withFileLock(VIRTUAL_PROJECTS_FILE, () => rawSaveVirtualProjects(projects));
}

/** Convert a board name to a filesystem-safe readable slug (`Mail triage` → `mail-triage`). */
function slugifyVirtualName(name: string): string {
	const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return s || "operations";
}

/**
 * Allocate a human-readable, globally-unique, never-reused slug for a virtual
 * project's synthetic path `${OPS_DIR}/<slug>`. Uniqueness is checked against:
 * git project data-dir names, existing virtual slugs, AND surviving data/ dir
 * names — so a deleted-then-recreated board cannot inherit stale task data.
 */
async function findUniqueVirtualProjectSlug(base: string): Promise<string> {
	const gitProjects = await rawLoadAllProjects({ strict: false });
	const gitDataDirs = new Set(gitProjects.map((p) => projectSlug(p.path)));
	const virtuals = await rawLoadAllVirtualProjects({ strict: false });
	const virtualSlugs = new Set(virtuals.map((p) => p.path.split("/").pop() || ""));
	let survivingDataDirs = new Set<string>();
	try {
		survivingDataDirs = new Set(await readdir(`${DEV3_HOME}/data`));
	} catch {
		// data/ may not exist yet — nothing survives
	}
	for (let suffix = 0; ; suffix++) {
		const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
		const dataDirName = projectSlug(`${OPS_DIR}/${candidate}`);
		if (!virtualSlugs.has(candidate) && !gitDataDirs.has(dataDirName) && !survivingDataDirs.has(dataDirName)) {
			return candidate;
		}
	}
}

async function createVirtualProjectUnlocked(projects: Project[], name: string, builtin: boolean): Promise<Project> {
	const slug = await findUniqueVirtualProjectSlug(slugifyVirtualName(name));
	const project: Project = {
		id: crypto.randomUUID(),
		name,
		path: `${OPS_DIR}/${slug}`,
		kind: "virtual",
		builtin: builtin || undefined,
		setupScript: "",
		setupScriptLaunchMode: "parallel",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "",
		createdAt: new Date().toISOString(),
		labels: [],
		customColumns: [],
	};
	projects.push(project);
	await rawSaveVirtualProjects(projects);
	log.info("Virtual project added", { id: project.id, name, slug, builtin });
	return project;
}

export async function addVirtualProject(name: string): Promise<Project> {
	return withFileLock(VIRTUAL_PROJECTS_FILE, async () => {
		const projects = await rawLoadAllVirtualProjects({ strict: true });
		return createVirtualProjectUnlocked(projects, name, false);
	});
}

/**
 * Idempotently ensure the single built-in "Operations" board exists. Additive,
 * invariant-safe: only ever creates a new file/entry, never renames or moves.
 */
export async function ensureBuiltinOperationsBoard(name: string): Promise<Project> {
	return withFileLock(VIRTUAL_PROJECTS_FILE, async () => {
		const projects = await rawLoadAllVirtualProjects({ strict: true });
		const existing = projects.find((p) => p.builtin && !p.deleted);
		if (existing) return existing;
		return createVirtualProjectUnlocked(projects, name, true);
	});
}

/** True when the given id belongs to a virtual project (lives in virtual-projects.json). */
async function isVirtualProjectId(projectId: string): Promise<boolean> {
	const virtuals = await rawLoadAllVirtualProjects();
	return virtuals.some((p) => p.id === projectId);
}

export async function reorderProjects(projectIds: string[]): Promise<Project[]> {
	return withFileLock(PROJECTS_FILE, async () => {
		log.info("Reordering projects", { projectIds });
		const projects = await rawLoadAllProjects({ strict: true, persistMigrations: true });
		const seen = new Set<string>();
		const orderedActive: Project[] = [];

		for (const projectId of projectIds) {
			if (seen.has(projectId)) continue;
			const project = projects.find((candidate) => candidate.id === projectId && !candidate.deleted);
			if (!project) continue;
			orderedActive.push(project);
			seen.add(project.id);
		}

		for (const project of projects) {
			if (!project.deleted && !seen.has(project.id)) {
				orderedActive.push(project);
				seen.add(project.id);
			}
		}

		const deleted = projects.filter((project) => project.deleted);
		const reordered = [...orderedActive, ...deleted];
		await rawSaveProjects(reordered);
		log.info("Projects reordered", { count: orderedActive.length });
		return orderedActive;
	});
}

export async function addProject(
	path: string,
	name: string,
): Promise<Project> {
	return withFileLock(PROJECTS_FILE, async () => {
		log.info("Adding project", { name, path });
		const projects = await rawLoadAllProjects({ strict: true, persistMigrations: true });
		const normalizedPath = path.replace(/\/+$/, "");

		const existingIdx = projects.findIndex(
			(p) => p.path.replace(/\/+$/, "") === normalizedPath,
		);

		if (existingIdx !== -1) {
			const existing = projects[existingIdx];
			if (existing.deleted) {
				log.info("Reactivating soft-deleted project", {
					id: existing.id,
					path,
				});
				projects[existingIdx] = { ...existing, deleted: undefined, name };
				await rawSaveProjects(projects);
				return projects[existingIdx];
			}
			log.info("Project already exists, returning existing", {
				id: existing.id,
				path,
			});
			return existing;
		}

		const autoClonePaths = await detectClonePaths(path);
		const project: Project = {
			id: crypto.randomUUID(),
			name,
			path,
			setupScript: "",
			setupScriptLaunchMode: "parallel",
			devScript: "",
			cleanupScript: "",
			defaultBaseBranch: "main",
			clonePaths: autoClonePaths,
			createdAt: new Date().toISOString(),
			labels: [],
		};
		projects.push(project);
		await rawSaveProjects(projects);
		log.info("Project added", { id: project.id, name });
		return project;
	});
}

export async function removeProject(projectId: string): Promise<void> {
	if (await isVirtualProjectId(projectId)) {
		return withFileLock(VIRTUAL_PROJECTS_FILE, async () => {
			log.info("Soft-deleting virtual project", { projectId });
			const projects = await rawLoadAllVirtualProjects({ strict: true });
			const idx = projects.findIndex((p) => p.id === projectId);
			if (idx === -1) {
				log.warn("Virtual project not found for soft-delete", { projectId });
				return;
			}
			// The built-in Operations board is a pinned system object. Deleting it
			// dead-ends ⌘0 (its lookup returns nothing) until the app restarts, and
			// because the slug dir survives, the next launch re-creates it under a
			// NEW slug/id — orphaning the old board's tasks. Refuse the deletion.
			if (projects[idx].builtin) {
				log.warn("Refusing to delete the built-in Operations board", { projectId });
				return;
			}
			projects[idx] = { ...projects[idx], deleted: true };
			await rawSaveVirtualProjects(projects);
		});
	}
	return withFileLock(PROJECTS_FILE, async () => {
		log.info("Soft-deleting project", { projectId });
		const projects = await rawLoadAllProjects({ strict: true, persistMigrations: true });
		const idx = projects.findIndex((p) => p.id === projectId);
		if (idx === -1) {
			log.warn("Project not found for soft-delete", { projectId });
			return;
		}
		projects[idx] = { ...projects[idx], deleted: true };
		await rawSaveProjects(projects);
	});
}

export async function updateProject(
	projectId: string,
	updates: ProjectUpdates,
): Promise<Project> {
	if (await isVirtualProjectId(projectId)) {
		return withFileLock(VIRTUAL_PROJECTS_FILE, async () => {
			log.info("Updating virtual project", { projectId, updates });
			const projects = await rawLoadAllVirtualProjects({ strict: true });
			const idx = projects.findIndex((p) => p.id === projectId);
			if (idx === -1) throw new Error(`Project not found: ${projectId}`);
			projects[idx] = { ...projects[idx], ...updates };
			await rawSaveVirtualProjects(projects);
			return projects[idx];
		});
	}
	return withFileLock(PROJECTS_FILE, async () => {
		log.info("Updating project", { projectId, updates });
		const projects = await rawLoadAllProjects({ strict: true, persistMigrations: true });
		const idx = projects.findIndex((p) => p.id === projectId);
		if (idx === -1) throw new Error(`Project not found: ${projectId}`);
		projects[idx] = { ...projects[idx], ...updates };
		await rawSaveProjects(projects);
		return projects[idx];
	});
}

export async function updateProjectWith<T>(
	projectId: string,
	mutator: (project: Project) => Promise<{ updates: ProjectUpdates; result: T }> | { updates: ProjectUpdates; result: T },
): Promise<{ project: Project; result: T }> {
	// Route virtual (Operations) projects to virtual-projects.json, exactly like
	// updateProject. Without this, labels and custom columns on the Operations
	// board throw "Project not found" (they go through this mutator helper).
	if (await isVirtualProjectId(projectId)) {
		return withFileLock(VIRTUAL_PROJECTS_FILE, async () => {
			log.info("Updating virtual project with mutator", { projectId });
			const projects = await rawLoadAllVirtualProjects({ strict: true });
			const idx = projects.findIndex((p) => p.id === projectId);
			if (idx === -1) throw new Error(`Project not found: ${projectId}`);
			const { updates, result } = await mutator(projects[idx]);
			projects[idx] = { ...projects[idx], ...updates };
			await rawSaveVirtualProjects(projects);
			return { project: projects[idx], result };
		});
	}
	return withFileLock(PROJECTS_FILE, async () => {
		log.info("Updating project with mutator", { projectId });
		const projects = await rawLoadAllProjects({ strict: true, persistMigrations: true });
		const idx = projects.findIndex((p) => p.id === projectId);
		if (idx === -1) throw new Error(`Project not found: ${projectId}`);
		const { updates, result } = await mutator(projects[idx]);
		projects[idx] = { ...projects[idx], ...updates };
		await rawSaveProjects(projects);
		return { project: projects[idx], result };
	});
}

export async function getProject(projectId: string): Promise<Project> {
	const projects = await rawLoadAllProjects();
	let project = projects.find((p) => p.id === projectId);
	if (!project) {
		const virtuals = await rawLoadAllVirtualProjects();
		project = virtuals.find((p) => p.id === projectId);
	}
	if (!project) throw new Error(`Project not found: ${projectId}`);
	return project;
}

// ---- Tasks (raw internal helpers — no locking) ----

function nextSeq(tasks: Task[]): number {
	if (tasks.length === 0) return 1;
	let max = 0;
	for (const t of tasks) {
		if (t.seq > max) max = t.seq;
	}
	return max + 1;
}

async function rawLoadTasks(project: Project, options?: { strict?: boolean; persistMigrations?: boolean }): Promise<Task[]> {
	const file = tasksFile(project);
	// Mutators (strict/persistMigrations) always read fresh from disk.
	const useCache = !options?.strict && !options?.persistMigrations;
	let preReadStat: { mtimeMs: number; size: number } | null = null;
	if (useCache) {
		const { hit, stat: st } = await cacheLookup(tasksCache, file);
		if (hit) return hit;
		preReadStat = st;
	}
	log.debug("Loading tasks", { projectId: project.id, file });
	try {
		const tasks = JSON.parse(await readFile(file, "utf8")) as Task[];
		// Backfill fields for tasks created before they existed
		for (const task of tasks) {
			if ((task as any).description === undefined) {
				task.description = task.title;
			}
			if ((task as any).groupId === undefined) task.groupId = null;
			if ((task as any).variantIndex === undefined) task.variantIndex = null;
			if ((task as any).agentId === undefined) task.agentId = null;
			if ((task as any).configId === undefined) task.configId = null;
			if ((task as any).labelIds === undefined) task.labelIds = [];
			if ((task as any).notes === undefined) task.notes = [];
			if ((task as any).customTitle === undefined) task.customTitle = null;
			if ((task as any).titleEditedByUser === undefined) task.titleEditedByUser = false;
			if ((task as any).customColumnId === undefined) task.customColumnId = null;
			if ((task as any).overview === undefined) task.overview = null;
			if ((task as any).userOverview === undefined) task.userOverview = null;
				if ((task as any).history === undefined) task.history = [];
		}

		// Backfill seq for tasks created before seq existed
		const needsSeq = tasks.some((t) => (t as any).seq === undefined);
		if (needsSeq) {
			const groupSeqMap = new Map<string, number>();
			for (const t of tasks) {
				if ((t as any).seq !== undefined && t.groupId) {
					groupSeqMap.set(t.groupId, t.seq);
				}
			}

			let current = nextSeq(tasks.filter((t) => (t as any).seq !== undefined));
			for (const t of tasks) {
				if ((t as any).seq !== undefined) continue;
				if (t.groupId && groupSeqMap.has(t.groupId)) {
					t.seq = groupSeqMap.get(t.groupId)!;
				} else {
					t.seq = current;
					if (t.groupId) groupSeqMap.set(t.groupId, current);
					current++;
				}
			}

			if (options?.persistMigrations) {
				log.info("Backfilled seq for tasks", { projectId: project.id });
				await rawSaveTasks(project, tasks);
			}
		}

		// Heal dangling customColumnId — the task references a custom column that
		// no longer exists in this project. Reachable via the deleteCustomColumn
		// snapshot race, or a multi-instance / CLI write that stamped a column id
		// this instance never had. Clearing it to null (the documented "no custom
		// column" value, already produced by the backfill above) is a content-only
		// in-place rewrite — same shape as the legacy `say` cleanup migration — that
		// keeps the file fully loadable by older app versions. We only persist on
		// mutator reads (persistMigrations), which run under the file lock and skip
		// the cache, so pure reads never transform cached values; the renderer falls
		// back defensively regardless. Guarded on a real customColumns array so a
		// partially-built project object can never wipe valid assignments.
		if (options?.persistMigrations && Array.isArray(project.customColumns)) {
			const validCustomColumnIds = new Set(project.customColumns.map((c) => c.id));
			let danglingCount = 0;
			for (const t of tasks) {
				if (t.customColumnId != null && !validCustomColumnIds.has(t.customColumnId)) {
					t.customColumnId = null;
					danglingCount++;
				}
			}
			if (danglingCount > 0) {
				log.info("Cleared dangling customColumnId on tasks", { projectId: project.id, count: danglingCount });
				await rawSaveTasks(project, tasks);
			}
		}

		log.info(`Loaded ${tasks.length} task(s)`, { projectId: project.id });
		if (useCache && preReadStat) {
			tasksCache.set(file, { ...preReadStat, value: tasks.map((t) => ({ ...t })) });
		}
		return tasks;
	} catch (err: any) {
		if (err.code === "ENOENT") {
			log.debug("No tasks file yet", { projectId: project.id });
			return [];
		}
		log.error("Failed to load tasks", { projectId: project.id, error: String(err) });
		if (options?.strict) {
			throw toDataFileReadError(file, "tasks", err);
		}
		return [];
	}
}

async function rawSaveTasks(
	project: Project,
	tasks: Task[],
): Promise<void> {
	const file = tasksFile(project);
	log.debug("Saving tasks", { projectId: project.id, count: tasks.length });
	await ensureDir(file);
	await writeHourlyTasksBackup(project, file).catch((err) => {
		log.warn("Failed to write hourly tasks backup (non-fatal)", { projectId: project.id, err });
	});
	await atomicWriteFile(file, JSON.stringify(tasks, null, 2));
	tasksCache.delete(file);
	log.info(`Saved ${tasks.length} task(s)`, { projectId: project.id });
}

async function writeHourlyTasksBackup(project: Project, filePath: string): Promise<void> {
	let currentContent: string;
	try {
		currentContent = await readFile(filePath, "utf8");
	} catch (err: any) {
		if (err.code === "ENOENT") {
			return;
		}
		throw err;
	}

	const backupDir = tasksBackupDir(project);
	const backupFile = `${backupDir}/${tasksBackupFileName()}`;

	await mkdir(backupDir, { recursive: true });

	try {
		await readFile(backupFile, "utf8");
	} catch (err: any) {
		if (err.code !== "ENOENT") {
			throw err;
		}
		await writeFile(backupFile, currentContent);
	}

	const backupFiles = (await readdir(backupDir))
		.filter((entry) => TASK_BACKUP_FILE_PATTERN.test(entry))
		.sort();

	for (const staleFile of backupFiles.slice(0, Math.max(0, backupFiles.length - TASK_BACKUP_RETENTION_HOURS))) {
		await unlink(`${backupDir}/${staleFile}`);
	}
}

// ---- Tasks (public API — all mutators use file lock) ----

export async function loadTasks(project: Project): Promise<Task[]> {
	return rawLoadTasks(project);
}

export async function saveTasks(
	project: Project,
	tasks: Task[],
): Promise<void> {
	const file = tasksFile(project);
	await withFileLock(file, () => rawSaveTasks(project, tasks));
}

export async function addTask(
	project: Project,
	description: string,
	status: TaskStatus = "todo",
	extras?: {
		groupId?: string;
		variantIndex?: number;
		/**
		 * When true (and `groupId` is set), assign the next free variantIndex for
		 * the group by scanning the freshly-loaded task list INSIDE the file lock,
		 * instead of trusting a caller-precomputed `variantIndex`. This makes
		 * concurrent "add attempts" calls on one group race-safe: each addTask
		 * re-reads under the lock and increments atomically, so two callers can
		 * never hand out the same index. Ignored without a groupId.
		 */
		autoVariantIndex?: boolean;
		agentId?: string | null;
		configId?: string | null;
		seq?: number;
		existingBranch?: string;
		preparing?: boolean;
		preparingStage?: Task["preparingStage"];
		preparingProgress?: Task["preparingProgress"];
		preparingStartedAt?: Task["preparingStartedAt"];
		watched?: boolean;
		scratch?: boolean;
		customTitle?: string | null;
		titleEditedByUser?: boolean;
		labelIds?: string[];
		opsWorkDir?: string | null;
		notes?: Task["notes"];
		overview?: string | null;
		userOverview?: string | null;
		automationId?: string | null;
	},
): Promise<Task> {
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		const title = titleFromDescription(description);
		log.info("Creating task", { projectId: project.id, title, status });
		const tasks = await rawLoadTasks(project, { strict: true, persistMigrations: true });
		const now = new Date().toISOString();
		// Race-safe variant index allocation — see `autoVariantIndex` above. The
		// scan runs against the under-lock snapshot, so it reflects any variants a
		// concurrent addTask already persisted for this group.
		let variantIndex = extras?.variantIndex ?? null;
		if (extras?.autoVariantIndex && extras.groupId) {
			let maxVariantIndex = 0;
			for (const t of tasks) {
				if (t.groupId === extras.groupId && typeof t.variantIndex === "number" && t.variantIndex > maxVariantIndex) {
					maxVariantIndex = t.variantIndex;
				}
			}
			variantIndex = maxVariantIndex + 1;
		}
		const task: Task = {
			id: crypto.randomUUID(),
			seq: extras?.seq ?? nextSeq(tasks),
			projectId: project.id,
			title,
			description,
			status,
			baseBranch: deriveTaskBaseBranch(project, extras?.existingBranch),
			worktreePath: null,
			branchName: null,
			groupId: extras?.groupId ?? null,
			variantIndex,
			agentId: extras?.agentId ?? null,
			configId: extras?.configId ?? null,
			createdAt: now,
			updatedAt: now,
			...(status === "in-progress" ? { lifecycleStartedAt: now } : {}),
			statusEnteredAt: now,
			tmuxSocket: "dev3",
			labelIds: extras?.labelIds ?? [],
			...(extras?.existingBranch ? { existingBranch: extras.existingBranch } : {}),
			...(extras?.preparing ? { preparing: true } : {}),
			...(extras?.preparingStage ? { preparingStage: extras.preparingStage } : {}),
			...(typeof extras?.preparingProgress === "number" ? { preparingProgress: extras.preparingProgress } : {}),
			...(extras?.preparingStartedAt ? { preparingStartedAt: extras.preparingStartedAt } : {}),
			...(extras?.watched ? { watched: true } : {}),
			...(extras?.scratch ? { scratch: true } : {}),
			...(extras?.customTitle ? { customTitle: extras.customTitle } : {}),
			...(extras?.titleEditedByUser ? { titleEditedByUser: true } : {}),
			...(extras?.opsWorkDir ? { opsWorkDir: extras.opsWorkDir } : {}),
			...(extras?.notes && extras.notes.length > 0 ? { notes: extras.notes } : {}),
			...(extras?.overview ? { overview: extras.overview } : {}),
			...(extras?.userOverview ? { userOverview: extras.userOverview } : {}),
			...(extras?.automationId ? { automationId: extras.automationId } : {}),
		};
		task.history = [{ at: now, title: getTaskTitle(task), overview: getTaskOverview(task), changed: "created" }];
		tasks.push(task);
		await rawSaveTasks(project, tasks);

		// Verify the write actually landed before reporting success. atomicWriteFile
		// can report success while the new content never reaches disk — e.g. macOS
		// Full Disk Access / sandbox loss mid-write, or another running app instance
		// clobbering the file. Without this guard the CLI prints "Created task <id>"
		// (consuming a seq) for a task that is never queryable, which an agent then
		// trusts. Re-read fresh from disk (strict bypasses the cache) and fail loudly
		// instead of returning a ghost task. See decision 082.
		const persisted = await rawLoadTasks(project, { strict: true });
		if (!persisted.some((t) => t.id === task.id)) {
			log.error("Task create verification failed — write did not persist", { taskId: task.id, seq: task.seq });
			throw new Error(
				`Task ${task.id} failed to persist (verification read-back did not find it). ` +
				`The write reported success but the task is not on disk — likely macOS Full Disk Access loss ` +
				`or another running app instance clobbering ${tasksFile(project)}.`,
			);
		}

		log.info("Task created", { taskId: task.id, seq: task.seq, title });
		return task;
	});
}

export async function updateTask(
	project: Project,
	taskId: string,
	updates: Partial<Task>,
	options?: {
		dropPosition?: "top" | "bottom";
		ifStatus?: string;
		ifStatusNot?: string;
	},
): Promise<Task> {
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		log.info("Updating task", { taskId, updates });
		const tasks = await rawLoadTasks(project, { strict: true, persistMigrations: true });
		const idx = tasks.findIndex((t) => t.id === taskId);
		if (idx === -1) throw new Error(`Task not found: ${taskId}`);
		const updatedTask = applyTaskUpdate(tasks, idx, updates, options);
		await rawSaveTasks(project, tasks);
		return updatedTask;
	});
}

export async function updateTaskWith<T>(
	project: Project,
	taskId: string,
	mutator: (task: Task) => Promise<{ updates: Partial<Task>; result: T }> | { updates: Partial<Task>; result: T },
	options?: {
		dropPosition?: "top" | "bottom";
		ifStatus?: string;
		ifStatusNot?: string;
	},
): Promise<{ task: Task; result: T }> {
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		log.info("Updating task with mutator", { projectId: project.id, taskId });
		const tasks = await rawLoadTasks(project, { strict: true, persistMigrations: true });
		const idx = tasks.findIndex((t) => t.id === taskId);
		if (idx === -1) throw new Error(`Task not found: ${taskId}`);
		const { updates, result } = await mutator(tasks[idx]);
		const task = applyTaskUpdate(tasks, idx, updates, options);
		await rawSaveTasks(project, tasks);
		return { task, result };
	});
}

export async function deleteTask(
	project: Project,
	taskId: string,
): Promise<void> {
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		log.info("Deleting task", { taskId, projectId: project.id });
		const tasks = await rawLoadTasks(project, { strict: true, persistMigrations: true });
		const filtered = tasks.filter((t) => t.id !== taskId);
		await rawSaveTasks(project, filtered);
	});
}

export async function getTask(
	project: Project,
	taskId: string,
): Promise<Task> {
	const tasks = await rawLoadTasks(project);
	const task = tasks.find((t) => t.id === taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);
	return task;
}

function applyTaskUpdate(
	tasks: Task[],
	idx: number,
	updates: Partial<Task>,
	options?: {
		dropPosition?: "top" | "bottom";
		ifStatus?: string;
		ifStatusNot?: string;
	},
): Task {
	const currentTask = tasks[idx];
	// Authoritative guard check (runs inside the file lock).
	if (isStatusGuardBlocked(currentTask.status, options)) {
		return currentTask;
	}
	const now = new Date().toISOString();
	// A move to a different RENDERED column happens either when the builtin status
	// changes, or when only customColumnId changes (builtin <-> custom column that
	// share the same status). Both must reset columnOrder, refresh movedAt and honor
	// dropPosition — otherwise a stale columnOrder pins the card mid-column on reload.
	const statusChanged = updates.status !== undefined && updates.status !== currentTask.status;
	const customColumnChanged =
		updates.customColumnId !== undefined && (updates.customColumnId ?? null) !== (currentTask.customColumnId ?? null);
	const renderedColumnChanged = statusChanged || customColumnChanged;
	const prevTitle = getTaskTitle(currentTask);
	const prevOverview = getTaskOverview(currentTask);

	const lifecycleStartedAt =
		statusChanged &&
		updates.status === "in-progress" &&
		(currentTask.status === "completed" || currentTask.status === "cancelled" || !currentTask.lifecycleStartedAt)
			? now
			: undefined;
	const updatesWithLifecycle = lifecycleStartedAt ? { ...updates, lifecycleStartedAt } : updates;

	// When the builtin status changes, finalize the wall-clock spent in the status
	// being left (credited to `statusDurations`) and stamp `statusEnteredAt` for the
	// new one. Custom-column-only moves keep the same status, so they don't finalize
	// a bucket — hence this is gated on `statusChanged`, not `renderedColumnChanged`.
	// See {@link Task.statusDurations} / the Productivity "Time invested" split.
	const statusTimePatch: Partial<Task> = statusChanged ? accumulateStatusDuration(currentTask, now) : {};

	if (renderedColumnChanged) {
		const dropPosition = options?.dropPosition;

		tasks[idx] = { ...tasks[idx], ...updatesWithLifecycle, ...statusTimePatch, movedAt: now, columnOrder: undefined, updatedAt: now };

		if (dropPosition) {
			const newStatus = tasks[idx].status;
			const targetCustomColumnId = tasks[idx].customColumnId ?? null;
			const columnTasks = tasks
				.filter((t) => t.status === newStatus && (t.customColumnId ?? null) === targetCustomColumnId && t.id !== tasks[idx].id)
				.sort((a, b) => {
					if (a.columnOrder !== undefined && b.columnOrder !== undefined) {
						return a.columnOrder - b.columnOrder;
					}
					if (a.columnOrder !== undefined) return -1;
					if (b.columnOrder !== undefined) return 1;
					return a.createdAt < b.createdAt ? -1 : 1;
				});

			if (dropPosition === "top") {
				columnTasks.unshift(tasks[idx]);
			} else {
				columnTasks.push(tasks[idx]);
			}

			for (let i = 0; i < columnTasks.length; i++) {
				columnTasks[i].columnOrder = i;
			}
		}
	} else {
		tasks[idx] = { ...tasks[idx], ...updatesWithLifecycle, updatedAt: now };
	}

	recordTitleOverviewHistory(tasks, idx, prevTitle, prevOverview, now);

	return tasks[idx];
}

/**
 * Append a snapshot to the task's history when its effective (displayed) title
 * or overview changed. Each entry captures both values so it stands alone. No
 * entry is written when neither changed (e.g. status-only moves).
 */
function recordTitleOverviewHistory(
	tasks: Task[],
	idx: number,
	prevTitle: string,
	prevOverview: string | null,
	now: string,
): void {
	const nextTitle = getTaskTitle(tasks[idx]);
	const nextOverview = getTaskOverview(tasks[idx]);
	const titleChanged = nextTitle !== prevTitle;
	const overviewChanged = nextOverview !== prevOverview;
	if (!titleChanged && !overviewChanged) return;
	const changed: TaskHistoryChange = titleChanged && overviewChanged ? "both" : titleChanged ? "title" : "overview";
	const entry: TaskHistoryEntry = { at: now, title: nextTitle, overview: nextOverview, changed };
	tasks[idx] = { ...tasks[idx], history: [...(tasks[idx].history ?? []), entry] };
}

/**
 * Compute the {@link Task.statusDurations} + {@link Task.statusEnteredAt} patch for a
 * status transition: credit the wall-clock spent in the status being left, then
 * stamp the entry time of the new status. The reference for "when did we enter the
 * leaving status" is `statusEnteredAt`, falling back to `movedAt`/`createdAt` for
 * tasks that predate this tracking so their first tracked stint is a best-effort
 * estimate rather than zero.
 */
function accumulateStatusDuration(currentTask: Task, nowIso: string): Partial<Task> {
	const enteredIso = currentTask.statusEnteredAt ?? currentTask.movedAt ?? currentTask.createdAt;
	const delta = Date.parse(nowIso) - Date.parse(enteredIso);
	const durations: Partial<Record<TaskStatus, number>> = { ...(currentTask.statusDurations ?? {}) };
	if (Number.isFinite(delta) && delta > 0) {
		durations[currentTask.status] = (durations[currentTask.status] ?? 0) + delta;
	}
	return { statusDurations: durations, statusEnteredAt: nowIso };
}

/**
 * Add real UI attention time (ms) to a task's {@link Task.focusMs}, in place under
 * the file lock. Deliberately minimal — it does NOT touch `updatedAt`, `movedAt`,
 * or the title/overview history, so the focus tracker's periodic flushes don't spam
 * board re-sorts or history entries. No-op for non-positive deltas or unknown ids.
 */
export async function addTaskFocusMs(project: Project, taskId: string, ms: number): Promise<void> {
	if (!(ms > 0)) return;
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		const tasks = await rawLoadTasks(project, { strict: true, persistMigrations: true });
		const idx = tasks.findIndex((t) => t.id === taskId);
		if (idx === -1) return;
		tasks[idx] = { ...tasks[idx], focusMs: (tasks[idx].focusMs ?? 0) + Math.round(ms) };
		await rawSaveTasks(project, tasks);
	});
}

function isInSameRenderedColumn(task: Task, status: string, customColumnId: string | null | undefined): boolean {
	return task.status === status && (task.customColumnId ?? null) === (customColumnId ?? null);
}

// ---- Preferences ----

const PREFERENCES_FILE = `${DEV3_HOME}/preferences.json`;

interface Preferences {
	lastPickedFolder?: string;
}

async function rawLoadPreferences(): Promise<Preferences> {
	try {
		return JSON.parse(await readFile(PREFERENCES_FILE, "utf8")) as Preferences;
	} catch (err: any) {
		if (err.code === "ENOENT") return {};
		return {};
	}
}

async function rawSavePreferences(prefs: Preferences): Promise<void> {
	await ensureDir(PREFERENCES_FILE);
	await writeFile(PREFERENCES_FILE, JSON.stringify(prefs, null, 2));
}

export async function getLastPickedFolder(): Promise<string | undefined> {
	const prefs = await rawLoadPreferences();
	return prefs.lastPickedFolder;
}

export async function setLastPickedFolder(folder: string): Promise<void> {
	return withFileLock(PREFERENCES_FILE, async () => {
		const prefs = await rawLoadPreferences();
		prefs.lastPickedFolder = folder;
		await rawSavePreferences(prefs);
	});
}

/**
 * Reorder a task (or its variant group) within its current status column.
 * Assigns sequential columnOrder (0, 1, 2, ...) to all tasks in the column.
 * Returns the updated column tasks.
 */
export async function reorderTasksInColumn(
	project: Project,
	taskId: string,
	targetIndex: number,
): Promise<Task[]> {
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		log.info("Reordering task in column", { taskId, targetIndex, projectId: project.id });
		const tasks = await rawLoadTasks(project, { strict: true, persistMigrations: true });
		const task = tasks.find((t) => t.id === taskId);
		if (!task) throw new Error(`Task not found: ${taskId}`);

		const columnStatus = task.status;
		const columnCustomColumnId = task.customColumnId ?? null;

		const columnTasks = tasks
			.filter((t) => isInSameRenderedColumn(t, columnStatus, columnCustomColumnId))
			.sort((a, b) => {
				if (a.columnOrder !== undefined && b.columnOrder !== undefined) {
					return a.columnOrder - b.columnOrder;
				}
				if (a.columnOrder !== undefined) return -1;
				if (b.columnOrder !== undefined) return 1;
				return a.createdAt < b.createdAt ? -1 : 1;
			});

		const movingIds = new Set<string>();
		if (task.groupId) {
			for (const t of columnTasks) {
				if (t.groupId === task.groupId) movingIds.add(t.id);
			}
		} else {
			movingIds.add(taskId);
		}

		const movingItems = columnTasks.filter((t) => movingIds.has(t.id));
		const remaining = columnTasks.filter((t) => !movingIds.has(t.id));

		const clampedIndex = Math.max(0, Math.min(targetIndex, remaining.length));
		remaining.splice(clampedIndex, 0, ...movingItems);

		const now = new Date().toISOString();
		const updatedColumnTasks: Task[] = [];
		for (let i = 0; i < remaining.length; i++) {
			const t = remaining[i];
			t.columnOrder = i;
			t.updatedAt = now;
			updatedColumnTasks.push(t);
		}

		await rawSaveTasks(project, tasks);
		log.info("Task reordered", { taskId, targetIndex: clampedIndex, columnTaskCount: updatedColumnTasks.length });
		return updatedColumnTasks;
	});
}

// ---- Tip State ----

const TIP_STATE_FILE = `${DEV3_HOME}/tip-state.json`;

const DEFAULT_TIP_STATE: TipState = {
	snoozedUntil: 0,
	seen: {},
	rotationIndex: 0,
};

async function rawLoadTipState(): Promise<TipState> {
	try {
		const file = Bun.file(TIP_STATE_FILE);
		if (!(await file.exists())) return { ...DEFAULT_TIP_STATE };
		const data = await file.json();
		return { ...DEFAULT_TIP_STATE, ...data };
	} catch {
		return { ...DEFAULT_TIP_STATE };
	}
}

async function rawSaveTipState(state: TipState): Promise<void> {
	await ensureDir(TIP_STATE_FILE);
	await Bun.write(TIP_STATE_FILE, JSON.stringify(state, null, 2));
}

export async function loadTipState(): Promise<TipState> {
	return rawLoadTipState();
}

export async function saveTipState(patch: Partial<TipState>): Promise<TipState> {
	return withFileLock(TIP_STATE_FILE, async () => {
		const current = await rawLoadTipState();
		const updated = { ...current, ...patch };
		if (patch.seen) {
			updated.seen = { ...current.seen, ...patch.seen };
		}
		await rawSaveTipState(updated);
		return updated;
	});
}

export async function resetTipState(): Promise<TipState> {
	return withFileLock(TIP_STATE_FILE, async () => {
		const fresh = { ...DEFAULT_TIP_STATE };
		await rawSaveTipState(fresh);
		return fresh;
	});
}

// ---- Last Route (persisted across every app restart: quit, reboot, update) ----
//
// The renderer persists the current route here (debounced on navigation) so the
// app reopens on the surface the user last had open, mirroring the window
// position restore. Unlike a one-shot update handoff, this file is NOT cleared
// on read — it always reflects the last known route until the next navigation
// overwrites it.

const LAST_ROUTE_FILE = `${DEV3_HOME}/last-route.json`;

export async function saveLastRoute(route: string): Promise<void> {
	await ensureDir(LAST_ROUTE_FILE);
	await writeFile(LAST_ROUTE_FILE, route, "utf-8");
}

export async function loadLastRoute(): Promise<string | null> {
	try {
		const data = await readFile(LAST_ROUTE_FILE, "utf-8");
		return data || null;
	} catch {
		// Missing/unreadable file — no route to restore.
		return null;
	}
}
