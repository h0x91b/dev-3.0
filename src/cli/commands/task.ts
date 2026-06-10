import type { CliResponse, Task, TaskStatus } from "../../shared/types";
import { STATUS_LABELS, ALL_STATUSES, getTaskTitle } from "../../shared/types";
import { CLI_EXIT_CODE_COMPLETION_DECLINED } from "../../shared/cli-exit-codes";
import { CODEX_STOP_HOOK_FLAG, CODEX_STOP_HOOK_SUCCESS_JSON } from "../../shared/agent-hooks";
import { sendRequest } from "../socket-client";
import { printDetail, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";

// Statuses that destroy the worktree + terminal are not directly reachable via
// CLI. `completed` is special-cased: it becomes a blocking approval request the
// user answers in the app. `cancelled` stays fully forbidden — an agent must
// not be able to silently kill its own session.
const DESTRUCTIVE_STATUSES: TaskStatus[] = ["completed", "cancelled"];
const CLI_ALLOWED_STATUSES = ALL_STATUSES.filter((s) => !DESTRUCTIVE_STATUSES.includes(s));

// How long the CLI waits for the user to answer the approval dialog.
const COMPLETION_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

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
	const titleMarker = task.titleEditedByUser ? " (user-edited — do NOT rename)" : "";
	const fields: Array<[string, string]> = [
		["ID:", task.id],
		["Seq:", String(task.seq)],
		["Title:", `${getTaskTitle(task)}${titleMarker}`],
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

	const showDescription = task.description && task.description !== task.title;
	if (showDescription) {
		fields.push(["", ""]);
		fields.push(["Description:", ""]);
	}

	printDetail(fields);

	if (showDescription) {
		for (const line of task.description.split("\n")) {
			process.stdout.write(`  ${line}\n`);
		}
	}
}

function resolveTaskId(args: ParsedArgs, context: CliContext | null): string | undefined {
	const raw = args.positional[0] || args.flags.task || args.flags["task-id"] || args.flags.id || context?.taskId;
	if (!raw) return undefined;
	return expandShortId(raw, context);
}

async function showTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["id", "task", "task-id", "project"]);
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage("Usage: dev3 task show <id|--task id|--task-id id|--id id>");
	}

	const params: Record<string, unknown> = { taskId };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "task.show", params);
	if (!resp.ok) exitError(resp.error || "Failed to get task");

	printTask(resp.data as Task);
}

async function createTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "title", "description"]);
	const projectId = resolveProjectId(args.flags.project, context);
	if (!projectId) {
		exitUsage("--project <id> is required (or run from inside a worktree)");
	}

	const positionalContent = args.positional[0]?.trim();

	let title = args.flags.title?.trim();
	if (!title && positionalContent) {
		// Extract first line as title from positional content (e.g. @file)
		const firstNewline = positionalContent.indexOf("\n");
		title = firstNewline === -1 ? positionalContent : positionalContent.slice(0, firstNewline).trim();
	}
	if (!title) {
		exitUsage("--title is required");
	}

	const description = args.flags.description || positionalContent;

	const params: Record<string, unknown> = { projectId, title };
	if (description) params.description = description;

	const resp = await sendRequest(socketPath, "task.create", params);
	if (!resp.ok) exitError(resp.error || "Failed to create task");

	const task = resp.data as Task;
	process.stdout.write(`Created task ${task.id.slice(0, 8)} (seq ${task.seq}): ${getTaskTitle(task)}\n`);
}

async function updateTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["id", "task", "task-id", "project", "title", "description", "force"]);
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage("Usage: dev3 task update <id|--task id|--task-id id|--id id> --title '...' [--description '...']");
	}

	const params: Record<string, unknown> = { taskId };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;
	// Tri-state semantics:
	//   flag absent           → leave field untouched (not in params)
	//   flag present+empty    → clear the field (empty string in params)
	//   flag present+non-empty → set the field (trimmed value in params)
	// Titles still require a non-empty value — clearing a title makes no sense,
	// so whitespace-only titles are rejected below.
	const rawTitle = args.flags.title;
	const rawDesc = args.flags.description;
	if (rawTitle !== undefined) {
		const trimmed = rawTitle.trim();
		if (!trimmed) exitUsage("--title cannot be empty");
		params.title = trimmed;
	}
	if (rawDesc !== undefined) {
		params.description = rawDesc.trim();
	}
	if (args.flags.force === "true") {
		params.force = true;
	}

	if (params.title === undefined && params.description === undefined) {
		exitUsage("Provide --title or --description to update");
	}

	const resp = await sendRequest(socketPath, "task.update", params);
	if (!resp.ok) exitError(resp.error || "Failed to update task");

	const result = resp.data as Task | { task: Task; titlePreserved?: boolean };
	const task = "task" in result ? result.task : result;
	const titlePreserved = "task" in result ? Boolean(result.titlePreserved) : false;
	if (titlePreserved) {
		process.stderr.write(
			`Note: title preserved — task ${task.id.slice(0, 8)} has a user-edited title that the CLI will not overwrite. Pass --force to override.\n`,
		);
	}
	process.stdout.write(`Updated task ${task.id.slice(0, 8)}: ${getTaskTitle(task)}\n`);
}

