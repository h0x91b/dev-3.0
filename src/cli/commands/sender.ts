import type { ParsedArgs } from "../args";
import type { CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { exitError, exitUsage } from "../output";
import { sendRequest } from "../socket-client";
import { isValidSenderId, SENDER_WAIT_MAX_MS, type SenderWaitResult } from "../../shared/external-senders";
import { classifyAppError } from "../../shared/cli-errors";

const USAGE =
	"Usage: dev3 sender inbox --as-sender <id> [--wait <s>] [--client <cid>] [--cursor <c>] [--max <n>] [--take-over] [--json]\n" +
	"       dev3 sender ack --as-sender <id> --client <cid> <item-id…> [--json]";

/**
 * A sender id flag, validated. Refused inside a task worktree: an agent inside
 * dev3 already has an identity, and must not speak as somebody else.
 */
export function readSenderFlag(args: ParsedArgs, flag: "as-sender" | "to-sender", context: CliContext | null): string | undefined {
	if (!(flag in args.flags)) return undefined;
	const id = args.flags[flag] === "true" ? "" : args.flags[flag].trim();
	if (!isValidSenderId(id)) {
		exitUsage(`--${flag} needs a sender id: lowercase a-z, 0-9 and . _ : - (1-64 chars), e.g. openclaw:home:main.`);
	}
	if (flag === "as-sender" && context?.taskId) {
		exitUsage("--as-sender cannot be used from inside a task worktree — it is for agents running outside dev3.");
	}
	return id;
}

/** Exit with the sender-specific code when the app's error names one; returns otherwise. */
export function exitOnSenderError(error: string | undefined): void {
	// An app from before external senders refuses their methods outright — which is
	// the point: it must not run a sender request as a plain one.
	if (error && /^Unknown method: (sender\.\S+|\S+AsSender)$/.test(error)) {
		exitError(
			"The running dev3 app predates external senders, so it refused this request. Nothing was sent, written or started.",
			"Update the app (or restart it after an update) and run the command again.",
		);
	}
	const classified = classifyAppError(error);
	if (classified.code === "EXTERNAL_SENDER_UNKNOWN" || classified.code === "SENDER_INBOX_BUSY") {
		exitError(classified.message, undefined, classified.exitCode);
	}
}

function requireSender(args: ParsedArgs, context: CliContext | null): string {
	const id = readSenderFlag(args, "as-sender", context);
	if (!id) exitUsage(`--as-sender <id> is required.\n${USAGE}`);
	return id;
}

/**
 * `dev3 sender inbox|ack` — an external sender reading the replies tasks wrote
 * to it. Long-poll, not a stream: the socket answers one request per connection
 * and the client gives up at 30 s, so one wait parks at most 25 s.
 */
export async function handleSender(subcommand: string | undefined, args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	if (subcommand === "inbox") return inbox(args, socketPath, context);
	if (subcommand === "ack") return ack(args, socketPath, context);
	exitUsage(USAGE);
}

async function inbox(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["as-sender", "wait", "client", "cursor", "max", "take-over", "json"]);
	const senderId = requireSender(args, context);
	const waitSeconds = "wait" in args.flags ? Number(args.flags.wait) : 0;
	if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds * 1000 > SENDER_WAIT_MAX_MS) {
		exitUsage(`--wait takes seconds from 0 to ${SENDER_WAIT_MAX_MS / 1000}.`);
	}
	const max = "max" in args.flags ? Number(args.flags.max) : undefined;
	if (max !== undefined && (!Number.isInteger(max) || max < 1)) exitUsage("--max takes a positive integer.");
	const clientId = args.flags.client && args.flags.client !== "true" ? args.flags.client : undefined;
	const takeOver = "take-over" in args.flags;
	if (takeOver && !clientId) exitUsage("--take-over needs --client: it hands the lease to that client.");
	const params: Record<string, unknown> = {
		senderId,
		cursor: args.flags.cursor && args.flags.cursor !== "true" ? args.flags.cursor : null,
		timeoutMs: waitSeconds * 1000,
		...(clientId ? { clientId } : {}),
		...(max !== undefined ? { max } : {}),
		...(takeOver ? { takeOver: true } : {}),
	};
	const resp = await sendRequest(socketPath, "sender.wait", params, { timeoutMs: waitSeconds * 1000 + 5_000 });
	if (!resp.ok) {
		exitOnSenderError(resp.error);
		exitError(resp.error || "Failed to read the inbox");
	}
	const result = resp.data as SenderWaitResult;
	if ("json" in args.flags) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	if (result.items.length === 0) process.stdout.write("No unread replies.\n");
	for (const item of result.items) {
		process.stdout.write(
			`--- ${item.id}  from task #${item.fromSeq}${item.fromTitle ? ` (${item.fromTitle})` : ""}  ${item.at}\n` +
				`Subject: ${item.subject}${item.inReplyTo ? `  (reply to ${item.inReplyTo})` : ""}\n${item.body}\n`,
		);
	}
	if (result.cursor) process.stdout.write(`Cursor: ${result.cursor}${result.more ? " (more waiting)" : ""}\n`);
}

async function ack(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["as-sender", "client", "json"]);
	const senderId = requireSender(args, context);
	const clientId = args.flags.client && args.flags.client !== "true" ? args.flags.client : "";
	if (!clientId) exitUsage(`--client <cid> is required: an ack needs the reader lease.\n${USAGE}`);
	if (args.positional.length === 0) exitUsage(`Pass the inbox item ids to acknowledge.\n${USAGE}`);
	const resp = await sendRequest(socketPath, "sender.ack", { senderId, clientId, ids: args.positional });
	if (!resp.ok) {
		exitOnSenderError(resp.error);
		exitError(resp.error || "Failed to acknowledge");
	}
	const result = resp.data as { acked: string[]; unknown: string[] };
	if ("json" in args.flags) {
		process.stdout.write(`${JSON.stringify({ acked: result.acked, unknown: result.unknown })}\n`);
		return;
	}
	process.stdout.write(`Acknowledged ${result.acked.length}.${result.unknown.length ? ` Already acknowledged or unknown: ${result.unknown.join(", ")}` : ""}\n`);
}
