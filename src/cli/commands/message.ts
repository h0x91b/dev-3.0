import { sendRequest } from "../socket-client";
import { exitError, exitUsage } from "../output";
import { checkMessageSubject, messageSubjectError } from "../../shared/agent-message-subject";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { readStdin } from "../stdin";
import { singleTextInput } from "../text-input";
import { parseDelay, formatCountdown } from "../../shared/duration";
import { describeScheduledTime, parseScheduleAt } from "../../shared/schedule-at";
import { handleScheduledQueue, isScheduledQueueCommand } from "./message-schedule";
import { LEGACY_AGENT_HANDLE_PREFIX, decodeAgentHandle } from "../../shared/agent-handle";
import { senderAgentParams } from "../sender-agent";
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
import { exitOnSenderError, readSenderFlag } from "./sender";

const USAGE =
	'Usage: dev3 message --subject "<what it is about>" "text" [--in <dur> | --at <hh:mm[Z|±hh:mm]>] [--task <id>] [--variant <i>] [--agent <handle>] [--json]\n' +
	'       dev3 message --as-sender <id> --subject "<what it is about>" "text" [--task <id>] [--json]\n' +
	'       dev3 message --to-sender <id> [--in-reply-to <message-id>] --subject "<what it is about>" "text" [--json]\n' +
	"       dev3 message --list [--json] [--task <id>]   |   dev3 message --cancel <id> [--task <id>]";

/** How a delivery names the agent it reached, by the role dev3 launched it in. */
const AGENT_ROLE_LABELS: Record<string, string> = { main: "main agent", agent: "extra agent", review: "AI Review agent" };

/**
 * `--agent <handle>` — one agent of the target task, as `dev3 pane list` prints it.
 * Checked here for shape; the app checks it is still that agent, and refuses rather
 * than falling back to the task when it is not.
 */
function parseAgentFlag(raw: unknown): string | undefined {
	if (raw === undefined) return undefined;
	const value = String(raw).trim();
	if (value === "" || value === "true") exitUsage("--agent needs a handle. Copy one from `dev3 pane list --task <id>`.");
	if (value.startsWith(LEGACY_AGENT_HANDLE_PREFIX)) {
		exitUsage("--agent: that handle was written by an older dev3 and is no longer accepted. Nothing was sent. Copy the agent's current handle from `dev3 pane list --task <id>`.");
	}
	if (!decodeAgentHandle(value)) exitUsage(`"${value}" is not an agent handle. Copy one from \`dev3 pane list --task <id>\`.`);
	if (process.platform === "win32") {
		exitError("--agent is not available on Windows yet: agent identity cannot be verified there. Nothing was sent.");
	}
	return value;
}

/** Said whenever a peer will get this message with no way to answer this agent. */
function replyUnavailableNotice(reason: unknown): string {
	return typeof reason === "string" && reason
		? `Replies to you are not available (${reason}): the message carries no reply command.\n`
		: "";
}

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
	if (args.flags.agent && args.flags.agent !== "true") parts.push(`--agent ${args.flags.agent}`);
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
 * Text can be a positional arg, `--message`, `-` (stdin), or `@file` — one of them.
 * It goes to the task's main agent, or with `--agent <handle>` to that one agent.
 *
 * `--subject` is required on every form, immediate and scheduled alike: it is
 * stored with the message and it is the line the agent-traffic view renders.
 */