async function requestCompletion(
	taskId: string,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
	codexStopHook: boolean,
): Promise<void> {
	const params: Record<string, unknown> = { taskId };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;

	process.stderr.write(
		"Completing a task destroys its worktree and terminal session, so it requires user approval.\n" +
		"Waiting for the user to respond in the dev-3.0 app (up to 10 minutes)...\n",
	);

	let resp: CliResponse;
	try {
		resp = await sendRequest(socketPath, "task.requestCompletion", params, {
			timeoutMs: COMPLETION_APPROVAL_TIMEOUT_MS,
		});
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Socket timeout")) {
			exitError(
				"Timed out waiting for the user's decision",
				"The approval dialog may still be open in the app — if the user approves later, the task will complete and this session will be destroyed.",
			);
		}
		throw err;
	}
	if (!resp.ok) exitError(resp.error || "Failed to request task completion");

	const result = resp.data as { approved: boolean; task?: Task };
	if (!result.approved) {
		exitError(
			"User declined the completion request",
			"The task keeps its current status and this session stays alive.\nContinue working or ask the user what they want to change before completing.",
			CLI_EXIT_CODE_COMPLETION_DECLINED,
		);
	}

	if (codexStopHook) {
		process.stdout.write(CODEX_STOP_HOOK_SUCCESS_JSON);
		return;
	}
	process.stdout.write(
		`User approved — task ${(result.task?.id ?? taskId).slice(0, 8)} moved to Completed.\n` +
		"This worktree and terminal session are being destroyed now.\n",
	);
}

async function moveTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["id", "task", "task-id", "project", "status", "if-status", "if-status-not", CODEX_STOP_HOOK_FLAG.slice(2)]);
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage("Usage: dev3 task move <id|--task id|--task-id id|--id id> --status <status>");
	}

	const newStatus = args.flags.status;
	if (!newStatus) {
		exitUsage(`--status is required. Valid built-in: ${CLI_ALLOWED_STATUSES.join(", ")}; \`completed\` (asks the user for approval); or a custom column ID (see \`dev3 current\`)`);
	}
	if (newStatus === "cancelled") {
		exitError(
			`Cannot move to "cancelled" via CLI`,
			`This status destroys the worktree and terminal session.\nUse the desktop app UI to mark tasks as cancelled.`,
		);
	}
	// Non-built-in values may be custom column IDs — let the server validate

	const ifStatus = args.flags["if-status"];
	const ifStatusNot = args.flags["if-status-not"];
	const codexStopHook = args.flags[CODEX_STOP_HOOK_FLAG.slice(2)] === "true";

	// `completed` is not a direct move — it asks the user for approval in the
	// app and blocks until they answer (or the wait times out).
	if (newStatus === "completed") {
		return requestCompletion(taskId, args, socketPath, context, codexStopHook);
	}

	const params: Record<string, unknown> = { taskId, newStatus };
	if (ifStatus) params.ifStatus = ifStatus;
	if (ifStatusNot) params.ifStatusNot = ifStatusNot;
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "task.move", params);
	if (!resp.ok) exitError(resp.error || "Failed to move task");

	const task = resp.data as Task;
	if (codexStopHook) {
		// Codex Stop hooks may require a JSON object even on success.
		process.stdout.write(CODEX_STOP_HOOK_SUCCESS_JSON);
		return;
	}
	const displayStatus = task.customColumnId
		? `custom column ${task.customColumnId.slice(0, 8)}`
		: (STATUS_LABELS[task.status] || task.status);
	process.stdout.write(`Moved task ${task.id.slice(0, 8)} → ${displayStatus}\n`);
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
