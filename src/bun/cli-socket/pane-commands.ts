import { assertTaskWorkspacePresent } from "../task-workspace-guard";
import { closePaneRun, paneRunListing, readPaneRun, startPaneRun } from "../task-pane-runs";
import { buildTaskLifecycleEnv } from "../rpc-handlers/shared-pure";
import type { Handler } from "./shared";
import { requirePaneTask } from "./task-resolution";
import { withAgentPanes } from "../agent-message-target";

export const paneHandlers: Record<string, Handler> = {

	/**
	 * `dev3 pane` — run one command in a neighbouring pane of the task's own
	 * terminal and read what it printed. Backend-neutral and platform-neutral by
	 * construction; the log a run writes is what makes the output readable on the
	 * native backend, where a screen read is `not-enabled` (decision 202).
	 */
	"pane.run": async (params) => {
		const { task, project } = await requirePaneTask(params);
		const cwd = task.worktreePath;
		if (!cwd) throw new Error(`task ${task.id.slice(0, 8)} has no worktree, so it has no pane to split`);
		assertTaskWorkspacePresent(project, cwd, task);
		return await startPaneRun({
			task,
			command: String(params.command ?? ""),
			// An older CLI sends "right" for "no flag" — that, like anything unknown, is auto.
			placement: params.placement === "below" ? "below" : "auto",
			selfPaneId: params.selfPaneId === undefined ? null : String(params.selfPaneId),
			label: params.label === undefined ? undefined : String(params.label),
			cwd,
			env: buildTaskLifecycleEnv(project, task, cwd),
		});
	},

	"pane.logs": async (params) => {
		const { task } = await requirePaneTask(params);
		return await readPaneRun(task, String(params.runId ?? ""), params.lines === undefined ? undefined : Number(params.lines));
	},

	"pane.list": async (params) => {
		const { task } = await requirePaneTask(params);
		return await withAgentPanes(task, await paneRunListing(task, params.selfPaneId === undefined ? null : String(params.selfPaneId)));
	},

	"pane.close": async (params) => {
		const { task } = await requirePaneTask(params);
		return await closePaneRun(task, String(params.runId ?? ""));
	},
};
