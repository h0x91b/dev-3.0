import { requireMessageSubject } from "../../shared/agent-message-subject";
import { cancelScheduledMessageByRef, scheduleMessage as scheduleMessageCore, sendMessageImmediately } from "../scheduled-message-scheduler";
import { captureScheduledMessageAuthor } from "../scheduled-message-author";
import { toScheduledMessageListing } from "../../shared/scheduled-message-listing";
import type { Handler } from "./shared";
import { messageVariantIndex, resolveAgentMessageSource, resolveTaskFromParams } from "./task-resolution";

export const messageHandlers: Record<string, Handler> = {

	// `dev3 message "text"` (no time flag): deliver a message into the task's live
	// agent immediately. Throws only when nothing was sent; an unconfirmed send
	// travels back as its own status so the CLI reports it as neither.
	"message.send": async (params) => {
		const { project, task } = await resolveTaskFromParams(params, { variantIndex: messageVariantIndex(params) });
		const text = ((params.text as string) ?? "").toString();
		// The app's half of the subject gate. The CLI checks it first and reports it
		// better, so reaching this means an older `dev3` binary that never learned
		// the flag — it gets the same explanation instead of writing a mute row.
		const subject = requireMessageSubject(params.subject, text);
		const source = await resolveAgentMessageSource(params, task.id);
		const delivery = await sendMessageImmediately(task, text, null, source, { subject });
		return {
			delivered: true,
			status: delivery.status,
			...(delivery.detail === undefined ? {} : { detail: delivery.detail }),
			taskId: task.id,
			projectId: project.id,
		};
	},

	// `dev3 message --in <dur> | --at <hh:mm> "text"`: queue a scheduled message on
	// the task's live agent (validation + cap live in the scheduler core).
	"message.schedule": async (params) => {
		const { project, task } = await resolveTaskFromParams(params, { variantIndex: messageVariantIndex(params) });
		const text = ((params.text as string) ?? "").toString();
		const at = (params.at as string) ?? "";
		// Same gate as the immediate send: a delay changes nothing about the subject.
		const subject = requireMessageSubject(params.subject, text);
		const source = await resolveAgentMessageSource(params, task.id);
		// Only a self-reminder is bound to its author: a message for another task
		// is addressed to that task, whichever of its agents is live.
		const author = params.sourceTaskId === task.id
			? await captureScheduledMessageAuthor(
				task,
				typeof params.sourcePaneId === "string" ? params.sourcePaneId : null,
				typeof params.sourcePid === "number" ? params.sourcePid : null,
			)
			: null;
		const updated = await scheduleMessageCore(project, task, { text, at, source, subject, author });
		const queue = updated.scheduledMessages ?? [];
		// Appended under the tasks-file lock, so the returned queue ends with ours.
		const messageId = queue[queue.length - 1]?.id;
		return { taskId: task.id, projectId: project.id, at, pending: queue.length, messageId };
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
