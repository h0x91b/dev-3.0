import { assertTaskWorkspacePresent } from "../../task-workspace-guard";
import type { AgentFamily } from "../../../shared/types";
import * as data from "../../data";
import * as git from "../../git";
import { folderWorkDir } from "../../task-folder";
import { taskSessionIds } from "../../task-sessions";
import * as pty from "../../pty-server";
import * as agents from "../../agents";
import { autoRoutingContext } from "../../account-router";
import * as portPool from "../../port-pool";
import * as repoConfig from "../../repo-config";
import { recordFavoriteUsages } from "../../settings";
import { assertLaunchAgentsInstalled } from "../../agent-launch-availability";
import { ensureArtifactTemplateEnv } from "../../artifact-template";
import { markAgentPane } from "../../agent-prompt";
import { dev3TaskTempPath } from "../../temp-paths";
import { type AgentPromptDelivery } from "../../../shared/agent-prompt-delivery";
import { handoffPrompt, prepareTaskHandoff, previewTaskHandoff } from "../../conversation-handoff";
import type { HandoffPreview, SpawnAgentResult } from "../../../shared/conversation-handoff-model";
import { splitTaskPane, AuxPaneUnavailableError, type AuxPaneHandle } from "../../task-aux-panes";
import { getPushMessage, AGENT_ENV_DEFAULTS, buildAgentEnv, buildCmdScript, generatedScriptLaunch, generatedScriptName, log, writeLaunchScript } from "../shared-pure";
import { applyAgentHooksToCommand, applyModelVersionNotice, ensureAgentTrust } from "./task-launch";

