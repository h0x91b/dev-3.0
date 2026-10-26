import { requireMessageSubject } from "../../shared/agent-message-subject";
import { cancelScheduledMessageByRef, scheduleMessage as scheduleMessageCore, sendMessageImmediately } from "../scheduled-message-scheduler";
import {
	AGENT_IDENTITY_UNSUPPORTED_DETAIL,
	captureScheduledMessageAuthor,
	resolveScheduledMessageAuthorPane,
} from "../scheduled-message-author";
import { requireExternalSender } from "../external-senders";
import { toScheduledMessageListing } from "../../shared/scheduled-message-listing";
import { parseAgentHandle } from "../../shared/agent-handle";
import type { AgentMessageSource, ScheduledMessageAuthor, Task } from "../../shared/types";
import { resolveAgentHandle } from "../agent-message-target";
import { type Handler, withSenderVariant } from "./shared";
import { messageVariantIndex, resolveAgentMessageSource, resolveTaskFromParams, withSenderAgent } from "./task-resolution";

/**
 * The agent `--agent <handle>` names, or null when the message is task-addressed.
 * Refused outright, with nothing sent, when the handle is malformed, no longer
 * names the agent in its pane, or this platform cannot verify an agent: an
 * explicit address never degrades to the task.
 */
async function addressedAgent(params: Record<string, unknown>, task: Task): Promise<ScheduledMessageAuthor | null> {
	if (params.agentHandle === undefined || params.agentHandle === null) return null;
	if (process.platform === "win32") throw new Error(`--agent: ${AGENT_IDENTITY_UNSUPPORTED_DETAIL}. Nothing was sent.`);
	const handle = typeof params.agentHandle === "string" ? parseAgentHandle(params.agentHandle) : null;
	if (!handle) throw new Error("--agent: not an agent handle. Copy one from `dev3 pane list --task <id>`. Nothing was sent.");
	const resolved = await resolveAgentHandle(task, handle);
	if (!resolved.ok) throw new Error(`--agent: ${resolved.detail}. Nothing was sent.`);
	return resolved.author;
}

/** The sender, stamped with its agent, plus why replies cannot reach that agent when they cannot. */
async function stampedSource(params: Record<string, unknown>, targetTaskId: string): Promise<AgentMessageSource | null> {
	const source = await resolveAgentMessageSource(params, targetTaskId);
	return source ? withSenderAgent(source, params) : null;
}

function replyNotice(source: AgentMessageSource | null): { replyUnavailable?: string } {
	return source && !source.agent && source.agentUnavailable ? { replyUnavailable: source.agentUnavailable } : {};
}

export const messageHandlers: Record<string, Handler> = {
	// `dev3 message "text"` (no time flag): deliver a message into the task's live
	// agent immediately. Throws only when nothing was sent; an unconfirmed send
	// travels back as its own status so the CLI reports it as neither.
	...withSenderVariant("message.send", async (params) => {
		const { project, task } = await resolveTaskFromParams(params, { variantIndex: messageVariantIndex(params) });
		const text = ((params.text as string) ?? "").toString();
		// The app's half of the subject gate. The CLI checks it first and reports it
		// better, so reaching this means an older `dev3` binary that never learned
		// the flag — it gets the same explanation instead of writing a mute row.
		const subject = requireMessageSubject(params.subject, text);
		// `--as-sender`: a registered outside agent. The CLI refuses it inside a task,
		// so a request carrying both is not one this handler should guess about. It
		// always lands on the main agent: `--agent` addresses are for agents inside dev3.
		const externalSender = params.asSender === undefined ? null : requireExternalSender(params.asSender);
		if (externalSender && params.sourceTaskId) throw new Error("--as-sender cannot be used from inside a task worktree.");
		if (externalSender && params.agentHandle != null) throw new Error("--as-sender cannot be combined with --agent: a sender's message goes to the task's main agent.");
		const author = await addressedAgent(params, task);
		const source = externalSender ? null : await stampedSource(params, task.id);
		const delivery = await sendMessageImmediately(task, text, null, source, { subject, author, externalSender });
		return {
			delivered: true,
			status: delivery.status,
			messageId: delivery.messageId,
			...(delivery.detail === undefined ? {} : { detail: delivery.detail }),
			...(delivery.paneId ? { paneId: delivery.paneId } : {}),
			...(delivery.agentRole ? { agentRole: delivery.agentRole } : {}),
			...replyNotice(source),
			taskId: task.id,
			projectId: project.id,
		};
	}),

	// `dev3 message --in <dur> | --at <hh:mm> "text"`: queue a scheduled message on
	// the task's live agent (validation + cap live in the scheduler core).
	"message.schedule": async (params) => {
		const { project, task } = await resolveTaskFromParams(params, { variantIndex: messageVariantIndex(params) });
		const text = ((params.text as string) ?? "").toString();
		const at = (params.at as string) ?? "";
		// Same gate as the immediate send: a delay changes nothing about the subject.
		const subject = requireMessageSubject(params.subject, text);
		if (params.asSender !== undefined) throw new Error("--as-sender cannot be combined with --in or --at.");
		const addressed = await addressedAgent(params, task);
		if (addressed) {
			// Refused now, while the sender is listening, not hours later at fire time.
			const live = await resolveScheduledMessageAuthorPane(task, addressed);
			if (!live.ok) throw new Error(`Could not schedule the message — ${live.detail}.`);
		}
		const source = await stampedSource(params, task.id);
		// An explicit `--agent` wins; otherwise only a self-reminder is bound to its
		// author, since a message for another task is addressed to its main agent.
		const author = addressed ?? (params.sourceTaskId === task.id
			? await captureScheduledMessageAuthor(
				task,
				typeof params.sourcePaneId === "string" ? params.sourcePaneId : null,
				typeof params.sourcePid === "number" ? params.sourcePid : null,
			)
			: null);
		const updated = await scheduleMessageCore(project, task, { text, at, source, subject, author });
		const queue = updated.scheduledMessages ?? [];
		// Appended under the tasks-file lock, so the returned queue ends with ours.
		const messageId = queue[queue.length - 1]?.id;
		return { taskId: task.id, projectId: project.id, at, pending: queue.length, messageId, ...replyNotice(source) };
	},

	// `dev3 message --list`: the target task's pending scheduled messages, earliest first.
	"message.scheduled.list": async (params) => {
		const { project, task } = await resolveTaskFromParams(params, { variantIndex: messageVariantIndex(params) });
		return {
			taskId: task.id,
			projectId: project.id,
			seq: task.seq,
			messages: toScheduledMessageListing(task.scheduledMessages ?? []),
		};
	},

	// `dev3 message --cancel <id>`: drop one pending message without delivering it.
	"message.scheduled.cancel": async (params) => {
		const { project, task } = await resolveTaskFromParams(params, { variantIndex: messageVariantIndex(params) });
		const { message } = await cancelScheduledMessageByRef(project, task.id, String(params.messageId ?? ""));
		return { taskId: task.id, projectId: project.id, cancelled: toScheduledMessageListing([message])[0] };
	},
};