export async function handleMessage(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	if (isScheduledQueueCommand(args)) return handleScheduledQueue(args, socketPath, context);
	rejectUnknownFlags(args, [
		"task", "task-id", "project", "in", "at", "message", "variant", "subject", "agent", "json", "as-sender", "to-sender", "in-reply-to",
	]);
	const json = "json" in args.flags;

	const rawText = singleTextInput(args, "message") ?? "";
	const text = (rawText === "-" ? await readStdin() : rawText).trim();
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

	const toSender = readSenderFlag(args, "to-sender", context);
	if (toSender) return replyToSender(args, socketPath, context, { senderId: toSender, text, subject, json, scheduled: hasIn || hasAt });
	if ("in-reply-to" in args.flags) exitUsage("--in-reply-to only applies to a reply with --to-sender <id>.");
	const asSender = readSenderFlag(args, "as-sender", context);
	if (asSender && (hasIn || hasAt)) exitUsage("--as-sender cannot be combined with --in or --at: a sender's message is sent now or not at all.");
	if (asSender && "agent" in args.flags) exitUsage("--as-sender cannot be combined with --agent: a sender's message goes to the task's main agent.");

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) {
		exitUsage("No task in context. Run inside a worktree or pass --task <id> / --task-id <id>.");
	}

	const variantIndex = parseVariantFlag(args.flags.variant);
	// A UUID already names one member, and the worktree's own task is not a group
	// address at all — either one plus `--variant` is a confused command, not a
	// filter to apply silently.
	if (variantIndex !== undefined && !/^seq:\d+$/.test(String(rawTaskId))) exitUsage(VARIANT_NEEDS_SEQ);

	const agentHandle = parseAgentFlag(args.flags.agent);

	const params: Record<string, unknown> = { taskId: expandShortId(rawTaskId, context), text, subject };
	if (variantIndex !== undefined) params.variantIndex = variantIndex;
	if (agentHandle) params.agentHandle = agentHandle;
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;
	// Running inside a worktree means an agent is the author: hand the app our own
	// task id so it can wrap the text in the cross-task envelope (it resolves both
	// ends and skips wrapping when a task messages itself).
	if (context?.taskId) params.sourceTaskId = context.taskId;
	Object.assign(params, senderAgentParams(context));
	if (asSender) params.asSender = asSender;

	// Bare form → send immediately.
	if (!hasIn && !hasAt) {
		const method = asSender ? "message.sendAsSender" : "message.send";
		const resp = await requestWithVerdict(socketPath, method, params, json, NOT_DELIVERED);
		if (!resp.ok) {
			failWithVerdict(json, NOT_DELIVERED, resp.error, "Failed to send message");
		}
		const data = resp.data as {
			taskId: string;
			status?: AgentPromptDeliveryStatus;
			detail?: string;
			messageId?: string;
			paneId?: string;
			agentRole?: string;
			replyUnavailable?: string;
		};
		const shortId = data.taskId.slice(0, 8);
		const role = data.agentRole ? AGENT_ROLE_LABELS[data.agentRole] : undefined;
		const recipient = data.paneId ? ` (${role ? `${role}, ` : ""}pane ${data.paneId})` : "";
		process.stderr.write(replyUnavailableNotice(data.replyUnavailable));
		if (json) {
			process.stdout.write(`${JSON.stringify({ status: data.status ?? "delivered", messageId: data.messageId ?? null })}\n`);
			if (data.status === "unconfirmed") process.exit(CLI_EXIT_CODE_DELIVERY_UNCONFIRMED);
			return;
		}
		// "Unconfirmed" is its own exit code, never an error: the text may well have
		// landed, and an agent that read a failure here would re-send it — a second
		// submit into a live agent is worse than not knowing.
		if (data.status === "unconfirmed") {
			process.stdout.write(
				`Message sent to task ${shortId}${recipient}, but delivery could not be confirmed${data.detail ? ` (${data.detail})` : ""}. ` +
					`Check the task's terminal before sending it again.\n`,
			);
			process.exit(CLI_EXIT_CODE_DELIVERY_UNCONFIRMED);
		}
		// Nothing has been typed yet, and saying "sent" would read as "the agent is
		// reading it now". The whole message waits for the pane to go quiet, so it can
		// never land in the middle of a line the user is writing.
		process.stdout.write(
			`Message queued for task ${shortId}${recipient}. It lands after ${AGENT_MESSAGE_HOLD_IDLE_SECONDS}s of quiet on that ` +
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
		at = parseScheduleAt(args.flags.at, now);
		if (!at) {
			exitUsage(
				`Invalid --at time "${args.flags.at}". Use HH:MM (24-hour, this machine's clock), ` +
					"HH:MMZ for UTC, HH:MM+03:00 for an offset, or 2026-09-25T06:00Z.",
			);
		}
		if (at.getTime() <= now) exitUsage(`--at ${args.flags.at} is in the past.`);
	}

	params.at = at.toISOString();
	const resp = await requestWithVerdict(socketPath, "message.schedule", params, json, NOT_SCHEDULED);
	if (!resp.ok) failWithVerdict(json, NOT_SCHEDULED, resp.error, "Failed to schedule message");
	const data = resp.data as { taskId: string; pending: number; messageId?: string; replyUnavailable?: string };
	const shortTask = data.taskId.slice(0, 8);
	process.stderr.write(replyUnavailableNotice(data.replyUnavailable));
	if (json) {
		process.stdout.write(`${JSON.stringify({ status: "scheduled", messageId: data.messageId ?? null, at: at.toISOString() })}\n`);
		return;
	}
	process.stdout.write(
		`Message scheduled for ${describeScheduledTime(at, now)} (in ${formatCountdown(at.getTime() - now)}) on task ${shortTask}.\n`,
	);
	// An older app does not return the id; `--list` still finds the message.
	if (data.messageId) {
		process.stdout.write(`Id ${data.messageId.slice(0, 8)} — cancel with: dev3 message --cancel ${data.messageId.slice(0, 8)} --task ${shortTask}\n`);
	}
}

