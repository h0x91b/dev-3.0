import type { Project, Task } from "../../../shared/types";
import * as data from "../../data";
import { log } from "../shared-pure";

/** Find a task by ID across all projects (git AND virtual/Operations boards). */
export async function findTaskAcrossProjects(taskId: string): Promise<{ task: Task | null; project: Project | null }> {
	try {
		// Virtual boards live in a separate file — they MUST be scanned too, or an
		// active operation's PTY can never be restored (the task "isn't found").
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		for (const project of projects) {
			try {
				const task = await data.getTask(project, taskId);
				return { task, project };
			} catch {
				// task not in this project
			}
		}
	} catch (err) {
		log.error("Failed to load projects during task search", {
			taskId: taskId.slice(0, 8),
			error: String(err),
		});
	}
	return { task: null, project: null };
}

/**
 * Clear the hibernation flag as part of a successful wake. Waking is always an
 * explicit act performed inside the task, so this only ever runs from the two
 * buttons on the wake screen — never from merely opening the terminal.
 */
export async function wakeIfHibernated(project: Project, task: Task): Promise<void> {
	if (!task.hibernated) return;
	// Imported lazily: the lifecycle service pulls in the electrobun-heavy executor,
	// and this module must stay importable without it.
	const { dispatchLifecycleEvent } = await import("../../lifecycle/service");
	await dispatchLifecycleEvent(project.id, task.id, { type: "wakeRequested" }, { project, task });
}

/**
 * Tell the lifecycle machine a terminal is live again. Only ever corrects a
 * runtime the boot probe wrote as `idle` because the session died with the app —
 * without it a resumed task would keep rendering as disconnected forever.
 */
export async function markTerminalAttached(project: Project, task: Task): Promise<void> {
	try {
		// Lazily imported for the same reason as in `wakeIfHibernated`.
		const { dispatchLifecycleEvent } = await import("../../lifecycle/service");
		await dispatchLifecycleEvent(project.id, task.id, { type: "terminalAttached" }, { project, task });
	} catch (err) {
		log.warn("Failed to mark terminal attached (non-fatal)", {
			taskId: task.id.slice(0, 8),
			error: String(err),
		});
	}
}
