import { projectStorageKey, toPosixSeparators } from "./project-storage-key";

/**
 * Where a project's dev3 state lives: its board data and its task dirs.
 *
 * By default both sit under `$DEV3_HOME` (`data/<key>/`, `worktrees/<key>/`). A
 * project with `storageRoot: "project"` keeps them inside its own folder under
 * `.dev3/`, so `~/.dev3.0` holds only app-global state. The bun process, the CLI
 * and conversation search all resolve through here — never compose these paths
 * inline. See `decisions/2026/11/04/per-project-storage-root.md`.
 */

/** Folder inside the project that holds its in-project dev3 state. */
export const IN_PROJECT_DIR = ".dev3";

export type StorageProject = {
	path: string;
	kind?: "git" | "virtual";
	storageRoot?: "project";
};

export type StorageTask = {
	id: string;
	taskDirLocation?: "project";
	worktreePath?: string | null;
};

function shortId(taskId: string): string {
	return taskId.slice(0, 8);
}

function projectFolder(projectPath: string): string {
	return toPosixSeparators(projectPath).replace(/\/+$/, "");
}

export function storesInProject(project: StorageProject): boolean {
	return project.kind !== "virtual" && project.storageRoot === "project";
}

/** `<project>/.dev3` — the root of everything a project stores in its own folder. */
export function inProjectRoot(projectPath: string): string {
	return `${projectFolder(projectPath)}/${IN_PROJECT_DIR}`;
}

/** The home-based data dir every project used before per-project storage existed. */
export function legacyProjectDataDir(dev3Home: string, projectPath: string): string {
	return `${dev3Home}/data/${projectStorageKey(projectPath)}`;
}

export function inProjectDataDir(projectPath: string): string {
	return `${inProjectRoot(projectPath)}/data`;
}

/** Board data: `tasks.json`, its backups, messages, task blobs, automations. */
export function projectDataDir(dev3Home: string, project: StorageProject): string {
	return storesInProject(project) ? inProjectDataDir(project.path) : legacyProjectDataDir(dev3Home, project.path);
}

export function projectTasksFile(dev3Home: string, project: StorageProject): string {
	return `${projectDataDir(dev3Home, project)}/tasks.json`;
}

/** Parent of a project's task dirs, for task dirs created in `location`. */
export function projectWorktreesRoot(dev3Home: string, projectPath: string, location?: "project"): string {
	return location === "project"
		? `${inProjectRoot(projectPath)}/worktrees`
		: `${dev3Home}/worktrees/${projectStorageKey(projectPath)}`;
}

/** Both roots a project's task dirs may sit under, whatever the current setting. */
export function allProjectWorktreesRoots(dev3Home: string, projectPath: string): string[] {
	return [projectWorktreesRoot(dev3Home, projectPath), projectWorktreesRoot(dev3Home, projectPath, "project")];
}

/**
 * A task's dir (`…/<shortId>`, parent of `worktree/` and `logs/`).
 *
 * Follows the location stamped on the task at creation, never the project's
 * current setting, so flipping the setting cannot orphan a running task. A stored
 * `worktreePath` under either root wins, because that is where git has it.
 */
export function taskDirFor(dev3Home: string, project: StorageProject, task: StorageTask): string {
	const id = shortId(task.id);
	const stored = task.worktreePath ? toPosixSeparators(task.worktreePath) : null;
	if (stored) {
		for (const root of allProjectWorktreesRoots(dev3Home, project.path)) {
			if (stored === `${root}/${id}/worktree`) return `${root}/${id}`;
		}
	}
	return `${projectWorktreesRoot(dev3Home, project.path, task.taskDirLocation)}/${id}`;
}

const IN_PROJECT_TASK_PATH_RE = /^(.+)\/\.dev3\/worktrees\/([0-9a-f]{8})(?:\/(.*))?$/i;

/**
 * Recognise a path inside an in-project task dir. `inWorktree` is true for the
 * worktree itself or anything below it; `logs/` and other task-dir siblings are not.
 */
export function parseInProjectTaskPath(
	rawPath: string,
): { projectPath: string; shortId: string; taskDir: string; inWorktree: boolean } | null {
	const path = toPosixSeparators(rawPath).replace(/\/+$/, "");
	const match = IN_PROJECT_TASK_PATH_RE.exec(path);
	if (!match) return null;
	const [, projectPath, id, rest = ""] = match;
	const inWorktree = rest === "worktree" || rest.startsWith("worktree/");
	return { projectPath, shortId: id.toLowerCase(), taskDir: `${projectPath}/${IN_PROJECT_DIR}/worktrees/${id}`, inWorktree };
}

/** True for any path at or below an in-project task dir. */
export function isInProjectTaskPath(path: string): boolean {
	return parseInProjectTaskPath(path) !== null;
}
