import type { CliResponse, Task, TaskStatus, TaskHistoryEntry, TaskNote } from "../../shared/types";
import { STATUS_LABELS, ACTIVE_STATUSES, ALL_STATUSES, DEFAULT_PRIORITY, DRAFT_TASK_ACTIVATION_ERROR, getTaskTitle, getTaskOverview, normalizePriority } from "../../shared/types";
import { CLI_EXIT_CODE_COMPLETION_DECLINED, CLI_EXIT_CODE_LAUNCH_DECLINED, CLI_EXIT_CODE_TASK_IS_DRAFT } from "../../shared/cli-exit-codes";
import { CODEX_STOP_HOOK_FLAG, CODEX_STOP_HOOK_SUCCESS_JSON, TOLERATE_APP_OFFLINE_FLAG } from "../../shared/agent-hooks";
import { sendRequest } from "../socket-client";
import { printDetail, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { readStdin } from "../stdin";
import { handleTasks } from "./tasks";

// Statuses that destroy the worktree + terminal are not directly reachable via
// CLI. `completed` is special-cased: it becomes a blocking approval request the
// user answers in the app. `cancelled` stays fully forbidden — an agent must
// not be able to silently kill its own session.
const DESTRUCTIVE_STATUSES: TaskStatus[] = ["completed", "cancelled"];
const CLI_ALLOWED_STATUSES = ALL_STATUSES.filter((s) => !DESTRUCTIVE_STATUSES.includes(s));

// How long the CLI waits for the user to answer an approval dialog.
const COMPLETION_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const LAUNCH_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

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

/** Print a titled block of indented body lines, preceded by a blank line. */
function printSection(title: string, body: string): void {
	process.stdout.write(`\n${title}\n`);
	for (const line of body.split("\n")) {
		process.stdout.write(`  ${line}\n`);
	}
}

/** Describe what a history entry changed, for the inline log. */
function describeHistoryChange(changed: TaskHistoryEntry["changed"]): string {
	switch (changed) {
		case "created":
			return "created";
		case "title":
			return "title changed";
		case "overview":
			return "overview changed";
		case "both":
			return "title + overview changed";
		default:
			return changed;
	}
}

function printHistory(history: TaskHistoryEntry[]): void {
	process.stdout.write(`\nHistory (${history.length}):\n`);
	for (const entry of history) {
		process.stdout.write(`  ${formatDate(entry.at)}  [${describeHistoryChange(entry.changed)}]\n`);
		process.stdout.write(`    title:    ${entry.title}\n`);
		process.stdout.write(`    overview: ${entry.overview ?? "(none)"}\n`);
	}
}

function printNotes(notes: TaskNote[]): void {
	process.stdout.write(`\nNotes (${notes.length}):\n`);
	for (const note of notes) {
		process.stdout.write(`  [${note.id.slice(0, 8)}] ${note.source} · ${formatDate(note.createdAt)}\n`);
		for (const line of note.content.split("\n")) {
			process.stdout.write(`    ${line}\n`);
		}
	}
}

interface ShowTaskOptions {
	history?: boolean;
	notes?: boolean;
}

function printTask(task: Task, opts: ShowTaskOptions = {}): void {
	const titleMarker = task.titleEditedByUser ? " (user-edited — do NOT rename)" : "";
	const fields: Array<[string, string]> = [
		["ID:", task.id],
		["Seq:", String(task.seq)],
		["Title:", `${getTaskTitle(task)}${titleMarker}`],
		["Status:", STATUS_LABELS[task.status] || task.status],
		["Priority:", task.priority ?? DEFAULT_PRIORITY],
	];

	// Drafts are deliberately unfinished — say so before an agent reads the
	// half-written description and starts guessing.
	if (task.draft === true) fields.push(["Draft:", "yes — cannot be started until the user finishes it"]);

	if (task.branchName) fields.push(["Branch:", task.branchName]);
	if (task.worktreePath) fields.push(["Worktree:", task.worktreePath]);

	if (task.labelIds && task.labelIds.length > 0) {
		fields.push(["Labels:", task.labelIds.map((id) => id.slice(0, 8)).join(", ")]);
	}

	fields.push(["Created:", formatDate(task.createdAt)]);
	fields.push(["Updated:", formatDate(task.updatedAt)]);
	if (task.movedAt) fields.push(["Moved:", formatDate(task.movedAt)]);
	if (task.notes && task.notes.length > 0) fields.push(["Notes:", String(task.notes.length)]);
	if (task.manualCompletion === true) fields.push(["Manual completion:", "on"]);

	printDetail(fields);

	// Always surface the current effective overview — it is the freshest summary
	// of the task and is far more useful to an agent than the original prompt.
	const overview = getTaskOverview(task);
	if (overview) printSection("Overview:", overview);

	const showDescription = task.description && task.description !== task.title;
	if (showDescription) printSection("Description:", task.description);

	if (opts.notes && task.notes && task.notes.length > 0) printNotes(task.notes);
	if (opts.history && task.history && task.history.length > 0) printHistory(task.history);
}

function resolveTaskId(args: ParsedArgs, context: CliContext | null): string | undefined {
	const raw = args.positional[0] || args.flags.task || args.flags["task-id"] || args.flags.id || context?.taskId;
	if (!raw) return undefined;
	return expandShortId(raw, context);
}

async function showTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["id", "task", "task-id", "project", "history", "notes"]);
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage("Usage: dev3 task show <id|--task id|--task-id id|--id id> [--notes] [--history]");
	}

	const params: Record<string, unknown> = { taskId };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "task.show", params);
	if (!resp.ok) exitError(resp.error || "Failed to get task");

	printTask(resp.data as Task, {
		history: args.flags.history === "true",
		notes: args.flags.notes === "true",
	});
}

