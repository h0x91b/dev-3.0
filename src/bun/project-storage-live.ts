import { projectDataDir, type StorageProject } from "../shared/project-storage";
import { DEV3_HOME } from "./paths";

/**
 * The storage root each project switched to in this process. Callers often hold
 * a `Project` loaded before a switch; resolving through here sends their writes to
 * the board's new home instead of the stale copy left behind.
 */
const switchedRoots = new Map<string, "project" | undefined>();

export function recordStorageSwitch(projectId: string, storageRoot: "project" | undefined): void {
	switchedRoots.set(projectId, storageRoot);
}

/** `project` with its storage root as of now, whatever it was when the object was loaded. */
export function liveStorage<P extends StorageProject & { id: string }>(project: P): P {
	if (!switchedRoots.has(project.id)) return project;
	const storageRoot = switchedRoots.get(project.id);
	return storageRoot === project.storageRoot ? project : { ...project, storageRoot };
}

export function liveProjectDataDir(project: StorageProject & { id: string }): string {
	return projectDataDir(DEV3_HOME, liveStorage(project));
}

/** Test-only. */
export function _resetStorageSwitches(): void {
	switchedRoots.clear();
}
