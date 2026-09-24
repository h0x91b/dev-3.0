import { sendRequest } from "../socket-client";
import { exitError, exitUsage, printTable } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { describeScheduledTime } from "../../shared/schedule-at";
import type { ScheduledMessageListing } from "../../shared/scheduled-message-listing";

/** `--list` or `--cancel` present: the queue verbs, which take no message text. */
export function isScheduledQueueCommand(args: ParsedArgs): boolean {
	return "list" in args.flags || "cancel" in args.flags;
}

/**
 * `dev3 message --list [--json]` and `dev3 message --cancel <id>`. Both act on
 * the TARGET task's queue — the worktree's own task unless `--task` names
 * another — because that is where a scheduled message waits until it fires.
 */
export async function handleScheduledQueue(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
	nowMs: number = Date.now(),
): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project", "variant", "list", "cancel", "json"]);
	const listing = "list" in args.flags;
	const cancel = args.flags.cancel;
	if (listing && cancel !== undefined) exitUsage("Use either --list or --cancel <id>, not both.");
	if (!listing && (cancel === "true" || !cancel?.trim())) {
		exitUsage("--cancel needs the message id (8-char prefix works). Find it with: dev3 message --list");
	}
	if (listing && args.flags.list !== "true") {
		exitUsage(`--list takes no value (got "${args.flags.list}"). Target another task with --task <id>.`);
	}

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) exitUsage("No task in context. Run inside a worktree or pass --task <id>.");
	const params: Record<string, unknown> = { taskId: expandShortId(rawTaskId, context) };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;
	if (args.flags.variant !== undefined) {
		if (!/^\d+$/.test(args.flags.variant)) exitUsage("--variant needs an index, e.g. --variant 1.");
		params.variantIndex = Number(args.flags.variant);
	}

	if (!listing) {
		params.messageId = cancel!.trim();
		const resp = await sendRequest(socketPath, "message.scheduled.cancel", params);
		if (!resp.ok) exitError(resp.error || "Failed to cancel the scheduled message");
		const data = resp.data as { taskId: string; cancelled: ScheduledMessageListing };
		process.stdout.write(
			`Cancelled scheduled message ${data.cancelled.id.slice(0, 8)} on task ${data.taskId.slice(0, 8)} ` +
				`(was due ${describeScheduledTime(new Date(data.cancelled.at), nowMs)}). It will not be delivered.\n`,
		);
		return;
	}

	const resp = await sendRequest(socketPath, "message.scheduled.list", params);
	if (!resp.ok) exitError(resp.error || "Failed to list scheduled messages");
	const data = resp.data as { taskId: string; seq: number; messages: ScheduledMessageListing[] };
	if ("json" in args.flags) {
		process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
		return;
	}
	if (data.messages.length === 0) {
		process.stdout.write(`No scheduled messages pending on task ${data.taskId.slice(0, 8)} (seq ${data.seq}).\n`);
		return;
	}
	printTable(
		["ID", "DUE", "FROM", "SUBJECT"],
		data.messages.map((m) => [
			m.id.slice(0, 8),
			describeScheduledTime(new Date(m.at), nowMs),
			m.fromSeq === null ? "user/app" : `seq:${m.fromSeq}`,
			m.subject ?? m.preview,
		]),
	);
	process.stdout.write(`Cancel one with: dev3 message --cancel <id>${args.flags.task ? ` --task ${args.flags.task}` : ""}\n`);
}
