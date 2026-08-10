import { sendRequest } from "../socket-client";
import { exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { parseDelay, formatCountdown } from "../../shared/duration";
import { resolveScheduleTarget } from "../../shared/schedule";
import { MAX_SCHEDULED_MESSAGE_LENGTH } from "../../shared/types";
import type { AgentPromptDeliveryStatus } from "../../shared/agent-prompt-delivery";
import { CLI_EXIT_CODE_DELIVERY_UNCONFIRMED } from "../../shared/cli-exit-codes";

const USAGE = 'Usage: dev3 message [--in <dur> | --at <hh:mm>] "text" [--task <id>]';

/**
 * `dev3 message "text"` — deliver a message into the current task's live agent.
 * Bare form sends immediately; `--in <dur>` (e.g. `10m`, `2h30m`) or
 * `--at <hh:mm>` (next occurrence today/tomorrow) queues it as a scheduled
 * message. Task auto-detected from the worktree; `--task`/`--project` override.
 * Text can be a positional arg, `--message`, or `@file`.
 */
export async function handleMessage(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project", "in", "at", "message"]);

	const text = (args.positional[0] ?? args.flags.message ?? "").toString().trim();
	if (!text) exitUsage(USAGE);
	if (text.length > MAX_SCHEDULED_MESSAGE_LENGTH) {
		exitUsage(
			`Message too long: ${text.length} chars, and the limit is ${MAX_SCHEDULED_MESSAGE_LENGTH}. ` +
				`Write it to a file and send that path instead.`,
		);
	}

	const hasIn = "in" in args.flags && args.flags.in !== "true";
	const hasAt = "at" in args.flags && args.flags.at !== "true";
	if ("in" in args.flags && !hasIn) exitUsage("--in needs a duration, e.g. --in 30m or --in 2h30m.");
	if ("at" in args.flags && !hasAt) exitUsage("--at needs a time, e.g. --at 14:00.");
	if (hasIn && hasAt) exitUsage("Use either --in or --at, not both.");

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) {
		exitUsage("No task in context. Run inside a worktree or pass --task <id> / --task-id <id>.");
	}

	const params: Record<string, unknown> = { taskId: expandShortId(rawTaskId, context), text };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;
	// Running inside a worktree means an agent is the author: hand the app our own
	// task id so it can wrap the text in the cross-task envelope (it resolves both
	// ends and skips wrapping when a task messages itself).
	if (context?.taskId) params.sourceTaskId = context.taskId;

	// Bare form → send immediately.
	if (!hasIn && !hasAt) {
		const resp = await sendRequest(socketPath, "message.send", params);
		if (!resp.ok) exitError(resp.error || "Failed to send message");
		const data = resp.data as { taskId: string; status?: AgentPromptDeliveryStatus; detail?: string };
		const shortId = data.taskId.slice(0, 8);
		// "Unconfirmed" is its own exit code, never an error: the text may well have
		// landed, and an agent that read a failure here would re-send it — a second
		// submit into a live agent is worse than not knowing.
		if (data.status === "unconfirmed") {
			process.stdout.write(
				`Message sent to task ${shortId}, but delivery could not be confirmed${data.detail ? ` (${data.detail})` : ""}. ` +
					`Check the task's terminal before sending it again.\n`,
			);
			process.exit(CLI_EXIT_CODE_DELIVERY_UNCONFIRMED);
		}
		process.stdout.write(`Message sent to task ${shortId}.\n`);
		return;
	}

	// Scheduled form → resolve the target time, then queue it.
	const now = Date.now();
	let at: Date | null;
	if (hasIn) {
		const ms = parseDelay(args.flags.in);
		if (ms == null) exitUsage(`Invalid --in duration "${args.flags.in}". Use e.g. 30m, 2h, 1h30m.`);
		at = new Date(now + ms);
	} else {
		at = resolveScheduleTarget({ mode: "at", delayHours: 0, delayMinutes: 0, atTime: args.flags.at }, now);
		if (!at) exitUsage(`Invalid --at time "${args.flags.at}". Use HH:MM (24-hour), e.g. 14:00.`);
	}

	params.at = at.toISOString();
	const resp = await sendRequest(socketPath, "message.schedule", params);
	if (!resp.ok) exitError(resp.error || "Failed to schedule message");
	const data = resp.data as { taskId: string; pending: number };
	const when = at.toLocaleString([], { hour: "2-digit", minute: "2-digit" });
	process.stdout.write(
		`Message scheduled for ${when} (in ${formatCountdown(at.getTime() - now)}) on task ${data.taskId.slice(0, 8)}.\n`,
	);
}
