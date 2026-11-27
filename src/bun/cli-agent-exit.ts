import type { Project, Task } from "../shared/types";
import type { ApprovalReason } from "../shared/approval-reason";
import { MAIN_AGENT_EXIT_MESSAGE, type CliAgentExitOutcome } from "../shared/agent-exit";
import { LEGACY_AGENT_HANDLE_PREFIX, decodeAgentHandle } from "../shared/agent-handle";
import { agentPaneRoles } from "./agent-message-target";
import { resolveAgentExitTargets } from "./agent-graceful-exit";
import { askSessionApproval, perTaskJoiner, sameRunAfterApproval } from "./cli-session-approval";
import { extraAgentLabel, isExtraAgentExitScheduled, scheduleExtraAgentExit } from "./extra-agent-exit";
import { AGENT_IDENTITY_UNSUPPORTED_DETAIL, resolveScheduledMessageAuthorPane } from "./scheduled-message-author";
import { loadSettings } from "./settings";

export interface AgentExitOptions {
	project: Project;
	task: Task;
	/** The task whose agent asked; null for a person at a terminal, who acts directly. */
	requester: Task | null;
	/** The pane the CLI runs in, when its shell was told one. */
	selfPaneId: string | null;
	/** `--agent <handle>`: another agent of the task. */
	agentHandle: string | null;
	reason?: ApprovalReason;
}

const refused = (reason: "main-agent" | "not-extra", message: string): CliAgentExitOutcome => ({ outcome: "refused", reason, message });
const notExtra = (message: string) => refused("not-extra", `${message} dev3 agent exit only closes extra agents (started with dev3 agent spawn or "+ Agent").`);

/** The pane the command is about, or the refusal that says why there is none. */
async function targetPane(opts: AgentExitOptions): Promise<{ paneId: string } | CliAgentExitOutcome> {
	if (!opts.agentHandle) {
		if (opts.selfPaneId) return { paneId: opts.selfPaneId };
		return notExtra("This shell has no pane id, so it is not an agent pane.");
	}
	if (process.platform === "win32") return notExtra(`--agent: ${AGENT_IDENTITY_UNSUPPORTED_DETAIL}.`);
	if (opts.agentHandle.trim().startsWith(LEGACY_AGENT_HANDLE_PREFIX)) return notExtra("--agent: that handle was written by an older dev3.");
	const author = decodeAgentHandle(opts.agentHandle);
	if (!author) return notExtra("--agent: not an agent handle (copy one from `dev3 pane list`).");
	const resolved = await resolveScheduledMessageAuthorPane(opts.task, author);
	return resolved.ok ? { paneId: resolved.paneId } : notExtra(`--agent: ${resolved.detail}.`);
}

async function performExit(opts: AgentExitOptions): Promise<CliAgentExitOutcome> {
	const { project, task, requester } = opts;
	const pane = await targetPane(opts);
	if ("outcome" in pane) return pane;
	const { paneId } = pane;

	const role = (await agentPaneRoles(task)).get(paneId);
	if (role === "main") return refused("main-agent", MAIN_AGENT_EXIT_MESSAGE);
	if (role === "review") return notExtra(`Pane ${paneId} is the AI Review agent.`);
	if (role !== "agent") return notExtra(`Pane ${paneId} is not an agent pane.`);
	const target = (await resolveAgentExitTargets(task)).find((candidate) => candidate.paneId === paneId);
	if (!target) return notExtra(`The agent in pane ${paneId} is no longer running.`);

	const self = requester?.id === task.id && opts.selfPaneId === paneId;
	const agent = await extraAgentLabel(target.entry);
	const outcome = (already: boolean): CliAgentExitOutcome => ({ outcome: "scheduled", taskId: task.id, seq: task.seq, paneId, agent, self, already });
	// Before any dialog: a repeated call must not ask the user twice.
	if (isExtraAgentExitScheduled(task.id, paneId)) return outcome(true);

	if (requester && (await loadSettings()).confirmExtraAgentClose !== false) {
		const answer = await askSessionApproval({
			project, task, requester, reason: opts.reason,
			subject: { sessionAction: { kind: "close-agent", paneId, agentLabel: agent } },
			alreadyPending: "Another approval is pending for this task — answer it first.",
		});
		if (!answer.approved) return { outcome: "declined", taskId: task.id, seq: task.seq, ...(answer.stale ? { stale: true } : {}) };
		await sameRunAfterApproval(project, task, "The target task's run changed while waiting — nothing was done.");
	}
	return outcome(scheduleExtraAgentExit(task, paneId, { self }).already);
}

/** Retries join the whole operation, approval included: one answer schedules once. */
const joinOrRun = perTaskJoiner("Another session request is pending for this task — wait for its answer first.");

/** `dev3 agent exit`: schedule an extra agent's exit, asking the user first when the setting says so. */
export function exitCliAgent(opts: AgentExitOptions): Promise<CliAgentExitOutcome> {
	return joinOrRun(opts.task.id, `exit:${opts.requester?.id ?? ""}:${opts.agentHandle ?? opts.selfPaneId ?? ""}`, () => performExit(opts));
}