async function createTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "title", "description", "scratch", "run"]);
	const projectId = resolveProjectId(args.flags.project, context);
	if (!projectId) {
		exitUsage("--project <id> is required (or run from inside a worktree)");
	}

	const scratch = args.flags.scratch === "true";
	const run = args.flags.run === "true";
	if (scratch !== run) {
		exitUsage(
			"--scratch and --run go together: `dev3 task create --scratch --run` asks the user to launch a throwaway peer agent.\n" +
			"A scratch task has no prompt — talk to it with `dev3 message --task seq:<N>` once it starts.",
		);
	}
	if (scratch) {
		if (args.positional[0] || args.flags.title || args.flags.description) {
			exitUsage(
				"A scratch task takes no title or description — it has no prompt by design.\n" +
				"Create a normal task instead, or send instructions with `dev3 message --task seq:<N>` after it starts.",
			);
		}
		return createScratchAndRun(projectId, socketPath, context);
	}

	// A literal "-" is the conventional CLI sentinel for reading the value
	// from stdin. Read it only for the description flag so title-only creates
	// never consume an interactive shell's input unexpectedly.
	const stdinDescription = args.flags.description === "-" ? await readStdin() : undefined;
	const positionalContent = stdinDescription ?? args.positional[0]?.trim();

	let title = args.flags.title?.trim();
	if (!title && positionalContent) {
		// Extract first line as title from positional content (e.g. @file)
		const firstNewline = positionalContent.indexOf("\n");
		title = firstNewline === -1 ? positionalContent : positionalContent.slice(0, firstNewline).trim();
	}
	if (!title) {
		exitUsage("--title is required");
	}

	const description = args.flags.description === "-" ? stdinDescription : args.flags.description || positionalContent;

	const params: Record<string, unknown> = { projectId, title };
	if (description) params.description = description;

	const resp = await sendRequest(socketPath, "task.create", params);
	if (!resp.ok) exitError(resp.error || "Failed to create task");

	const task = resp.data as Task;
	process.stdout.write(`Created task ${task.id.slice(0, 8)} (seq ${task.seq}): ${getTaskTitle(task)}\n`);
}

