import {
	type AgentMessageSource,
	type Project,
	type Task,
	type TaskStatus,
	type ScheduledMessage,
	type ScheduledMessageTarget,
	getTaskTitle,
	MAX_SCHEDULED_MESSAGES_PER_TASK,
	MAX_SCHEDULED_MESSAGE_LENGTH,
} from "../shared/types";
import * as data from "./data";
import type { AgentPromptDelivery } from "../shared/agent-prompt-delivery";
import { deliverAgentPrompt } from "./agent-prompt-delivery";
import { wrapAgentMessage } from "../shared/agent-message-envelope";
import { spillOversizedAgentMessage } from "./agent-message-spill";
import { appendAgentMessageLog } from "./agent-message-log";
// Import push via the barrel (not ./rpc-handlers/shared) so tests that mock
// `../rpc-handlers` — e.g. the cli-socket lost-update race suites, which reach
// this module through cli-socket-server — don't load the real Electrobun-backed
// shared module. Used lazily (inside functions), so the git-operations ↔ this
// module ↔ barrel import cycle is resolved safely at call time.
import { getPushMessage, pushAgentMessage, pushCliAttention, pushCliToast } from "./rpc-handlers";
import { createLogger } from "./logger";

const log = createLogger("scheduled-message-scheduler");

/** How often the scheduler wakes up to check for due scheduled messages. */
const TICK_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;
// The first tick after start is the offline catch-up: any already-due item fires
// "late" (the app was down while its time passed) and notifies. Later ticks fire
// items silently as they become due within the 30 s window.
let firstTick = true;

function isTerminal(status: TaskStatus): boolean {
	return status === "completed" || status === "cancelled";
}

/** Coerce/validate a target into a well-formed value; unknown shapes → agent. */
function normalizeTarget(target: ScheduledMessageTarget | undefined | null): ScheduledMessageTarget {
	if (target && target.kind === "pane" && typeof target.paneId === "string" && target.paneId.length > 0) {
		return { kind: "pane", paneId: target.paneId };
	}
	return { kind: "agent" };
}

/** One-line, length-clamped preview of a message for toast/attention text. */
function messagePreview(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine;
}

/**
 * Resolve the delivery target and type the text into it, then submit it.
 * `agent` resolves the live agent pane dynamically; `pane` targets a concrete
 * live pane. Backend-neutral — the tmux/native split lives behind
 * {@link deliverAgentPrompt}. Returns false when nothing usable is live: the
 * caller then takes the drop-with-notice path.
 *
 * The ONE seam shared by immediate `dev3 message` sends and queued
 * "Send later" fires, so the two can never drift apart again.
 */
async function deliverToTarget(task: Task, message: ScheduledMessage): Promise<AgentPromptDelivery> {
	// Agent-to-agent traffic is wrapped at delivery time, so the queue (and the
	// card chip that previews it) keeps the plain text the sender wrote.
	const text = message.source ? wrapAgentMessage(message.text, message.source) : message.text;
	// Held message: nothing is typed until the pane goes quiet. Bursts (one agent
	// writing three in a row, or several peers reporting at once) then become one
	// agent turn, and no text lands in the middle of the user's own line. See
	// agent-message-hold.ts.
	const delivery = await deliverAgentPrompt(task, text, message.target, { hold: true });
	if (message.source) announceAgentMessage(task, message, delivery);
	return delivery;
}

/**
 * Write the attempt to the project's append-only message log — the only durable
 * record that one task spoke to another.
 *
 * Called from the two OUTCOME points rather than from `deliverToTarget`, because a
 * message can end without ever reaching a pane: a finished task is dropped before
 * delivery is attempted, and "we tried and nothing landed" is exactly the state a
 * user reconstructing a silence needs to find. Every attempt is logged,
 * `not-delivered` included, and the row carries the real verdict, never an intent.
 */