export async function spawnAgentInTask(params: {
	prompt?: string;
	taskId: string;
	projectId: string;
	agentId: string | null;
	configId: string | null;
	accountId?: string | null;
	/** Hand the new agent a retelling of this task's newest conversation. */
	handoff?: boolean;
}): Promise<SpawnAgentResult> {
	log.info("→ spawnAgentInTask", { taskId: params.taskId.slice(0, 8), agentId: params.agentId, configId: params.configId, handoff: params.handoff === true, promptChars: params.prompt?.length ?? 0 });

	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	if (!task.worktreePath) {
		throw new Error("Task has no worktree — cannot spawn agent");
	}
	assertTaskWorkspacePresent(project, task.worktreePath);
	await assertLaunchAgentsInstalled([{ agentId: params.agentId, configId: params.configId }]);

	// Written BEFORE the split on purpose: a conversation that cannot be retold
	// must fail with no pane opened, rather than leave a bare agent standing where
	// the user asked for a takeover.
	const handoff = params.handoff
		? await prepareTaskHandoff(task, {
			...(folderWorkDir(project, task) ? { containerDir: git.taskDir(project, task) } : {}),
			sessionIds: taskSessionIds(project, task, task.worktreePath),
		})
		: null;
	if (params.handoff && !handoff) {
		throw new Error("Nothing to hand over: no parseable agent transcript has been written for this task yet.");
	}

	// The pointer rides the new agent's own command line, the way a task's first
	// launch carries its description. It used to be typed into the pane afterwards
	// and held until the pane went quiet — but the hold is deferred by ANY human
	// keystroke in the task, and the user is invariably still typing in the pane he
	// spawned this from, so the pointer sat there until he pressed Enter (seq 1775).
	const ctx: agents.TemplateContext = {
		taskTitle: "",
		taskDescription: handoff ? handoffPrompt(handoff, params.prompt) : (params.prompt ?? ""),
		projectName: project.name,
		projectPath: project.path,
		worktreePath: task.worktreePath,
	};

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;
	let resolvedBaseCmd = "";
	let resolvedAgentFamily: AgentFamily | undefined;
	let resolvedLaunchModel: string | undefined;
	let launchedAgentId = params.agentId;
	let launchedConfigId = params.configId;

	// Pre-assign a session ID for Claude so we can recover this pane later
	const freshSessionId = crypto.randomUUID();
	// Per-launch account for THIS extra pane (independent of the main pane's).
	const projectEnv = await repoConfig.resolveProjectEnv(project, task.worktreePath, { foreignCode: task.foreignCode });
	const reservationKey = `${task.id}:spawn:${freshSessionId}`;
	const cmdOptions: agents.CommandOptions = {
		sessionId: freshSessionId,
		accountId: params.accountId,
		autoRouting: await autoRoutingContext(project, reservationKey, projectEnv),
	};
	let launchAccountId = params.accountId;

	if (params.agentId) {
		const resolved = await agents.resolveCommandForAgent(params.agentId, params.configId, ctx, cmdOptions);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		resolvedAgentFamily = resolved.agentFamily;
		resolvedLaunchModel = resolved.launchModel;
		if (resolved.resolvedAccountId !== undefined) launchAccountId = resolved.resolvedAccountId;
		launchedAgentId = resolved.agent?.id ?? params.agentId;
		launchedConfigId = resolved.config?.id ?? params.configId;
	} else {
		const resolved = await agents.resolveCommandForProject(
			project,
			task.title,
			// A takeover replaces the brief: the retelling already carries the original
			// request, so re-launching on the raw description would start the work twice.
			handoff || params.prompt !== undefined ? ctx.taskDescription : task.description,
			task.worktreePath,
			undefined,
			cmdOptions,
		);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		resolvedAgentFamily = resolved.agentFamily;
		resolvedLaunchModel = resolved.launchModel;
		if (resolved.resolvedAccountId !== undefined) launchAccountId = resolved.resolvedAccountId;
		launchedAgentId = resolved.agent?.id ?? null;
		launchedConfigId = resolved.config?.id ?? null;
	}

	// Register trust / re-patch the agent's config before spawning. The primary
	// task launch does this; without it a spawned Codex pane runs against a stale
	// config.toml and crashes on the legacy-profile check (see ensureAgentTrust).
	const env: Record<string, string> = {
		...AGENT_ENV_DEFAULTS,
		...projectEnv,
		...buildAgentEnv(extraEnv, task.id),
		...ensureArtifactTemplateEnv(project, task, task.worktreePath),
	};
	await ensureAgentTrust(task.worktreePath, project.path, resolvedBaseCmd, launchAccountId, task.foreignCode, resolvedAgentFamily, env);
	tmuxCmd = await applyAgentHooksToCommand(task.worktreePath, resolvedBaseCmd, tmuxCmd, {
		stopTarget: project.autoReviewEnabled ? "review-by-ai" : "review-by-user",
		family: resolvedAgentFamily,
	});
	tmuxCmd = await applyModelVersionNotice(task.id, tmuxCmd, {
		baseCmd: resolvedBaseCmd,
		family: resolvedAgentFamily,
		launchModel: resolvedLaunchModel,
	});

	const existingPorts = portPool.getPortAssignments(task.id);
	if (existingPorts.length > 0) {
		Object.assign(env, portPool.buildPortEnv(existingPorts));
	}

	const scriptPath = dev3TaskTempPath(task.id, generatedScriptName(`spawn-${Date.now()}`));
	await writeLaunchScript(scriptPath, buildCmdScript(tmuxCmd, env));

	const socket = pty.getSessionSocket(params.taskId);

	// One extra pane in the task's own terminal, on whichever backend it runs. The
	// tmux split is the same one this path always did (right half, no -l); the
	// native path opens a real coordinator pane and never touches tmux.
	//
	// The bare primitive, NOT an auxiliary purpose: "+ Agent" is the user asking for
	// one more agent beside whatever is already there, so several of these panes
	// coexist by design, while a purpose owns at most one pane and replaces it.
	let handle: AuxPaneHandle;
	try {
		handle = await splitTaskPane({
			task,
			placement: "right",
			size: "",
			cwd: task.worktreePath,
			env: { DEV3_TASK_ID: task.id, DEV3_WORKTREE_ROOT: task.worktreePath },
			socket,
			tmuxCommand: `bash "${scriptPath}"`,
			nativeLaunch: generatedScriptLaunch(scriptPath),
		});
	} catch (err) {
		log.error("spawnAgentInTask failed", { taskId: params.taskId.slice(0, 8), error: String(err) });
		throw new Error(
			err instanceof AuxPaneUnavailableError
				? "Failed to spawn agent: the task terminal is not running, so there is no pane to split — start the task first."
				: `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const newPaneId = handle.paneId || null;
	if (handle.backend === "tmux" && newPaneId) void markAgentPane(socket, newPaneId);

	// sessionState.panes is the tmux pane registry — recovery and `handlePaneExited`
	// reconcile it against live tmux panes. A native pane is owned by the coordinator
	// record instead, so writing it here would leave a phantom entry forever.
	const paneEntry = {
		paneId: newPaneId,
		agentCmd: resolvedBaseCmd,
		sessionId: agents.supportsPreAssignedSessionId(resolvedBaseCmd, resolvedAgentFamily) ? freshSessionId : null,
		agentId: launchedAgentId,
		configId: launchedConfigId,
		accountId: launchAccountId,
		agentFamily: resolvedAgentFamily,
	};
	const existingPanes = task.sessionState?.panes ?? [];
	try {
		const updated = await data.updateTask(project, task.id, {
			agentId: launchedAgentId,
			configId: launchedConfigId,
			...(handle.backend === "tmux" ? { sessionState: { panes: [...existingPanes, paneEntry] } } : {}),
		});
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		log.info("Recorded the spawned agent", {
			taskId: params.taskId.slice(0, 8),
			backend: handle.backend,
			paneCount: handle.backend === "tmux" ? existingPanes.length + 1 : existingPanes.length,
		});
	} catch (err) {
		log.error("Failed to append pane to sessionState (non-fatal)", { error: String(err) });
	}

	// Bump the favorite usage counter if this launched combo is starred (best-effort).
	void recordFavoriteUsages([{ agentId: launchedAgentId, configId: launchedConfigId }]);

	let handoffResult: SpawnAgentResult["handoff"] = null;
	if (handoff) {
		// Nothing is typed and nothing waits: the pointer went in as the launch
		// prompt above, so it is the agent's first turn the moment it boots. Typing
		// into the pane is what could not be timed — the launch cannot miss.
		const delivery: AgentPromptDelivery = { status: "delivered", reason: "launch-prompt" };
		handoffResult = { path: handoff.path, chars: handoff.chars, source: handoff.source, delivery };
		log.info("Handed the conversation to the spawned agent", {
			taskId: params.taskId.slice(0, 8),
			chars: handoff.chars,
			delivery: delivery.status,
		});
	}

	log.info("← spawnAgentInTask done", { taskId: params.taskId.slice(0, 8) });
	return { paneId: handle.paneId, backend: handle.backend, agentId: launchedAgentId, configId: launchedConfigId, handoff: handoffResult };
}

/**
 * What a handoff from this task would retell. Answered from the transcripts on
 * disk, so a task whose agent never wrote one gets a plain null and the picker
 * offers nothing rather than an option that would fail on click.
 */
export async function previewTaskHandoffHandler(params: { taskId: string; projectId: string }): Promise<HandoffPreview | null> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	try {
		return await previewTaskHandoff(task, { sessionIds: taskSessionIds(project, task, task.worktreePath) });
	} catch (error) {
		log.warn("previewTaskHandoff failed; offering no handoff", { taskId: params.taskId.slice(0, 8), error: String(error) });
		return null;
	}
}
