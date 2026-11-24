import { existsSync } from "node:fs";
import { libraryItemPrimaryPath, taskLibraryItems, type LibraryItem, type LibraryReport } from "../../shared/library";
import type { Task } from "../../shared/types";
import * as data from "../data";
import { log } from "./shared";

/**
 * Every artifact and shown media record across ALL projects and every task status,
 * projected into one list. Read-only: it never writes, moves or renames anything
 * under ~/.dev3.0 — it only checks whether each stored file still exists.
 */
export async function getLibrary(): Promise<LibraryReport> {
	const [gitProjects, virtualProjects] = await Promise.all([data.loadProjects(), data.loadVirtualProjects()]);
	const items: LibraryItem[] = [];
	for (const project of [...gitProjects, ...virtualProjects]) {
		let tasks: Task[];
		try {
			tasks = await data.loadTasks(project);
		} catch (err) {
			log.warn("getLibrary: loadTasks failed", { projectId: project.id, error: String(err) });
			continue;
		}
		for (const task of tasks) {
			for (const item of taskLibraryItems(project, task)) {
				const path = libraryItemPrimaryPath(item);
				items.push(path && !existsSync(path) ? { ...item, missing: true } : item);
			}
		}
	}
	return { items, generatedAt: new Date().toISOString() };
}

export const libraryHandlers = {
	getLibrary,
};
