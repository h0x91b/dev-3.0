import { copyFile, mkdir, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { inProjectDataDir, legacyProjectDataDir } from "../shared/project-storage";

async function copyFileAtomic(source: string, target: string): Promise<void> {
	const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
	try {
		await copyFile(source, tmp);
		await rename(tmp, target);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

/** Where a switch keeps the destination files it replaced, under the destination data dir. */
export const STORAGE_SWITCH_BACKUPS_DIR = "storage-switch-backups";

async function sameContent(a: string, b: string): Promise<boolean> {
	const [left, right] = await Promise.all([readFile(a), readFile(b)]);
	return left.equals(right);
}

/**
 * Copy `from` into `to` file by file; the source is authoritative and never touched.
 * A destination file that differs is first saved under `backupDir`, so edits made on
 * the inactive side (an older app version) are kept, never silently dropped.
 */
export async function copyDataTree(from: string, to: string, backupDir: string = join(to, STORAGE_SWITCH_BACKUPS_DIR, String(Date.now()))): Promise<number> {
	let entries;
	try {
		entries = await readdir(from, { withFileTypes: true });
	} catch (err: any) {
		if (err?.code === "ENOENT") return 0;
		throw err;
	}
	await mkdir(to, { recursive: true });
	let copied = 0;
	for (const entry of entries) {
		const source = join(from, entry.name);
		const target = join(to, entry.name);
		// `*.lock` dirs are `withFileLock` locks, the switch's own included: a copy would be a stale lock.
		if (entry.isDirectory() && (entry.name.endsWith(".lock") || entry.name === STORAGE_SWITCH_BACKUPS_DIR)) continue;
		if (entry.isDirectory()) {
			copied += await copyDataTree(source, target, join(backupDir, entry.name));
		} else if (entry.isFile() && !entry.name.includes(".tmp-")) {
			const existing = await stat(target).catch(() => null);
			if (existing?.isFile()) {
				if (await sameContent(source, target)) continue;
				await mkdir(backupDir, { recursive: true });
				await copyFile(target, join(backupDir, entry.name));
			}
			await copyFileAtomic(source, target);
			copied++;
		}
	}
	return copied;
}

/**
 * Re-stamp the tasks that own no task dir yet (todo, no worktree) so they follow
 * the new setting; started tasks keep the location their dir was created in.
 */
export async function restampUnstartedTasks(tasksFile: string, location: "project" | undefined): Promise<number> {
	let raw: string;
	try {
		raw = await readFile(tasksFile, "utf8");
	} catch (err: any) {
		if (err?.code === "ENOENT") return 0;
		throw err;
	}
	const tasks = JSON.parse(raw);
	if (!Array.isArray(tasks)) return 0;
	let changed = 0;
	for (const task of tasks) {
		if (task.status !== "todo" || task.worktreePath || task.taskDirLocation === location) continue;
		if (location) task.taskDirLocation = location;
		else delete task.taskDirLocation;
		changed++;
	}
	if (changed > 0) await atomicWriteFile(tasksFile, JSON.stringify(tasks));
	return changed;
}

/** Copy the home board data into `<project>/.dev3/data` (the dirs and ignore files come from `ensureInProjectStorageDirs`). */
export async function copyHomeDataIntoProject(dev3Home: string, projectPath: string): Promise<number> {
	const copied = await copyDataTree(legacyProjectDataDir(dev3Home, projectPath), inProjectDataDir(projectPath));
	await restampUnstartedTasks(`${inProjectDataDir(projectPath)}/tasks.json`, "project");
	return copied;
}

/** Copy the in-project board data back under `~/.dev3.0`. The in-project copy stays on disk. */
export async function copyProjectDataToHome(dev3Home: string, projectPath: string): Promise<number> {
	const target = legacyProjectDataDir(dev3Home, projectPath);
	await mkdir(dirname(target), { recursive: true });
	const copied = await copyDataTree(inProjectDataDir(projectPath), target);
	await restampUnstartedTasks(`${target}/tasks.json`, undefined);
	return copied;
}
