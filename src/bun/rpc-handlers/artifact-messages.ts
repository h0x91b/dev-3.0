import { wrapArtifactMessage } from "../../shared/agent-message-envelope";
import * as data from "../data";
import { sendMessageImmediately } from "../scheduled-message-scheduler";
import { log } from "./shared";

/**
 * Deliver an artifact message — text a human submitted from a form inside an
 * HTML artifact — into that task's live agent pane.
 *
 * Never held (`hold: false`), the same call the diff viewer's "Send to agent"
 * makes: the user just clicked inside the report and is watching the pane, so a
 * message parked for a quiet window reads as a button that did nothing.
 *
 * The viewer knows only the task it is showing, so the project is found here.
 * A terminal-status task is refused by `sendMessageImmediately` itself.
 */
async function sendArtifactMessageToAgent(params: {
	taskId: string;
	text: string;
	artifactTitle: string;
	version: number;
	versionCount: number;
}): Promise<{ spilledPath: string | null }> {
	const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
	for (const project of projects) {
		const task = (await data.loadTasks(project)).find((candidate) => candidate.id === params.taskId);
		if (!task) continue;
		log.info("→ sendArtifactMessageToAgent", { taskId: task.id.slice(0, 8), version: params.version });
		const text = wrapArtifactMessage(params.text, {
			title: params.artifactTitle,
			version: params.version,
			versionCount: params.versionCount,
		});
		const { spilledPath } = await sendMessageImmediately(task, text, null, null, { hold: false });
		return { spilledPath };
	}
	throw new Error("Could not find the task this artifact belongs to.");
}

export const artifactMessageHandlers = {
	sendArtifactMessageToAgent,
};