/**
 * The connection was accepted and then lost — reset, broken pipe, closed with no
 * answer, or no answer in time. The app may well have typed the message, so this
 * is "unconfirmed", never "failed": a re-send would be a second submit.
 */
function isResponseLost(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const code = (err as NodeJS.ErrnoException).code;
	return err.name === "EmptyResponseError" || code === "ECONNRESET" || code === "EPIPE"
		|| err.message.startsWith("Socket timeout")
		// The app already handled the request; only its answer is unreadable.
		|| err.message.startsWith("Invalid JSON response");
}

/** The `--json` verdict when nothing went through, per form. */
const NOT_DELIVERED = { status: "not-delivered", messageId: null };
const NOT_SCHEDULED = { status: "not-scheduled", messageId: null };
const NOT_POSTED = { status: "not-posted", itemId: null };

/**
 * One request, with `--json` printing exactly one verdict on every way out. A
 * lost transport after sending exits 11 (unconfirmed — a re-send would be a second
 * submit). Anything else thrown never reached the app (refused connect, stale
 * endpoint): the verdict says so, and main.ts picks the exit code (2).
 */
async function requestWithVerdict(
	socketPath: string,
	method: string,
	params: Record<string, unknown>,
	json: boolean,
	failed: Record<string, unknown>,
) {
	try {
		return await sendRequest(socketPath, method, params);
	} catch (err) {
		if (isResponseLost(err)) {
			if (json) process.stdout.write(`${JSON.stringify({ ...failed, status: "unconfirmed" })}\n`);
			else process.stdout.write("The connection to the app was lost after the request was sent, so it could not be confirmed. Check the task before sending it again.\n");
			process.exit(CLI_EXIT_CODE_DELIVERY_UNCONFIRMED);
		}
		if (json) process.stdout.write(`${JSON.stringify(failed)}\n`);
		throw err;
	}
}

/** The app answered with an error: print the verdict, then exit with the matching code. */
function failWithVerdict(json: boolean, failed: Record<string, unknown>, error: string | undefined, fallback: string): never {
	if (json) process.stdout.write(`${JSON.stringify({ ...failed, error: error ?? fallback })}\n`);
	exitOnSenderError(error);
	exitError(error || fallback);
}

/**
 * The `--json` verdict for an app that could not even be discovered, printed by
 * main.ts before it exits 2 — this command never runs then. Null when the
 * invocation asked for no JSON or is not a send (`--list` / `--cancel`).
 */
export function unreachableAppVerdict(rawArgs: readonly string[]): string | null {
	const json = rawArgs.some((a) => a === "--json" || a.startsWith("--json="));
	if (!json || rawArgs.includes("--list") || rawArgs.includes("--cancel")) return null;
	const form = rawArgs.some((a) => a === "--to-sender" || a.startsWith("--to-sender="))
		? NOT_POSTED
		: rawArgs.some((a) => a === "--in" || a === "--at" || a.startsWith("--in=") || a.startsWith("--at="))
			? NOT_SCHEDULED
			: NOT_DELIVERED;
	return JSON.stringify(form);
}

/**
 * `dev3 message --to-sender <id>`: a task's agent answers an external sender. The
 * reply goes into that sender's inbox (`dev3 sender inbox`), not into a pane.
 */
async function replyToSender(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
	opts: { senderId: string; text: string; subject: string; json: boolean; scheduled: boolean },
): Promise<void> {
	if (!context?.taskId) exitUsage("--to-sender only works from inside a task worktree: the reply names the task that wrote it.");
	for (const flag of ["task", "task-id", "variant", "as-sender"]) {
		if (flag in args.flags) exitUsage(`--to-sender cannot be combined with --${flag}.`);
	}
	if (opts.scheduled) exitUsage("--to-sender cannot be combined with --in or --at.");
	const inReplyTo = args.flags["in-reply-to"] && args.flags["in-reply-to"] !== "true" ? args.flags["in-reply-to"] : undefined;
	const resp = await requestWithVerdict(socketPath, "sender.post", {
		senderId: opts.senderId,
		sourceTaskId: context.taskId,
		text: opts.text,
		subject: opts.subject,
		...(inReplyTo ? { inReplyTo } : {}),
	}, opts.json, NOT_POSTED);
	if (!resp.ok) failWithVerdict(opts.json, NOT_POSTED, resp.error, "Failed to reply to the sender");
	const data = resp.data as { itemId: string };
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ status: "posted", itemId: data.itemId })}\n`);
		return;
	}
	process.stdout.write(`Reply written to the inbox of external sender ${opts.senderId} (item ${data.itemId.slice(0, 8)}).\n`);
}