async function updateTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["id", "task", "task-id", "project", "title", "description", "priority", "manual-completion", "force"]);
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage("Usage: dev3 task update <id|--task id|--task-id id|--id id> [--title '...'] [--description '...'] [--priority P0..P4] [--manual-completion on|off]");
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
		const description = rawDesc === "-" ? await readStdin() : rawDesc;
		params.description = description.trim();
	}
	const rawPriority = args.flags.priority;
	if (rawPriority !== undefined) {
		const normalized = normalizePriority(rawPriority);
		if (!normalized) exitUsage(`--priority must be one of P0, P1, P2, P3, P4 (got "${rawPriority}")`);
		params.priority = normalized;
	}
	const rawManualCompletion = args.flags["manual-completion"];
	if (rawManualCompletion !== undefined) {
		const normalized = rawManualCompletion.trim().toLowerCase();
		if (normalized !== "on" && normalized !== "off") {
			exitUsage(`--manual-completion must be on or off (got "${rawManualCompletion}")`);
		}
		params.manualCompletion = normalized === "on";
	}
	if (args.flags.force === "true") {
		params.force = true;
	}

	if (params.title === undefined && params.description === undefined && params.priority === undefined && rawManualCompletion === undefined) {
		exitUsage("Provide --title, --description, --priority, or --manual-completion to update");
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

/**
 * `dev3 task create --scratch --run`: ask the user to spin up a throwaway peer
 * agent. Blocks on the same approval dialog as an agent-initiated launch; the
 * app discards the placeholder task if the user declines.
 */
async function createScratchAndRun(
	projectId: string,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	if (!context?.taskId) {
		exitUsage("Run this from inside a task worktree — the new scratch task reports back to yours.");
	}

	let resp: CliResponse;
	try {
		resp = await sendRequest(socketPath, "task.createScratchAndRun", {
			projectId,
			sourceTaskId: context.taskId,
		}, { timeoutMs: LAUNCH_APPROVAL_TIMEOUT_MS });
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Socket timeout")) {
			exitError(
				"Timed out waiting for the user's decision",
				"The approval dialog may still be open in the app — if the user approves later, the scratch task starts anyway.",
			);
		}
		throw err;
	}
	if (!resp.ok) exitError(resp.error || "Failed to request a scratch task");
	if (!isLaunchApprovalOutcome(resp.data)) exitError("Unexpected response to the scratch launch request");
	reportLaunchOutcome(resp.data, false);
}

/** What the app returns once an agent-initiated launch went through the dialog. */
interface LaunchApprovalOutcome {
	approved: boolean;
	seq?: number;
	title?: string;
	replyCommand?: string;
}

function isLaunchApprovalOutcome(data: unknown): data is LaunchApprovalOutcome {
	return typeof data === "object" && data !== null && "approved" in data;
}

/**
 * True when this move is an agent asking to set a DIFFERENT task running — the
 * shape that detours through the approval dialog. A `seq:N` or id-prefix ref the
 * CLI cannot match against its own task counts as foreign: guessing "foreign"
 * only costs a longer socket timeout on a move that answers instantly anyway,
 * while guessing "own" would time the dialog out after 30 seconds.
 */
function movesForeignTaskIntoActiveColumn(
	taskRef: string,
	newStatus: string,
	context: CliContext | null,
): boolean {
	if (!context?.taskId) return false;
	if (!ACTIVE_STATUSES.includes(newStatus as TaskStatus)) return false;
	return taskRef !== context.taskId;
}

/** Print the result of an approved/declined launch, or exit with the decline code. */
function reportLaunchOutcome(outcome: LaunchApprovalOutcome, codexStopHook: boolean): void {
	if (!outcome.approved) {
		exitError(
			"User declined the launch request",
			"The task stays where it was and no agent was started.\nAsk the user what they want to change before requesting it again.",
			CLI_EXIT_CODE_LAUNCH_DECLINED,
		);
	}
	if (codexStopHook) {
		process.stdout.write(CODEX_STOP_HOOK_SUCCESS_JSON);
		return;
	}
	process.stdout.write(
		`User approved — task seq:${outcome.seq} is starting: ${outcome.title ?? ""}\n` +
		`Talk to it with: ${outcome.replyCommand ?? `dev3 message --task seq:${outcome.seq} "your message"`}\n` +
		"It knows you started it and will report back to this task.\n",
	);
}

