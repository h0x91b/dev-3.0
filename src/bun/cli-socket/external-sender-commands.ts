import { requireMessageSubject } from "../../shared/agent-message-subject";
import { getTaskTitle, MAX_SCHEDULED_MESSAGE_LENGTH } from "../../shared/types";
import {
	ackSenderItems,
	acquireSenderLease,
	postToSenderInbox,
	requireSenderLease,
	waitForSenderItems,
} from "../external-sender-inbox";
import { requireExternalSender } from "../external-senders";
import type { Handler } from "./shared";
import { resolveTaskAcrossProjects } from "./task-resolution";

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireClientId(params: Record<string, unknown>): string {
	const clientId = optionalString(params.clientId);
	if (!clientId) throw new Error("clientId is required");
	return clientId;
}

export const externalSenderHandlers: Record<string, Handler> = {
	// `dev3 message --to-sender <id>`: a task's agent replies into a sender's inbox.
	// Only from a task — the reply has to say which task wrote it.
	"sender.post": async (params) => {
		const sender = requireExternalSender(params.senderId);
		const sourceTaskId = optionalString(params.sourceTaskId);
		if (!sourceTaskId) throw new Error("--to-sender only works from inside a task worktree: the reply names the task that wrote it.");
		const found = await resolveTaskAcrossProjects(sourceTaskId);
		if (!found) throw new Error(`Unknown requesting task "${sourceTaskId}" — cannot attribute the reply.`);
		const text = String(params.text ?? "").trim();
		if (!text) throw new Error("Message text is required");
		if (text.length > MAX_SCHEDULED_MESSAGE_LENGTH) {
			throw new Error(`Message too long: ${text.length} chars, and the limit is ${MAX_SCHEDULED_MESSAGE_LENGTH}.`);
		}
		const subject = requireMessageSubject(params.subject, text);
		const inReplyTo = optionalString(params.inReplyTo);
		const item = postToSenderInbox(sender.id, {
			fromTaskId: found.task.id,
			fromSeq: found.task.seq,
			fromTitle: getTaskTitle(found.task),
			fromProjectId: found.project.id,
			...(inReplyTo ? { inReplyTo } : {}),
			subject,
			body: text,
		});
		return { senderId: sender.id, itemId: item.id };
	},

	// `dev3 sender inbox`: answers at once when unread items exist, else parks up to
	// 25 s. A wait with a clientId takes the reader lease; one without is a plain
	// read (a peek when its timeout is 0) and never touches the lease.
	"sender.wait": async (params, ctx) => {
		const sender = requireExternalSender(params.senderId);
		const clientId = optionalString(params.clientId);
		const release = clientId ? acquireSenderLease(sender.id, clientId, params.takeOver === true) : null;
		try {
			return await waitForSenderItems(sender.id, {
				cursor: params.cursor,
				timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : 0,
				max: typeof params.max === "number" ? params.max : undefined,
				signal: ctx?.signal,
			});
		} finally {
			release?.();
		}
	},

	// `dev3 sender ack`: idempotent, and only for the client holding the lease.
	"sender.ack": async (params) => {
		const sender = requireExternalSender(params.senderId);
		const clientId = requireClientId(params);
		const ids = Array.isArray(params.ids) ? params.ids.filter((id): id is string => typeof id === "string" && id.trim() !== "") : [];
		if (ids.length === 0) throw new Error("ids is required: the inbox item ids to acknowledge");
		requireSenderLease(sender.id, clientId);
		return { senderId: sender.id, ...ackSenderItems(sender.id, clientId, ids.map((id) => id.trim())) };
	},
};
