import type { Task } from "../../shared/types";
import { describeReviewAnchor, type ReviewComment } from "../../shared/review";
import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { readStdin } from "../stdin";

function truncate(text: string, maxLen: number): string {
	const oneLine = text.replace(/\n/g, " ").trim();
	if (oneLine.length <= maxLen) return oneLine;
	return oneLine.slice(0, maxLen - 1) + "…";
}

function requireTask(args: ParsedArgs, context: CliContext | null, usage: string): { taskId: string; params: Record<string, unknown> } {
	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) exitUsage(usage);
	const taskId = expandShortId(rawTaskId, context);
	const params: Record<string, unknown> = { taskId };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;
	return { taskId, params };
}

function status(comment: ReviewComment): string {
	if (comment.resolvedAt) return "resolved";
	return comment.sentAt ? "sent" : "open";
}

async function listReview(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project", "unresolved", "json"]);
	const { params } = requireTask(args, context, "Usage: dev3 review list [--unresolved] [--json] [--task <id>] (or run from inside a worktree)");
	const resp = await sendRequest(socketPath, "review.list", params);
	if (!resp.ok) exitError(resp.error || "Failed to list review comments");

	let comments = resp.data as ReviewComment[];
	if (args.flags.unresolved) comments = comments.filter((comment) => !comment.resolvedAt);
	if (args.flags.json) {
		process.stdout.write(JSON.stringify(comments, null, 2) + "\n");
		return;
	}
	if (comments.length === 0) {
		process.stdout.write(args.flags.unresolved ? "No open review comments\n" : "No review comments\n");
		return;
	}
	const headers = ["ID", "STATUS", "KIND", "WHERE", "COMMENT"];
	const rows = comments.map((comment) => [
		comment.id.slice(0, 8),
		status(comment),
		comment.anchor.kind,
		truncate(describeReviewAnchor(comment.anchor), 48),
		truncate(comment.body, 60),
	]);
	printTable(headers, rows);
	const withReplies = comments.filter((comment) => (comment.replies?.length ?? 0) > 0);
	for (const comment of withReplies) {
		process.stdout.write(`\n${comment.id.slice(0, 8)} thread:\n`);
		for (const reply of comment.replies ?? []) {
			process.stdout.write(`  [${reply.author}] ${truncate(reply.body, 160)}\n`);
		}
	}
}

async function resolveComment(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project", "reply"]);
	const ref = args.positional[0];
	if (!ref) exitUsage("Usage: dev3 review resolve <comment-id> [--reply \"what you did\"] [--task <id>]");
	const { params } = requireTask(args, context, "--task <id> is required (or run from inside a worktree)");
	params.commentId = ref;
	params.by = "agent";
	if (args.flags.reply) params.reply = args.flags.reply === "-" ? await readStdin() : args.flags.reply;
	const resp = await sendRequest(socketPath, "review.resolve", params);
	if (!resp.ok) exitError(resp.error || "Failed to resolve review comment");
	const result = resp.data as { commentId: string; task: Task };
	process.stdout.write(`Resolved ${result.commentId.slice(0, 8)}\n`);
}

async function reopenComment(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project"]);
	const ref = args.positional[0];
	if (!ref) exitUsage("Usage: dev3 review reopen <comment-id> [--task <id>]");
	const { params } = requireTask(args, context, "--task <id> is required (or run from inside a worktree)");
	params.commentId = ref;
	const resp = await sendRequest(socketPath, "review.reopen", params);
	if (!resp.ok) exitError(resp.error || "Failed to reopen review comment");
	const result = resp.data as { commentId: string; task: Task };
	process.stdout.write(`Reopened ${result.commentId.slice(0, 8)}\n`);
}

async function replyComment(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project"]);
	const ref = args.positional[0];
	const rawBody = args.positional[1] || "";
	if (!ref || !rawBody) exitUsage("Usage: dev3 review reply <comment-id> \"text\" [--task <id>]  (use - for stdin)");
	const body = (rawBody === "-" ? await readStdin() : rawBody).trim();
	if (!body) exitUsage("Reply text is required");
	const { params } = requireTask(args, context, "--task <id> is required (or run from inside a worktree)");
	params.commentId = ref;
	params.body = body;
	params.author = "agent";
	const resp = await sendRequest(socketPath, "review.reply", params);
	if (!resp.ok) exitError(resp.error || "Failed to reply to review comment");
	const result = resp.data as { commentId: string; task: Task };
	process.stdout.write(`Replied on ${result.commentId.slice(0, 8)} (still open)\n`);
}

export async function handleReview(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case "list":
			return listReview(args, socketPath, context);
		case "resolve":
			return resolveComment(args, socketPath, context);
		case "reopen":
			return reopenComment(args, socketPath, context);
		case "reply":
			return replyComment(args, socketPath, context);
		default:
			exitUsage(
				`Unknown subcommand: review ${subcommand || "(none)"}` +
				"\nAvailable: review list, review resolve, review reply, review reopen",
			);
	}
}