async function moveTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	// `--tolerate-app-offline` only changes the app-offline exit code, which is
	// decided before dispatch (main.ts) — accepted and ignored here.
	rejectUnknownFlags(args, [
		"id", "task", "task-id", "project", "status", "if-status", "if-status-not",
		CODEX_STOP_HOOK_FLAG.slice(2), TOLERATE_APP_OFFLINE_FLAG.slice(2),
	]);
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
	// Running inside a worktree means an agent is moving the card. The app needs
	// to know which one: moving somebody else's task into a running column is a
	// launch, and a launch needs the user's approval and agent pick.
	if (context?.taskId) params.sourceTaskId = context.taskId;

	// The approval dialog can sit open for minutes, so a move that might turn
	// into one waits on the long timeout. A silent move still answers instantly.
	const resp = movesForeignTaskIntoActiveColumn(taskId, newStatus, context)
		? await sendRequest(socketPath, "task.move", params, { timeoutMs: LAUNCH_APPROVAL_TIMEOUT_MS })
		: await sendRequest(socketPath, "task.move", params);
	if (!resp.ok) {
		// A draft was deliberately parked by the human — give it its own exit code
		// so an agent can tell "not ready yet" apart from a real failure.
		if (resp.error?.includes(DRAFT_TASK_ACTIVATION_ERROR)) {
			exitError(
				resp.error,
				"Ask the user to finish the draft's description and save it as a normal task before starting work.",
				CLI_EXIT_CODE_TASK_IS_DRAFT,
			);
		}
		exitError(resp.error || "Failed to move task");
	}

	// The server answered with an approval outcome, not a moved task: this move
	// was an agent-initiated launch and went through the dialog.
	if (isLaunchApprovalOutcome(resp.data)) {
		return reportLaunchOutcome(resp.data, codexStopHook);
	}

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

/**
 * `dev3 task open [<id>]` — bring the running app to the front on a task, the
 * CLI twin of clicking a `dev3://task/<id>` link (and it works on every OS,
 * because nothing here needs a registered URL scheme).
 */
async function openTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["id", "task", "task-id", "project"]);
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage("Usage: dev3 task open <id|--task id|--task-id id|--id id> (or run inside a worktree)");
	}

	const params: Record<string, unknown> = { taskId };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "task.open", params);
	if (!resp.ok) exitError(resp.error || "Failed to open the task");

	const data = resp.data as { taskId: string; delivered: boolean; reopened?: boolean };
	if (!data.delivered) {
		process.stdout.write("App is running but has no window to navigate — nothing was opened.\n");
		return;
	}
	process.stdout.write(
		data.reopened
			? `Opening a window on task ${data.taskId.slice(0, 8)}.\n`
			: `Opened task ${data.taskId.slice(0, 8)} in the app.\n`,
	);
}

interface TerminalBackendReport {
	taskId: string;
	backend: "tmux" | "native";
	explicit: boolean;
	liveBackend: "tmux" | "native" | null;
}

/**
 * Inspect or flip which backend runs this task's PRIMARY terminal (seq 1292).
 *
 * Read-only without `--to`. `--to native` is the deliberate, reversible opt-in
 * that makes the next launch of this task use the native terminal host; tmux
 * stays the default for every task that never runs this command. The switch is
 * refused while a terminal is still live, because live state is never migrated
 * between backends.
 */
async function taskTerminalBackend(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["id", "task", "task-id", "project", "to"]);
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage("Usage: dev3 task terminal-backend <id|--task id> [--to tmux|native]");
	}

	const to = args.flags.to;
	if (to !== undefined && to !== "tmux" && to !== "native") {
		exitUsage(`--to must be tmux or native (got "${to}")`);
	}

	const params: Record<string, unknown> = { taskId };
	if (to !== undefined) params.to = to;
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "task.terminalBackend", params);
	if (!resp.ok) exitError(resp.error || "Failed to read the task terminal backend");

	const report = resp.data as TerminalBackendReport;
	const source = report.explicit ? "explicit" : "default (unmarked task)";
	if (to === undefined) {
		printDetail([
			["Task", report.taskId.slice(0, 8)],
			["Terminal backend", `${report.backend} — ${source}`],
			["Live session", report.liveBackend ?? "none"],
		]);
		return;
	}
	process.stdout.write(
		`Task ${report.taskId.slice(0, 8)} terminal backend → ${report.backend}\n` +
			"Takes effect on the next launch of this task.\n",
	);
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
		case "open":
			return openTask(args, socketPath, context);
		case "terminal-backend":
			return taskTerminalBackend(args, socketPath, context);
		case "list":
			// Alias: the enumerate command lives under the plural `tasks list`.
			// `task list` is a natural mistype, so forward it transparently.
			return handleTasks(subcommand, args, socketPath, context);
		default:
			exitUsage(
				`Unknown subcommand: task ${subcommand || "(none)"}` +
				"\nAvailable: task show, task create, task update, task move, task open, task terminal-backend",
			);
	}
}
