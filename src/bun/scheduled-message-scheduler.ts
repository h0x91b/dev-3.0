import {
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
import { DEFAULT_TMUX_SOCKET, taskSessionName } from "./tmux";
import { sendPromptToAgentPane, sendPromptToPane } from "./agent-prompt";
// Import push via the barrel (not ./rpc-handlers/shared) so tests that mock
// `../rpc-handlers` — e.g. the cli-socket lost-update race suites, which reach
// this module through cli-socket-server — don't load the real Electrobun-backed
// shared module. Used lazily (inside functions), so the git-operations ↔ this
// module ↔ barrel import cycle is resolved safely at call time.
import { getPushMessage, pushCliAttention, pushCliToast } from "./rpc-handlers";
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
 * Resolve the delivery target and type the text (send-keys paste + delayed
 * Enter) into it. `agent` resolves the live agent pane dynamically; `pane`
 * targets a concrete live pane. Returns false when nothing usable is live —
 * the caller then takes the drop-with-notice path.
 */
async function deliverToTarget(task: Task, message: ScheduledMessage): Promise<boolean> {
	const tmuxSession = taskSessionName(task.id);
	const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
	if (message.target.kind === "pane") {
		return sendPromptToPane(tmuxSession, socket, message.target.paneId, message.text);
	}
	return sendPromptToAgentPane(tmuxSession, socket, message.text, task.sessionState?.panes);
}

/** Toast + attention for a late-fire or drop. Silent path never calls this. */
function notifyOutcome(project: Project, task: Task, opts: { toast: string; level: "success" | "error"; reason: string }): void {
	pushCliToast({
		taskId: task.id,
		projectId: project.id,
		message: opts.toast,
		level: opts.level,
		taskSeq: task.seq,
		taskTitle: getTaskTitle(task),
		projectName: project.name,
	});
	pushCliAttention({ taskId: task.id, reason: opts.reason });
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
): Promise<{ delivered: boolean; task: Task }> {
	let delivered = false;
	if (!isTerminal(task.status)) {
		try {
			delivered = await deliverToTarget(task, message);
		} catch (err) {
			log.warn("Scheduled message delivery threw", { taskId: task.id.slice(0, 8), error: String(err) });
		}
	}
	const updated = await removeFromQueue(project, task, message.id);
	const preview = messagePreview(message.text);
	if (!delivered) {
		notifyOutcome(project, task, {
			toast: `Scheduled message not delivered — no live agent: "${preview}"`,
			level: "error",
			reason: `Scheduled message dropped (no live agent): "${preview}"`,
		});
	} else if (opts.late) {
		notifyOutcome(project, task, {
			toast: `Scheduled message delivered late: "${preview}"`,
			level: "success",
			reason: `Scheduled message delivered late: "${preview}"`,
		});
	}
	return { delivered, task: updated };
}

/** Shared validation for a message's text; throws a usage-style error. */
function validateText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("Message text is required");
	if (trimmed.length > MAX_SCHEDULED_MESSAGE_LENGTH) {
		throw new Error(`Message too long (${trimmed.length} chars). Keep it under ${MAX_SCHEDULED_MESSAGE_LENGTH} characters.`);
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
	input: { text: string; at: string; target?: ScheduledMessageTarget | null },
): Promise<Task> {
	const text = validateText(input.text);
	if (isTerminal(task.status)) {
		throw new Error("Cannot schedule a message for a completed or cancelled task");
	}
	const at = new Date(input.at);
	if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
		throw new Error("Scheduled message time must be in the future");
	}
	const item: ScheduledMessage = {
		id: crypto.randomUUID(),
		text,
		at: at.toISOString(),
		target: normalizeTarget(input.target),
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
 * `dev3 message "text"` form). Throws if it can't be delivered so the caller can
 * report the failure. Returns nothing on success.
 */
export async function sendMessageImmediately(
	task: Task,
	text: string,
	target?: ScheduledMessageTarget | null,
): Promise<void> {
	const trimmed = validateText(text);
	if (isTerminal(task.status)) {
		throw new Error("Cannot send a message to a completed or cancelled task");
	}
	const delivered = await deliverToTarget(task, {
		id: "",
		text: trimmed,
		at: "",
		target: normalizeTarget(target),
	});
	if (!delivered) {
		throw new Error("Could not deliver the message — the task has no live agent session.");
	}
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
