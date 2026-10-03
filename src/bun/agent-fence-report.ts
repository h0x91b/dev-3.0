/**
 * Tell the user that an app closed an agent fence LATE — the wrapper could not close its own.
 * Informational only: it changes no delivery verdict. While the fence stayed open, anything
 * dev3 typed was accepted by tmux and reported delivered, yet reached only the raced-input
 * file the pane names. See `decisions/2026/09/28/agent-delivery-fence.md`.
 */

import type { AgentFenceCloseRequest } from "./agent-fence";
import * as data from "./data";
import { createLogger } from "./logger";

const log = createLogger("agent-fence");

export const AGENT_FENCE_LATE_CLOSE_REASON =
	"This task's agent exited and dev3 could not close its input fence at once, so no shell was started until now. " +
	"Anything sent to the agent in between was reported as delivered but only reached the file named in the pane.";

export async function reportLateAgentFenceClose(request: AgentFenceCloseRequest): Promise<void> {
	log.warn("agent fence closed late: sends in the meantime were reported delivered but reached only the raced-input file", {
		launchId: request.launchId,
		pane: request.paneId,
		taskId: request.taskId?.slice(0, 8) ?? "unknown",
		exitCode: String(request.exitCode),
	});
	if (!request.taskId) return;
	for (const project of [...(await data.loadProjects()), ...(await data.loadVirtualProjects())]) {
		const task = (await data.loadTasks(project).catch(() => [])).find((t) => t.id === request.taskId);
		if (!task) continue;
		const { pushCliAttention } = await import("./rpc-handlers/shared");
		pushCliAttention({ taskId: task.id, projectId: project.id, reason: AGENT_FENCE_LATE_CLOSE_REASON });
		return;
	}
}

/** Start the sweeper once the tmux binary is committed: never sweep through a PATH tmux. */
export async function startAgentFenceAfterBinary(binary: string | undefined): Promise<void> {
	if (!binary) return;
	const fence = await import("./agent-fence");
	fence.onAgentFenceLateClose((request) => {
		void reportLateAgentFenceClose(request).catch((err) => log.warn("late-close report failed", { error: String(err) }));
	});
	await fence.startAgentFenceSweeper();
}