async function recordMessageAttempt(task: Task, message: ScheduledMessage, delivery: AgentPromptDelivery): Promise<void> {
	try {
		const project = await data.getProject(task.projectId);
		const source = message.source;
		appendAgentMessageLog(project, {
			at: new Date().toISOString(),
			fromTaskId: source?.taskId ?? null,
			fromSeq: source?.seq ?? null,
			...(source?.title ? { fromTitle: source.title } : {}),
			...(source?.projectId ? { fromProjectId: source.projectId } : {}),
			toTaskId: task.id,
			toSeq: task.seq,
			toTitle: getTaskTitle(task),
			toProjectId: task.projectId,
			// A queued item carries the time it was queued for; an immediate send has none.
			kind: message.at ? "scheduled" : "immediate",
			...(message.at ? { scheduledFor: message.at } : {}),
			body: message.text,
			bodyKind: message.spilledPath ? "spill-pointer" : "text",
			...(message.spilledPath ? { spillPath: message.spilledPath } : {}),
			status: delivery.status,
			...(delivery.reason ? { reason: delivery.reason } : {}),
			...(delivery.detail ? { detail: delivery.detail } : {}),
		});
	} catch (err) {
		// Logging is observability, never a delivery precondition.
		log.warn("Could not record the message in the project log", { taskId: task.id.slice(0, 8), error: String(err) });
	}
}

/**
 * Tell the user that one agent wrote to another — the only channel where task
 * traffic happens with no human in the loop. Raised from the single delivery
 * seam, so the immediate `dev3 message` send and a queued "Send later" fire
 * announce identically. Silent for anything the human sent (no `source`) and for
 * a send that landed nowhere; `unconfirmed` still announces, because the text is
 * gone from the queue and the terminal is where it has to be checked, and so does
 * `held` — the traffic is real, it is simply waiting for a quiet pane.
 */
function announceAgentMessage(task: Task, message: ScheduledMessage, delivery: AgentPromptDelivery): void {
	const source = message.source;
	if (!source || delivery.status === "not-delivered") return;
	pushAgentMessage({
		taskId: task.id,
		projectId: task.projectId,
		toSeq: task.seq,
		toTitle: getTaskTitle(task),
		fromSeq: source.seq,
		...(source.title ? { fromTitle: source.title } : {}),
		...(source.projectId ? { fromProjectId: source.projectId } : {}),
		preview: messagePreview(message.text),
	});
}

/** Toast + attention for a late-fire or drop. Silent path never calls this. */
function notifyOutcome(
	project: Project,
	task: Task,
	opts: { toast: string; level: "success" | "error" | "info"; reason: string },
): void {
	pushCliToast({
		taskId: task.id,
		projectId: project.id,
		message: opts.toast,
		level: opts.level,
		taskSeq: task.seq,
		taskTitle: getTaskTitle(task),
		projectName: project.name,
	});
	pushCliAttention({ taskId: task.id, projectId: task.projectId, reason: opts.reason });
}

/** Remove one queued message and broadcast the updated task. Returns the updated
 * task, or the input snapshot if the task was consumed mid-fire. */
async function removeFromQueue(project: Project, task: Task, messageId: string): Promise<Task> {
	try {
		const { task: updated } = await data.updateTaskWith<void>(project, task.id, (current) => {
			const queue = current.scheduledMessages ?? [];
			return { updates: { scheduledMessages: queue.filter((m) => m.id !== messageId) }, result: undefined };
		});
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return updated;
	} catch {
		return task; // task may have been consumed mid-failure; nothing left to update
	}
}

/**
 * Deliver one message (best-effort, even if the agent is mid-generation), then
 * remove it from the queue. A normal successful fire while the app is open is
 * silent; only a late fire (offline catch-up) or a drop (unresolvable target /
 * terminal task) raises a toast + attention. Returns the queue-updated task.
 */
