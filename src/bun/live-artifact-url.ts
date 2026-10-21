import type { Project, Task } from "../shared/types";
import * as data from "./data";
import type { LiveAgentSender } from "./live-artifact-ops";
import { ensureLiveServer, findTokenOnDisk, liveTokenFor } from "./live-artifact-server";

/** Wiring between the live server and the app's data. No Electrobun import, so the CLI socket server can use it. */

// Loaded on first send: the scheduler pulls in the terminal stack, which a URL lookup never needs.
export const liveSendToAgent: LiveAgentSender = async (task, text) =>
	(await import("./scheduled-message-scheduler")).sendMessageImmediately(task, text, null, null, { hold: false });

async function allProjects(): Promise<Project[]> {
	return [...await data.loadProjects(), ...await data.loadVirtualProjects()];
}

/** The viewer may not know the project (a popup over another board), so look across all of them. */
export async function findLiveTask(taskId: string, projectId?: string): Promise<{ project: Project; task: Task }> {
	const projects = projectId ? [await data.getProject(projectId)] : await allProjects();
	for (const project of projects) {
		const task = (await data.loadTasks(project)).find((candidate) => candidate.id === taskId);
		if (task) return { project, task };
	}
	throw new Error("Could not find the task this live page belongs to.");
}

/** `http://127.0.0.1:<port>/<token>/` — starts the loopback server on first use. */
export function liveArtifactUrlFor(project: Project, task: Task): string {
	const port = ensureLiveServer({
		sendToAgent: liveSendToAgent,
		resolveToken: async (token) => {
			const entry = findTokenOnDisk(token, await allProjects());
			if (!entry) return null;
			try {
				return await findLiveTask(entry.taskId, entry.projectId);
			} catch {
				return null;
			}
		},
	});
	return `http://127.0.0.1:${port}/${liveTokenFor(project, task.id)}/`;
}
