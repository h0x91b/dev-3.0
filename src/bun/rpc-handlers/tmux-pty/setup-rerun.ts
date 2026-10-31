import { assertTaskWorkspacePresent } from "../../task-workspace-guard";
import type { Project, Task } from "../../../shared/types";
import * as data from "../../data";
import * as portPool from "../../port-pool";
import { getUserShell } from "../../shell-env";
import { DEFAULT_TMUX_SOCKET } from "../../tmux";
import { clearSetupExitCode, dev3TaskTempPath, setupExitCodePath } from "../../temp-paths";
import { stopSetupFailureWatch, watchSetupFailure } from "../../setup-failure-watch";
import { taskTerminalBackendIdentity } from "../../task-terminal-backend";
import { auxPaneTitle, openAuxPane } from "../../task-aux-panes";
import { getPushMessage, buildSetupRerunScript, buildScriptRunnerCommand, buildTaskLifecycleEnv, generatedScriptLaunch, log, writeLaunchScript } from "../shared-pure";
import { launchDialect } from "../../../shared/platform-launch";
import { resolveOperationalProjectConfig } from "../settings-config";
import * as repoConfig from "../../repo-config";
import { findTaskAcrossProjects } from "./task-state";

/** Forget a setup verdict and tell every viewer, so the notice cannot come back. */
async function clearSetupFailure(project: Project, task: Task): Promise<void> {
	stopSetupFailureWatch(task.id);
	clearSetupExitCode(task.id);
	const updated = await data.updateTask(project, task.id, { setupFailedExitCode: null, setupFailedAgentRunning: null });
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
}

export async function dismissSetupFailure(params: { taskId: string }): Promise<void> {
	log.info("→ dismissSetupFailure", { taskId: params.taskId.slice(0, 8) });
	const { task, project } = await findTaskAcrossProjects(params.taskId);
	if (!task || !project) throw new Error(`Cannot dismiss: task ${params.taskId} not found`);
	await clearSetupFailure(project, task);
}

export async function dismissCloneFailures(params: { taskId: string }): Promise<void> {
	log.info("→ dismissCloneFailures", { taskId: params.taskId.slice(0, 8) });
	const { task, project } = await findTaskAcrossProjects(params.taskId);
	if (!task || !project) throw new Error(`Cannot dismiss: task ${params.taskId} not found`);
	const updated = await data.updateTask(project, task.id, { cloneFailures: null });
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
}

export async function rerunSetupScript(params: { taskId: string }): Promise<void> {
	log.info("→ rerunSetupScript", { taskId: params.taskId.slice(0, 8) });
	const { task, project } = await findTaskAcrossProjects(params.taskId);
	if (!task || !project) throw new Error(`Cannot re-run setup: task ${params.taskId} not found`);
	if (!task.worktreePath) throw new Error("Task has no worktree");
	assertTaskWorkspacePresent(project, task.worktreePath);

	const resolved = await resolveOperationalProjectConfig(project, task.worktreePath, { foreignCode: task.foreignCode });
	if (!resolved.setupScript.trim()) throw new Error("No setup script configured");

	const prefix = dev3TaskTempPath(task.id);
	const ext = launchDialect().scriptExtension;
	const setupPath = `${prefix}-setup${ext}`;
	const rerunPath = `${prefix}-setup-rerun${ext}`;
	await writeLaunchScript(setupPath, resolved.setupScript + "\n");

	// Clear BEFORE the pane opens: the click is the answer to the old verdict, and
	// the fresh watch below is what brings the notice back if this run fails too.
	await clearSetupFailure(project, task);

	const shellPath = getUserShell();
	await writeLaunchScript(rerunPath, buildSetupRerunScript({ setupPath, shellPath, setupExitPath: setupExitCodePath(task.id) }));

	// Project env with the global agent defaults, as on launch, where the setup
	// script runs inside the agent session's env.
	const env = {
		...(await repoConfig.resolveProjectEnv(project, task.worktreePath, { foreignCode: task.foreignCode })),
		...buildTaskLifecycleEnv(project, task, task.worktreePath),
	};
	const ports = portPool.getPortAssignments(task.id);
	if (ports.length > 0) Object.assign(env, portPool.buildPortEnv(ports));

	// A re-run starts no agent, so the answer is the same one the launch computed —
	// and it must be recomputed rather than read back from the task, which a
	// dismissal may already have cleared.
	const agentRunning = taskTerminalBackendIdentity(task) !== "native"
		&& (resolved.setupScriptLaunchMode ?? "parallel") === "parallel";
	watchSetupFailure(task.id, async (exitCode) => {
		const updated = await data.updateTask(project, task.id, {
			setupFailedExitCode: exitCode,
			setupFailedAgentRunning: agentRunning,
		});
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	});

	const handle = await openAuxPane({
		task,
		purpose: "setupRerun",
		placement: "below",
		size: "35%",
		cwd: task.worktreePath,
		env,
		socket: task.tmuxSocket ?? DEFAULT_TMUX_SOCKET,
		title: auxPaneTitle("setupRerun"),
		tmuxCommand: buildScriptRunnerCommand(rerunPath, { shellPath }),
		nativeLaunch: generatedScriptLaunch(rerunPath),
	});
	log.info("← rerunSetupScript done", { taskId: params.taskId.slice(0, 8), paneId: handle.paneId });
}