export async function fireScheduledMessage(
	project: Project,
	task: Task,
	message: ScheduledMessage,
	opts: { late: boolean },
): Promise<{ delivery: AgentPromptDelivery; task: Task }> {
	let delivery: AgentPromptDelivery = { status: "not-delivered", reason: "pane-absent", detail: "the task is finished" };
	if (!isTerminal(task.status)) {
		try {
			delivery = await deliverToTarget(task, message);
		} catch (err) {
			delivery = { status: "not-delivered", reason: "backend-failure", detail: String(err) };
			log.warn("Scheduled message delivery threw", { taskId: task.id.slice(0, 8), error: String(err) });
		}
	}
	await recordMessageAttempt(task, message, delivery);
	const updated = await removeFromQueue(project, task, message.id);
	const preview = messagePreview(message.text);
	if (delivery.status === "not-delivered") {
		notifyOutcome(project, task, {
			toast: `Scheduled message not delivered — no live agent: "${preview}"`,
			level: "error",
			reason: `Scheduled message dropped (no live agent): "${preview}"`,
		});
	} else if (delivery.status === "unconfirmed") {
		// Never silent. The message is out of the queue whatever happened, so saying
		// nothing would read as "delivered" and the text would be unrecoverable.
		notifyOutcome(project, task, {
			toast: `Scheduled message sent but not confirmed — check the terminal: "${preview}"`,
			level: "info",
			reason: `Scheduled message sent without confirmation (removed from the queue): "${preview}"`,
		});
	} else if (opts.late) {
		// A held message has not been typed yet, so "delivered" would be a lie about
		// where it is — it is in dev3, waiting for the pane to go quiet.
		const what = delivery.status === "held" ? "fired late, landing once the terminal is quiet" : "delivered late";
		notifyOutcome(project, task, {
			toast: `Scheduled message ${what}: "${preview}"`,
			level: "success",
			reason: `Scheduled message ${what}: "${preview}"`,
		});
	}
	return { delivery, task: updated };
}

/** Shared validation for a message's text; throws a usage-style error. */
function validateText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("Message text is required");
	if (trimmed.length > MAX_SCHEDULED_MESSAGE_LENGTH) {
		throw new Error(
			`Message too long: ${trimmed.length} chars, and the limit is ${MAX_SCHEDULED_MESSAGE_LENGTH}. ` +
				`Write it to a file and send that path instead.`,
		);
	}
	return trimmed;
}

/**
 * Queue a scheduled message on a task with a live agent. Validates the text, the
 * future time, and the per-task cap, appends the item, broadcasts, and returns
 * the updated task. Shared by the `scheduleMessage` RPC and the CLI socket.
 */
export async function scheduleMessage(
	project: Project,
	task: Task,
	input: { text: string; at: string; target?: ScheduledMessageTarget | null; source?: AgentMessageSource | null },
): Promise<Task> {
	const validated = validateText(input.text);
	if (isTerminal(task.status)) {
		throw new Error("Cannot schedule a message for a completed or cancelled task");
	}
	// Spilled at queue time, not at delivery: the queue lives in tasks.json, and 20
	// pending messages of the full allowed length would put megabytes in there.
	const { text, spilledPath } = await spillOversizedAgentMessage(task, validated);
	const at = new Date(input.at);
	if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
		throw new Error("Scheduled message time must be in the future");
	}
	const item: ScheduledMessage = {
		id: crypto.randomUUID(),
		text,
		at: at.toISOString(),
		target: normalizeTarget(input.target),
		...(input.source ? { source: input.source } : {}),
		...(spilledPath ? { spilledPath } : {}),
	};
	const { task: updated } = await data.updateTaskWith<void>(project, task.id, (current) => {
		const queue = current.scheduledMessages ?? [];
		if (queue.length >= MAX_SCHEDULED_MESSAGES_PER_TASK) {
			throw new Error(`Too many pending scheduled messages (max ${MAX_SCHEDULED_MESSAGES_PER_TASK}). Cancel one first.`);
		}
		return { updates: { scheduledMessages: [...queue, item] }, result: undefined };
	});
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	log.info("Scheduled message queued", { taskId: task.id.slice(0, 8), at: item.at, target: item.target.kind });
	return updated;
}

