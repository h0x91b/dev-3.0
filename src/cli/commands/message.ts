import { sendRequest } from "../socket-client";
import { exitError, exitUsage } from "../output";
import { checkMessageSubject, messageSubjectError } from "../../shared/agent-message-subject";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { parseDelay, formatCountdown } from "../../shared/duration";
import { resolveScheduleTarget } from "../../shared/schedule";
import { MAX_SCHEDULED_MESSAGE_LENGTH } from "../../shared/types";
import type { AgentPromptDeliveryStatus } from "../../shared/agent-prompt-delivery";
import {
	CLI_EXIT_CODE_DELIVERY_UNCONFIRMED,
	CLI_EXIT_CODE_MESSAGE_SUBJECT_REQUIRED,
} from "../../shared/cli-exit-codes";
import {
	AGENT_MESSAGE_HOLD_HUMAN_IDLE_SECONDS,
	AGENT_MESSAGE_HOLD_IDLE_SECONDS,
} from "../../shared/agent-message-hold-timing";

const USAGE =
	'Usage: dev3 message --subject "<what it is about>" "text" [--in <dur> | --at <hh:mm>] [--task <id>] [--variant <i>]';

const VARIANT_NEEDS_SEQ =
	"--variant narrows a variant group addressed by seq. Pass --task seq:<N> --variant <i>.";

/**
 * `--variant <i>` — the member of a live variant group to address. A group
 * shares one seq, so `seq:<N>` alone is rejected as ambiguous and the index is
 * what tells the members apart (the card shows it as `<seq>-<i>`).
 */
function parseVariantFlag(raw: unknown): number | undefined {
	if (raw === undefined) return undefined;
	const value = String(raw).trim();
	if (value === "" || value === "true") exitUsage("--variant needs an index, e.g. --variant 1.");
	if (!/^\d+$/.test(value)) {
		exitUsage(`Invalid --variant "${value}". It is the index shown on the card as <seq>-<index>, e.g. 1.`);
	}
	return Number(value);
}

/**
 * The target flags the caller already typed, so the corrected command in a
 * subject error is theirs rather than a generic one. Values are quoted only where
 * they can contain a space — a task ref and a duration cannot.
 */
function targetFlags(args: ParsedArgs): string {
	const parts: string[] = [];
	const task = args.flags.task || args.flags["task-id"];
	if (task) parts.push(`--task ${task}`);
	if (args.flags.variant && args.flags.variant !== "true") parts.push(`--variant ${args.flags.variant}`);
	if (args.flags.project && args.flags.project !== "true") parts.push(`--project ${args.flags.project}`);
	if (args.flags.in && args.flags.in !== "true") parts.push(`--in ${args.flags.in}`);
	if (args.flags.at && args.flags.at !== "true") parts.push(`--at ${args.flags.at}`);
	return parts.join(" ");
}

/**
 * The subject gate. Mandatory, with no default and no value derived from the body:
 * the whole point of the field is that a human reads it later and finds a sentence
 * a peer chose to write, not the first six words of a preamble.
 *
 * Its own exit code, so a wrapper can tell "you forgot the subject" — the one
 * failure every existing caller will hit once — apart from a misspelled command.
 */
function requireSubject(args: ParsedArgs, text: string): string {
	// `--subject` with no value parses as the string "true"; that is a flag the
	// caller typed and left empty, not a subject reading "true".
	const raw = args.flags.subject === "true" ? "" : (args.flags.subject ?? "");
	const check = checkMessageSubject(raw);
	if (check.ok) return check.subject;
	const { message, detail } = messageSubjectError({
		problem: check.problem,
		body: text,
		flags: targetFlags(args),
		subject: check.subject,
	});
	exitError(message, detail, CLI_EXIT_CODE_MESSAGE_SUBJECT_REQUIRED);
}

/**
 * `dev3 message "text"` — deliver a message into the current task's live agent.
 * Bare form sends immediately; `--in <dur>` (e.g. `10m`, `2h30m`) or
 * `--at <hh:mm>` (next occurrence today/tomorrow) queues it as a scheduled
 * message. Task auto-detected from the worktree; `--task`/`--project` override.
 * Text can be a positional arg, `--message`, or `@file`.
 *
 * `--subject` is required on every form, immediate and scheduled alike: it is
 * stored with the message and it is the line the agent-traffic view renders.
 */
export async function handleMessage(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project", "in", "at", "message", "variant", "subject"]);

	const text = (args.positional[0] ?? args.flags.message ?? "").toString().trim();
	if (!text) exitUsage(USAGE);
	if (text.length > MAX_SCHEDULED_MESSAGE_LENGTH) {
		exitUsage(
			`Message too long: ${text.length} chars, and the limit is ${MAX_SCHEDULED_MESSAGE_LENGTH}. ` +
				`Write it to a file and send that path instead.`,
		);
	}
	const subject = requireSubject(args, text);

	const hasIn = "in" in args.flags && args.flags.in !== "true";
	const hasAt = "at" in args.flags && args.flags.at !== "true";
	if ("in" in args.flags && !hasIn) exitUsage("--in needs a duration, e.g. --in 30m or --in 2h30m.");
	if ("at" in args.flags && !hasAt) exitUsage("--at needs a time, e.g. --at 14:00.");
	if (hasIn && hasAt) exitUsage("Use either --in or --at, not both.");

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) {
		exitUsage("No task in context. Run inside a worktree or pass --task <id> / --task-id <id>.");
	}

	const variantIndex = parseVariantFlag(args.flags.variant);
	// A UUID already names one member, and the worktree's own task is not a group
	// address at all — either one plus `--variant` is a confused command, not a
	// filter to apply silently.
	if (variantIndex !== undefined && !/^seq:\d+$/.test(String(rawTaskId))) exitUsage(VARIANT_NEEDS_SEQ);

	const params: Record<string, unknown> = { taskId: expandShortId(rawTaskId, context), text, subject };
	if (variantIndex !== undefined) params.variantIndex = variantIndex;
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
		// Nothing has been typed yet, and saying "sent" would read as "the agent is
		// reading it now". The whole message waits for the pane to go quiet, so it can
		// never land in the middle of a line the user is writing.
		process.stdout.write(
			`Message queued for task ${shortId}. It lands after ${AGENT_MESSAGE_HOLD_IDLE_SECONDS}s of quiet on that ` +
				`pane — ${AGENT_MESSAGE_HOLD_HUMAN_IDLE_SECONDS}s if the user has been typing there, at once when they ` +
				`press Enter — and anything else sent meanwhile arrives in the same turn.\n`,
		);
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
