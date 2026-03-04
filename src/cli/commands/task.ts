import type { Task, TaskStatus } from "../../shared/types";
import { STATUS_LABELS, ALL_STATUSES } from "../../shared/types";
import { sendRequest } from "../socket-client";
import { printDetail, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, type CliContext } from "../context";

// Statuses that destroy the worktree + terminal are forbidden via CLI.
// An agent running inside a worktree must not be able to kill its own session.
const DESTRUCTIVE_STATUSES: TaskStatus[] = ["completed", "cancelled"];
const CLI_ALLOWED_STATUSES = ALL_STATUSES.filter((s) => !DESTRUCTIVE_STATUSES.includes(s));

function formatDate(iso: string): string {
	const d = new Date(iso);
	return d.toLocaleDateString("en-GB", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function printTask(task: Task): void {
	const fields: Array<[string, string]> = [
		["ID:", task.id],
		["Seq:", String(task.seq)],
		["Title:", task.title],
		["Status:", STATUS_LABELS[task.status] || task.status],
	];

	if (task.branchName) fields.push(["Branch:", task.branchName]);
	if (task.worktreePath) fields.push(["Worktree:", task.worktreePath]);

	if (task.labelIds && task.labelIds.length > 0) {
		fields.push(["Labels:", task.labelIds.map((id) => id.slice(0, 8)).join(", ")]);
	}

	fields.push(["Created:", formatDate(task.createdAt)]);
	fields.push(["Updated:", formatDate(task.updatedAt)]);
	if (task.movedAt) fields.push(["Moved:", formatDate(task.movedAt)]);
	if (task.notes && task.notes.length > 0) fields.push(["Notes:", String(task.notes.length)]);

	if (task.description) {
		fields.push(["", ""]);
		fields.push(["Description:", ""]);
	}

	printDetail(fields);

	if (task.description) {
		for (const line of task.description.split("\n")) {
			process.stdout.write(`  ${line}\n`);
		}
	}
}

function resolveTaskId(args: ParsedArgs, context: CliContext | null): string | undefined {
	const raw = args.positional[0] || args.flags.id || context?.taskId;
	if (!raw) return undefined;
	return expandShortId(raw, context);
}

async function showTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage("Usage: dev3 task show <id>");
	}

	const params: Record<string, unknown> = { taskId };
	if (args.flags.project) params.projectId = args.flags.project;
	else if (context?.projectId) params.projectId = context.projectId;

	const resp = await sendRequest(socketPath, "task.show", params);
	if (!resp.ok) exitError(resp.error || "Failed to get task");

	printTask(resp.data as Task);
}

async function createTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const projectId = args.flags.project || context?.projectId;
	if (!projectId) {
		exitUsage("--project <id> is required (or run from inside a worktree)");
	}

	const title = args.flags.title?.trim();
	if (!title) {
		exitUsage("--title is required");
	}

	const params: Record<string, unknown> = { projectId, title };
	if (args.flags.description) params.description = args.flags.description;

	const resp = await sendRequest(socketPath, "task.create", params);
	if (!resp.ok) exitError(resp.error || "Failed to create task");

	const task = resp.data as Task;
	process.stdout.write(`Created task ${task.id.slice(0, 8)} (seq ${task.seq}): ${task.title}\n`);
}

async function updateTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage("Usage: dev3 task update <id> --title '...' [--description '...']");
	}

	const params: Record<string, unknown> = { taskId };
	if (args.flags.project) params.projectId = args.flags.project;
	else if (context?.projectId) params.projectId = context.projectId;
	const trimmedTitle = args.flags.title?.trim();
	const trimmedDesc = args.flags.description?.trim();
	if (trimmedTitle) params.title = trimmedTitle;
	if (trimmedDesc) params.description = trimmedDesc;

	if (!params.title && !params.description) {
		exitUsage("Provide --title or --description to update");
	}

	const resp = await sendRequest(socketPath, "task.update", params);
	if (!resp.ok) exitError(resp.error || "Failed to update task");

	const task = resp.data as Task;
	process.stdout.write(`Updated task ${task.id.slice(0, 8)}: ${task.title}\n`);
}

async function moveTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage("Usage: dev3 task move <id> --status <status>");
	}

	const newStatus = args.flags.status;
	if (!newStatus) {
		exitUsage(`--status is required. Valid: ${CLI_ALLOWED_STATUSES.join(", ")}`);
	}
	if (DESTRUCTIVE_STATUSES.includes(newStatus as TaskStatus)) {
		exitError(
			`Cannot move to "${newStatus}" via CLI`,
			`This status destroys the worktree and terminal session.\nUse the desktop app UI to mark tasks as ${newStatus}.`,
		);
	}
	if (!CLI_ALLOWED_STATUSES.includes(newStatus as TaskStatus)) {
		exitUsage(`Invalid status: "${newStatus}". Valid: ${CLI_ALLOWED_STATUSES.join(", ")}`);
	}

	const params: Record<string, unknown> = { taskId, newStatus };
	if (args.flags.project) params.projectId = args.flags.project;
	else if (context?.projectId) params.projectId = context.projectId;

	const resp = await sendRequest(socketPath, "task.move", params);
	if (!resp.ok) exitError(resp.error || "Failed to move task");

	const task = resp.data as Task;
	process.stdout.write(`Moved task ${task.id.slice(0, 8)} → ${STATUS_LABELS[task.status] || task.status}\n`);
}

export async function handleTask(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case "show":
			return showTask(args, socketPath, context);
		case "create":
			return createTask(args, socketPath, context);
		case "update":
			return updateTask(args, socketPath, context);
		case "move":
			return moveTask(args, socketPath, context);
		default:
			exitUsage(
				`Unknown subcommand: task ${subcommand || "(none)"}` +
				"\nAvailable: task show, task create, task update, task move",
			);
	}
}