/** Remove one pending scheduled message without delivering it. */
export async function cancelScheduledMessage(project: Project, taskId: string, messageId: string): Promise<Task> {
	const task = await data.getTask(project, taskId);
	return removeFromQueue(project, task, messageId);
}

/** Deliver a pending scheduled message immediately and remove it (chip "Send now"). */
export async function sendScheduledMessageNow(project: Project, taskId: string, messageId: string): Promise<Task> {
	const task = await data.getTask(project, taskId);
	const message = (task.scheduledMessages ?? []).find((m) => m.id === messageId);
	if (!message) throw new Error("Scheduled message not found");
	const { task: updated } = await fireScheduledMessage(project, task, message, { late: false });
	return updated;
}

/**
 * Send `text` to a task's agent/pane right now without queueing (the CLI bare
 * `dev3 message "text"` form).
 *
 * Throws ONLY when nothing was sent, because a caller that catches reports a failure
 * and re-sends — and a re-send into a live agent is a double submit. An unconfirmed
 * send is therefore returned, not thrown, and the caller must say so out loud.
 */
export async function sendMessageImmediately(
	task: Task,
	text: string,
	target?: ScheduledMessageTarget | null,
	source?: AgentMessageSource | null,
): Promise<AgentPromptDelivery & { spilledPath: string | null }> {
	const trimmed = validateText(text);
	if (isTerminal(task.status)) {
		throw new Error("Cannot send a message to a completed or cancelled task");
	}
	const { text: payload, spilledPath } = await spillOversizedAgentMessage(task, trimmed);
	const message: ScheduledMessage = {
		id: "",
		text: payload,
		at: "",
		target: normalizeTarget(target),
		...(source ? { source } : {}),
		...(spilledPath ? { spilledPath } : {}),
	};
	const delivery = await deliverToTarget(task, message);
	await recordMessageAttempt(task, message, delivery);
	if (delivery.status === "not-delivered") {
		throw new Error("Could not deliver the message — the task has no live agent session.");
	}
	return { ...delivery, spilledPath };
}

/**
 * Fires "Send later" scheduled messages (see {@link Task.scheduledMessages}).
 * One-shot like deferred launches: an item whose time passed while the app was
 * offline fires on the first tick after startup (late + notify) rather than
 * being lost. Best-effort delivery — a busy agent still receives the input.
 */
export function startScheduledMessageScheduler(): void {
	if (timer) return;
	log.info("Scheduled-message scheduler started", { tickMs: TICK_INTERVAL_MS });
	// First tick runs immediately: it is also the offline late-fire catch-up.
	void tick();
	timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
}

export function stopScheduledMessageScheduler(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	firstTick = true;
}

async function tick(): Promise<void> {
	if (tickInFlight) return; // never overlap ticks — the double-fire guard
	tickInFlight = true;
	const late = firstTick;
	firstTick = false;
	try {
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		for (const project of projects) {
			try {
				await tickProject(project, late);
			} catch (err) {
				log.error("Scheduled-message tick failed for project", { projectId: project.id, error: String(err) });
			}
		}
	} catch (err) {
		log.error("Scheduled-message tick failed", { error: String(err) });
	} finally {
		tickInFlight = false;
	}
}

async function tickProject(project: Project, late: boolean): Promise<void> {
	const tasks = await data.loadTasks(project);
	const now = Date.now();
	for (const task of tasks) {
		const queue = task.scheduledMessages;
		if (!queue || queue.length === 0) continue;
		for (const message of queue) {
			const at = new Date(message.at).getTime();
			if (!Number.isFinite(at)) {
				log.error("Scheduled message has an unparseable time; dropping it", { taskId: task.id.slice(0, 8), at: message.at });
				await removeFromQueue(project, task, message.id);
				continue;
			}
			if (at > now) continue;
			try {
				await fireScheduledMessage(project, task, message, { late });
			} catch (err) {
				// A permanently-failing item must not retry every tick forever.
				log.error("Scheduled message fire failed; dropping", { taskId: task.id.slice(0, 8), error: String(err) });
				await removeFromQueue(project, task, message.id);
			}
		}
	}
}
