import type { AgentLaunchRequest, LaunchVariant, Project, Task } from "../shared/types";
import { ACTIVE_STATUSES, agentLaunchAutoApproveMs, buildTaskDialogSubject, DEFAULT_PRIORITY, getTaskTitle } from "../shared/types";
import type { SpawnAgentResult } from "../shared/conversation-handoff-model";
import { createAgentRequest, setAgentRequestLaunchChoice, setAgentLaunchDialog } from "./agent-requests";
import { listAgentAccounts } from "./agent-accounts";
import { getAllAgents } from "./agents";
import { getTask } from "./data";
import { loadSettings } from "./settings";
import { getPushMessage } from "./rpc-handlers/shared-pure";
import { settingsConfigHandlers } from "./rpc-handlers/settings-config";
import { tmuxPtyHandlers } from "./rpc-handlers/tmux-pty";
import { agentKey } from "../shared/agent-adapters/families";

interface SpawnOptions {
	project: Project;
	task: Task;
	requester: Task | null;
	choice: LaunchVariant;
	prompt?: string;
	handoff: boolean;
}

type SpawnOutcome = { approved: false; stale?: boolean } | { approved: true; spawn: SpawnAgentResult };
const pendingSpawns = new Map<string, { signature: string; result: Promise<SpawnOutcome> }>();

async function validateChoice(choice: LaunchVariant): Promise<LaunchVariant> {
	const settings = await loadSettings();
	const all = await getAllAgents();
	const id = choice.agentId ?? settings.defaultAgentId;
	const agent = all.find((a) => a.id === id);
	if (!agent) throw new Error(`Unknown agent "${id}" — see dev3 agent list.`);
	const globalConfigId = !choice.agentId && agent.configurations.some((c) => c.id === settings.defaultConfigId) ? settings.defaultConfigId : undefined;
	const configId = choice.configId ?? globalConfigId ?? agent.defaultConfigId ?? agent.configurations[0]?.id ?? null;
	if (configId && !agent.configurations.some((c) => c.id === configId)) throw new Error(`Unknown config "${configId}" for agent "${id}".`);
	if (choice.accountId !== undefined) {
		const family = agentKey(agent.baseCommand, agent.agentFamily);
		if (family !== "claude" && family !== "codex") throw new Error(`Agent "${id}" does not support managed accounts.`);
		if (choice.accountId !== null && !(await listAgentAccounts())[family].accounts.some((a) => a.id === choice.accountId)) throw new Error(`Unknown ${family} account "${choice.accountId}".`);
	}
	const availability = await settingsConfigHandlers.checkAgentAvailability();
	const check = availability.find((a) => a.agentId === id);
	if (!check?.installed) throw new Error(`Agent "${id}" is not installed.${check?.installCommand ? ` Install it with: ${check.installCommand}` : ""}`);
	return { ...choice, agentId: id, configId };
}

function assertRunning(task: Task): void {
	if (!task.worktreePath || task.hibernated || task.draft || !ACTIVE_STATUSES.includes(task.status)) throw new Error("The target task must have a running terminal and worktree — start or wake it first.");
}

async function performSpawn(opts: SpawnOptions): Promise<SpawnOutcome> {
	const { project, task, requester, prompt, handoff } = opts;
	assertRunning(task);
	let choice = await validateChoice(opts.choice);
	if (requester) {
		const push = getPushMessage();
		if (!push) throw new Error("No app window is connected — cannot ask the user for approval");
		const { requestId, decision, autoApproveAt } = createAgentRequest("launch", task.id, project.id, {
			autoApproveAfterMs: agentLaunchAutoApproveMs(await loadSettings()),
		});
		setAgentRequestLaunchChoice(requestId, { variants: [choice] });
		const request: AgentLaunchRequest = {
			requestId, taskId: task.id, projectId: project.id, taskTitle: getTaskTitle(task), targetStatus: task.status,
			scratch: false, requesterSeq: requester.seq, requesterTitle: getTaskTitle(requester),
			subject: buildTaskDialogSubject(task, project), defaultPriority: task.priority ?? DEFAULT_PRIORITY,
			canAddVariants: false, autoApproveAt, spawn: { choice, prompt, handoff },
		};
		setAgentLaunchDialog(request);
		push("agentLaunchRequested", request);
		const answer = await decision;
		if (!answer.approved) return { approved: false, ...(answer.stale ? { stale: true } : {}) };
		if (answer.launch) {
			if (answer.launch.variants.length !== 1) throw new Error("Adding an agent requires exactly one agent choice.");
			choice = await validateChoice(answer.launch.variants[0]);
		}
	}
	const current = await getTask(project, task.id);
	assertRunning(current);
	if (current.worktreePath !== task.worktreePath || current.lifecycleStartedAt !== task.lifecycleStartedAt) throw new Error("The target task's run changed while waiting — no agent was started.");
	const spawn = await tmuxPtyHandlers.spawnAgentInTask({ taskId: task.id, projectId: project.id, ...choice, prompt, handoff });
	return { approved: true, spawn };
}

/** Retries join the whole operation, not just approval: one answer opens one pane. */
export async function spawnCliAgent(opts: SpawnOptions): Promise<SpawnOutcome> {
	const signature = JSON.stringify({ choice: opts.choice, prompt: opts.prompt, handoff: opts.handoff, requester: opts.requester?.id });
	const existing = pendingSpawns.get(opts.task.id);
	if (existing) {
		if (existing.signature !== signature) throw new Error("Another agent spawn is pending for this task — wait for its answer first.");
		return existing.result;
	}
	const result = performSpawn(opts);
	pendingSpawns.set(opts.task.id, { signature, result });
	try { return await result; } finally { pendingSpawns.delete(opts.task.id); }
}
