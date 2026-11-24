import { existsSync } from "node:fs";
import { applyLibraryPresence, taskLibraryItems, type LibraryItem, type LibraryReport } from "../../shared/library";
import type { Task } from "../../shared/types";
import * as data from "../data";
import { log } from "./shared";

/**
 * Every artifact and shown media record across ALL projects and every task status,
 * projected into one list. The handler writes nothing: it reads the boards and checks
 * whether each stored file still exists, so the sizes count only files that are there.
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
			// One malformed record skips its task, never the whole library.
			try {
				for (const item of taskLibraryItems(project, task)) items.push(applyLibraryPresence(item, existsSync));
			} catch (err) {
				log.warn("getLibrary: skipped a task with an unreadable output record", { projectId: project.id, taskId: task.id.slice(0, 8), error: String(err) });
			}
		}
	}
	return { items, generatedAt: new Date().toISOString() };
}

export const libraryHandlers = {
	getLibrary,
};
