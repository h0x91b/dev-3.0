import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CliResponse, Task, TaskStatus, TaskType, TaskHistoryEntry, TaskNote } from "../../shared/types";
import { STATUS_LABELS, ACTIVE_STATUSES, ALL_STATUSES, DEFAULT_PRIORITY, DRAFT_TASK_ACTIVATION_ERROR, TASK_REF_UNRESOLVED_PREFIX, TASK_TYPES, getTaskTitle, getTaskOverview, normalizePriority, normalizeTaskType, taskAgentSessionLooksLive, taskCompletesManually } from "../../shared/types";
import { CLI_EXIT_CODE_APPROVAL_OUTCOME_UNKNOWN, CLI_EXIT_CODE_APPROVAL_STILL_PENDING, CLI_EXIT_CODE_CANCELLATION_DECLINED, CLI_EXIT_CODE_COMPLETION_DECLINED, CLI_EXIT_CODE_LAUNCH_DECLINED, CLI_EXIT_CODE_TASK_IS_DRAFT, CLI_EXIT_CODE_TASK_REF_UNRESOLVED } from "../../shared/cli-exit-codes";
import { CODEX_STOP_HOOK_FLAG, CODEX_STOP_HOOK_SUCCESS_JSON, TOLERATE_APP_OFFLINE_FLAG } from "../../shared/agent-hooks";
import { sendRequest } from "../socket-client";
import { DESTRUCTIVE_APPROVAL_TARGET, isAgentApprovalNotAttached, type AgentApprovalStatus, type DestructiveApprovalKind } from "../../shared/agent-approval";
import { printDetail, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { readStdin } from "../stdin";
import { singleTextInput } from "../text-input";
import { handleTasks } from "./tasks";

// Statuses that destroy the worktree + terminal are never a direct CLI move.
// Both become a blocking approval request the user answers in the app, so an
// agent can neither complete nor kill its own session silently.
const DESTRUCTIVE_STATUSES: TaskStatus[] = ["completed", "cancelled"];
const CLI_ALLOWED_STATUSES = ALL_STATUSES.filter((s) => !DESTRUCTIVE_STATUSES.includes(s));

// How long the CLI waits for the user to answer an approval dialog.
const COMPLETION_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const LAUNCH_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
// Slack on top of the app's own auto-approve deadline, so the socket never gives
// up on the very timer it is waiting for.
const APPROVAL_TIMEOUT_GRACE_MS = 2 * 60 * 1000;

/**
 * How long to wait for a launch approval. The app's auto-approve delay is
 * configurable up to a day, and a fixed 10-minute socket timeout would kill the
 * waiting agent long before the timer it is waiting on fires — so ask the app
 * what its deadline is first. Cheap, non-blocking, and short-circuited: an app
 * that cannot answer leaves the baseline in place rather than blocking the move.
 */
async function launchApprovalTimeoutMs(socketPath: string): Promise<number> {
	try {
		const resp = await sendRequest(socketPath, "approval.policy", {}, {
			timeoutMs: 5_000,
			connectAttempts: 1,
		});
		if (!resp.ok) return LAUNCH_APPROVAL_TIMEOUT_MS;
		const policy = resp.data as { autoApproveMs?: unknown };
		const deadline = typeof policy.autoApproveMs === "number" ? policy.autoApproveMs : 0;
		if (!Number.isFinite(deadline) || deadline <= 0) return LAUNCH_APPROVAL_TIMEOUT_MS;
		return Math.max(LAUNCH_APPROVAL_TIMEOUT_MS, deadline + APPROVAL_TIMEOUT_GRACE_MS);
	} catch {
		return LAUNCH_APPROVAL_TIMEOUT_MS;
	}
}

/**
 * The one reading of `--type` for every command that takes it, so `task create`
 * and `task update` can never accept different spellings of the same three
 * roles. `standard` (and its aliases) means "no type" and maps to null.
 */
function parseTypeFlag(raw: string): TaskType | null {
	const value = raw.trim().toLowerCase();
	if (value === "standard" || value === "none" || value === "") return null;
	const normalized = normalizeTaskType(value);
	if (!normalized) exitUsage(`--type must be one of ${TASK_TYPES.join(", ")} or standard (got "${raw}")`);
	return normalized;
}

/**
 * Read `--handoff-file <path>`: the launcher's own standing instructions, appended
 * to the handoff note every task it starts receives. The file is read HERE rather
 * than server-side so a wrong path fails on the launcher's own terminal instead of
 * silently reaching nobody. Absent flag ⇒ undefined, and the child gets the default
 * note alone.
 */
function readHandoffFile(args: ParsedArgs): string | undefined {
	const raw = args.flags["handoff-file"]?.trim();
	if (!raw) return undefined;
	const path = resolve(raw);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		exitUsage(`--handoff-file: cannot read ${path}`);
	}
	if (!text.trim()) exitUsage(`--handoff-file: ${path} is empty`);
	return text.trim();
}

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
	if (task.taskType) {
		fields.push([
			"Type:",
			task.taskType === "coordinator"
				? "coordinator — manages other tasks, never auto-completes, sorts above every priority"
				: task.taskType === "pr-review"
					? "pr-review — reviews someone else's changes on this branch"
					: task.taskType,
		]);
	}
	// A coordinator owns its completion whether or not the flag is set.
	if (taskCompletesManually(task)) fields.push(["Manual completion:", "on"]);

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
	rejectUnknownFlags(args, ["project", "title", "description", "type", "scratch", "run", "pr", "branch", "handoff-file"]);
	const projectId = resolveProjectId(args.flags.project, context);
	if (!projectId) {
		exitUsage("--project <id> is required (or run from the project's worktree or checkout)");
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
		if (args.positional[0] || args.flags.title || args.flags.description || args.flags.type || args.flags.pr || args.flags.branch) {
			exitUsage(
				"A scratch task takes no title, description or type — it has no prompt by design.\n" +
				"Create a normal task instead, or send instructions with `dev3 message --task seq:<N>` after it starts.",
			);
		}
		return createScratchAndRun(projectId, socketPath, context, readHandoffFile(args));
	}
	if (args.flags["handoff-file"] !== undefined) {
		exitUsage("--handoff-file only applies to a launch: `task create --scratch --run` or `task move --status in-progress`.");
	}

	const prFlag = args.flags.pr?.trim();
	const branchFlag = args.flags.branch?.trim();
	if (prFlag && branchFlag) {
		exitUsage("--pr and --branch name the same thing two ways — pass one of them.");
	}

	// Read before the title check so a bad --type fails on its own message.
	// `--pr` means the task is about someone's pull request, which is what
	// pr-review is; the GUI flips the same switch when a PR is resolved there.
	const taskType = args.flags.type === undefined
		? (prFlag ? "pr-review" as const : null)
		: parseTypeFlag(args.flags.type);

	// A literal "-" is the conventional CLI sentinel for reading the value
	// from stdin. Read it only for the description flag so title-only creates
	// never consume an interactive shell's input unexpectedly.
	const rawDescription = singleTextInput(args, "description");
	const stdinDescription = rawDescription === "-" ? await readStdin() : undefined;
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
	if (taskType) params.taskType = taskType;
	if (prFlag) params.pr = prFlag;
	if (branchFlag) params.branch = branchFlag;

	const resp = await sendRequest(socketPath, "task.create", params);
	if (!resp.ok) {
		// An unresolvable --pr/--branch created NOTHING, and it is not the same
		// failure as "the task could not be written".
		const marker = resp.error?.indexOf(TASK_REF_UNRESOLVED_PREFIX) ?? -1;
		if (marker >= 0 && resp.error) {
			exitError(
				resp.error.slice(marker + TASK_REF_UNRESOLVED_PREFIX.length),
				"No task was created.",
				CLI_EXIT_CODE_TASK_REF_UNRESOLVED,
			);
		}
		exitError(resp.error || "Failed to create task");
	}

	const task = resp.data as Task;
	process.stdout.write(`Created task ${task.id.slice(0, 8)} (seq ${task.seq}): ${getTaskTitle(task)}\n`);
	// The type is only real once the role brief is in the description the agent
	// will read, so name it rather than leaving the caller to check the card.
	if (task.taskType) {
		process.stderr.write(`Role: ${task.taskType} — created with its role brief already in the description.\n`);
	}
	// Where the worktree will sit is the whole difference between a review task
	// that can read the diff and one stranded on the base branch — say it.
	if (task.existingBranch) {
		process.stderr.write(
			`Starts on: ${task.existingBranch}${task.foreignCode ? " (someone else's code — the branch's own scripts and MCP config are ignored)" : ""}\n`,
		);
	}
}

async function updateTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["id", "task", "task-id", "project", "title", "description", "priority", "manual-completion", "type", "force", "print-role"]);
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage("Usage: dev3 task update <id|--task id|--task-id id|--id id> [--title '...'] [--description '...'] [--priority P0..P4] [--manual-completion on|off] [--type coordinator|pr-review|standard]");
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
		// A bare flag parses as "true"; storing that would overwrite the real description.
		if (rawDesc === "true") exitUsage('--description needs the text as its value (--description - reads stdin, "" clears it).');
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
	const rawType = args.flags.type;
	if (rawType !== undefined) params.taskType = parseTypeFlag(rawType);
	if (args.flags.force === "true") {
		params.force = true;
	}
	// `--print-role` means "I am the agent of this task, hand me my new brief here".
	// Only the task this worktree auto-detects can say that, so an explicit selector
	// is a usage error rather than a silently skipped delivery to somebody else.
	const printRole = args.flags["print-role"] === "true";
	if (printRole) {
		if (rawType === undefined) exitUsage("--print-role only applies together with --type");
		if (args.positional[0] || args.flags.task || args.flags["task-id"] || args.flags.id) {
			exitUsage("--print-role prints YOUR OWN task's role brief, so it cannot target another task");
		}
		params.printRole = true;
	}

	if (
		params.title === undefined
		&& params.description === undefined
		&& params.priority === undefined
		&& rawManualCompletion === undefined
		&& rawType === undefined
	) {
		exitUsage("Provide --title, --description, --priority, --manual-completion, or --type to update");
	}

	const resp = await sendRequest(socketPath, "task.update", params);
	if (!resp.ok) exitError(resp.error || "Failed to update task");

	const result = resp.data as Task | { task: Task; titlePreserved?: boolean; roleDelivery?: string; rolePrompt?: string };
	const task = "task" in result ? result.task : result;
	const titlePreserved = "task" in result ? Boolean(result.titlePreserved) : false;
	// A role change is only real once the agent behind the badge has been told, so
	// say plainly which of the three answers the backend could give.
	const roleDelivery = "task" in result ? result.roleDelivery : undefined;
	if (roleDelivery) {
		const role = task.taskType ?? "standard";
		const note = roleDelivery === "delivered"
			? `told the running agent it is now ${role}`
			: roleDelivery === "printed"
				? `printed below instead of typed into your own pane`
				: roleDelivery === "unconfirmed"
				? `sent the role change to the running agent, but the backend cannot confirm it landed — check the pane before relying on it`
				: roleDelivery === "no-session"
					? `no running agent to tell; it reads the new role from the description when it starts`
					: `could NOT tell the running agent — it will keep behaving as before until you paste the new role in yourself`;
		process.stderr.write(`Role: ${role} — ${note}.\n`);
	}
	if (titlePreserved) {
		process.stderr.write(
			`Note: title preserved — task ${task.id.slice(0, 8)} has a user-edited title that the CLI will not overwrite. Pass --force to override.\n`,
		);
	}
	process.stdout.write(`Updated task ${task.id.slice(0, 8)}: ${getTaskTitle(task)}\n`);
	// The role brief goes to stdout as the command's payload: the agent that ran it
	// reads it right here, and re-running prints the same text whether or not the
	// type had to change.
	const rolePrompt = "task" in result ? result.rolePrompt : undefined;
	if (rolePrompt !== undefined) {
		const role = task.taskType ?? "standard";
		process.stdout.write(
			rolePrompt
				? `\nYour role is now ${role}. Everything below is your standing instruction from here on, and it replaces any earlier instruction about what this task is.\n\n${rolePrompt}\n`
				: `\nThis task no longer carries a special role — you are an ordinary task agent again and may do the work yourself.\n`,
		);
	}
	// The trap this exists for: a description is the agent's first prompt at
	// launch and nothing re-delivers it, so rewriting a live task's brief reaches
	// the board and not the agent. Docs are read once; the mistake happens here.
	if (params.description !== undefined && taskAgentSessionLooksLive(task)) {
		const projectFlag = args.flags.project ? ` --project ${args.flags.project}` : "";
		process.stdout.write(
			`Note: the running agent will NOT see this — a description is delivered as its first prompt at launch, and nothing re-delivers it.\n`
			+ `Tell it too: dev3 message --task ${task.id.slice(0, 8)}${projectFlag} --subject "brief updated" "<what changed>"\n`,
		);
	}
}

/**
 * Does this approval target the task this session is running in?
 *
 * Only then does approving destroy THIS worktree — every other target belongs to
 * another task (`--task seq:N`, `--project <other>`), and telling the agent its
 * own session is about to die is simply false (h0x91b/dev-3.0#1669). Proof-based
 * on purpose: an unresolvable reference (`seq:2`, a short id from another
 * project) counts as "not proven", and the wording then says nothing about this
 * session rather than guessing.
 */
function targetsOwnSession(taskId: string, args: ParsedArgs, context: CliContext | null): boolean {
	if (!context?.taskId) return false;
	const projectFlag = args.flags.project;
	if (projectFlag && projectFlag !== context.projectId) return false;
	return taskId === context.taskId;
}

/** Everything that differs between the completion and the cancellation approval. */
interface DestructiveApprovalSpec {
	kind: DestructiveApprovalKind;
	method: "task.requestCompletion" | "task.requestCancellation";
	label: string;
	intro: string;
	lateOwn: string;
	lateOther: string;
	declined: string;
	declinedHint: string;
	declinedCode: number;
	failed: string;
}

const COMPLETION_APPROVAL: DestructiveApprovalSpec = {
	kind: "complete",
	method: "task.requestCompletion",
	label: "Completed",
	intro: "Completing a task destroys its worktree and terminal session, so it requires user approval.",
	lateOwn: "if the user approves later, the task will complete and this session will be destroyed.",
	lateOther: "if the user approves later, that task completes and its worktree is destroyed. This session is not the target.",
	declined: "User declined the completion request",
	declinedHint: "The task keeps its current status and this session stays alive.\nContinue working or ask the user what they want to change before completing.",
	declinedCode: CLI_EXIT_CODE_COMPLETION_DECLINED,
	failed: "Failed to request task completion",
};

const CANCELLATION_APPROVAL: DestructiveApprovalSpec = {
	kind: "cancel",
	method: "task.requestCancellation",
	label: "Cancelled",
	intro: "Cancelling a task throws its work away — branch, worktree and everything uncommitted in it — so it requires user approval.",
	lateOwn: "if the user approves later, the task will be cancelled and this session will be destroyed.",
	lateOther: "if the user approves later, that task is cancelled and its worktree destroyed. This session is not the target.",
	declined: "User declined the cancellation request",
	declinedHint: "The task keeps its current status and this session stays alive.\nAsk the user what they want done with it instead of retrying.",
	declinedCode: CLI_EXIT_CODE_CANCELLATION_DECLINED,
	failed: "Failed to request task cancellation",
};

// After the socket drops mid-wait, how long the CLI keeps trying to reach the
// same app again (a dev-server restart takes a few seconds), and how often.
const APPROVAL_REATTACH_WINDOW_MS = 60_000;
const APPROVAL_REATTACH_INTERVAL_MS = 2_000;
const APPROVAL_STATUS_TIMEOUT_MS = 5_000;

/**
 * The connection closed or reset AFTER it was accepted, so the app may well
 * hold the request. Distinct from a refused connect (APP_NOT_RUNNING), where
 * nothing was ever sent. Matched by name/code so it survives module mocks.
 */
function isApprovalTransportLoss(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const code = (err as NodeJS.ErrnoException).code;
	return err.name === "EmptyResponseError" || code === "ECONNRESET" || code === "EPIPE";
}

function isSocketTimeout(err: unknown): boolean {
	return err instanceof Error && err.message.startsWith("Socket timeout");
}

/** Read-only probe. Null when the app cannot say (unreachable, or too old to know the method). */
async function probeApprovalStatus(
	socketPath: string,
	kind: DestructiveApprovalKind,
	params: Record<string, unknown>,
): Promise<AgentApprovalStatus | null> {
	try {
		const resp = await sendRequest(socketPath, "approval.status", { ...params, kind }, {
			timeoutMs: APPROVAL_STATUS_TIMEOUT_MS,
		});
		return resp.ok ? resp.data as AgentApprovalStatus : null;
	} catch {
		return null;
	}
}

type ApprovalWait =
	| { kind: "response"; resp: CliResponse }
	| { kind: "status"; status: AgentApprovalStatus; timedOut: boolean }
	| { kind: "unreachable"; timedOut: boolean };

/**
 * Wait for the user's answer, surviving a socket that drops mid-wait.
 *
 * The request lives in the app, not on this connection, so a dropped socket
 * says nothing about it. The CLI asks the same app where it stands and, if it
 * is still pending, re-attaches with `attachOnly` — which joins that request
 * and can never open a new dialog. The status probe goes first on purpose: an
 * app too old to know `attachOnly` would read the re-attach as a fresh ask.
 * The overall deadline is the original one; a re-attach never extends it.
 */
async function waitForDestructiveApproval(
	spec: DestructiveApprovalSpec,
	params: Record<string, unknown>,
	socketPath: string,
): Promise<ApprovalWait> {
	const deadline = Date.now() + COMPLETION_APPROVAL_TIMEOUT_MS;
	let attachOnly = false;
	let lostAt: number | null = null;

	for (;;) {
		try {
			const resp = await sendRequest(socketPath, spec.method, attachOnly ? { ...params, attachOnly: true } : params, {
				timeoutMs: attachOnly ? Math.max(1, deadline - Date.now()) : COMPLETION_APPROVAL_TIMEOUT_MS,
			});
			if (resp.ok && isAgentApprovalNotAttached(resp.data)) {
				return { kind: "status", status: resp.data.status, timedOut: false };
			}
			return { kind: "response", resp };
		} catch (err) {
			if (isSocketTimeout(err)) {
				const status = await probeApprovalStatus(socketPath, spec.kind, params);
				return status ? { kind: "status", status, timedOut: true } : { kind: "unreachable", timedOut: true };
			}
			const lost = isApprovalTransportLoss(err) || (lostAt !== null && err instanceof Error && err.message === "APP_NOT_RUNNING");
			if (!lost) throw err;
		}

		lostAt ??= Date.now();
		for (;;) {
			const status = await probeApprovalStatus(socketPath, spec.kind, params);
			if (status && status.state !== "pending") return { kind: "status", status, timedOut: false };
			if (status) break;
			if (Date.now() - lostAt >= APPROVAL_REATTACH_WINDOW_MS || Date.now() >= deadline) {
				return { kind: "unreachable", timedOut: false };
			}
			await new Promise((r) => setTimeout(r, APPROVAL_REATTACH_INTERVAL_MS));
		}
		if (!attachOnly) {
			process.stderr.write("The connection to the app dropped; the request is still pending there — waiting on it again.\n");
		}
		attachOnly = true;
		lostAt = null;
	}
}

function reportApproved(spec: DestructiveApprovalSpec, taskRef: string, task: Task | undefined, ownSession: boolean, context: CliContext | null): void {
	process.stdout.write(
		`User approved — task ${(task?.id ?? taskRef).slice(0, 8)} moved to ${spec.label}.\n` +
		(task?.id === context?.taskId || (!task && ownSession)
			? "This worktree and terminal session are being destroyed now.\n"
			: "Its worktree and terminal session are being destroyed now; this session is unaffected.\n"),
	);
}

/**
 * Map the app's own record of the request onto an exit. Every branch says only
 * what the record proves: no record is NOT a decline, and only the task's live
 * status says whether the move happened.
 */
function reportApprovalStatus(
	spec: DestructiveApprovalSpec,
	status: AgentApprovalStatus,
	timedOut: boolean,
	ownSession: boolean,
	codexStopHook: boolean,
): void {
	const target = DESTRUCTIVE_APPROVAL_TARGET[spec.kind];
	if (status.state === "answered" && !status.approved) {
		exitError(spec.declined, spec.declinedHint, spec.declinedCode);
	}
	if (status.taskStatus === target) {
		if (codexStopHook) {
			process.stdout.write(CODEX_STOP_HOOK_SUCCESS_JSON);
			return;
		}
		process.stdout.write(
			status.state === "answered"
				? `User approved — the task is now ${spec.label}. The answer arrived while this CLI was disconnected.\n`
				: `The task is now ${spec.label}. The app has no record of how the request was answered, only that the task moved.\n`,
		);
		return;
	}
	if (status.state === "pending") {
		exitError(
			timedOut ? "Timed out waiting for the user's decision — the request is still pending" : "The approval request is still pending",
			`The dialog is still open in the app — ${ownSession ? spec.lateOwn : spec.lateOther}\n` +
			"Running the same command again waits on that same request; it does not open a second dialog.",
			CLI_EXIT_CODE_APPROVAL_STILL_PENDING,
		);
	}
	if (status.state === "answered") {
		// Approved, but the task is not (yet) in the target status: the move itself
		// is the app's to report, and this CLI must not claim it happened.
		exitError(
			`The user approved, but the task is ${STATUS_LABELS[status.taskStatus] || status.taskStatus}, not ${spec.label}`,
			"The approval was recorded while this CLI was disconnected; the move did not land (yet). Check the task before asking again.",
		);
	}
	exitError(
		"The approval request's outcome is unknown",
		`The app has no record of this request — it restarted, the record aged out, or the request never arrived — and the task is ${STATUS_LABELS[status.taskStatus] || status.taskStatus}, not ${spec.label}.\n` +
		"That is not evidence that the user declined or never saw it. Asking again opens a NEW dialog, so check with the user first.",
		CLI_EXIT_CODE_APPROVAL_OUTCOME_UNKNOWN,
	);
}

/**
 * `dev3 task move --status completed|cancelled`: ask the user, block on the
 * dialog, and report exactly what the app knows. Two kinds with their own exit
 * codes, because "the work landed" and "the work is garbage" are answers an
 * agent must be able to tell apart.
 */
async function requestDestructiveApproval(
	spec: DestructiveApprovalSpec,
	taskId: string,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
	codexStopHook: boolean,
): Promise<void> {
	const params: Record<string, unknown> = { taskId };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;
	const ownSession = targetsOwnSession(taskId, args, context);

	process.stderr.write(`${spec.intro}\nWaiting for the user to respond in the dev-3.0 app (up to 10 minutes)...\n`);

	const wait = await waitForDestructiveApproval(spec, params, socketPath);
	if (wait.kind === "status") return reportApprovalStatus(spec, wait.status, wait.timedOut, ownSession, codexStopHook);
	if (wait.kind === "unreachable") {
		if (wait.timedOut) {
			exitError("Timed out waiting for the user's decision", `The approval dialog may still be open in the app — ${ownSession ? spec.lateOwn : spec.lateOther}`);
		}
		exitError(
			"The approval request's outcome is unknown",
			"The connection to the app dropped mid-wait and the app could not be reached again to ask where the request stands.\n" +
			"Nothing here says whether it was answered. Check `dev3 task show` for the task's status before asking again — a new request opens a new dialog.",
			CLI_EXIT_CODE_APPROVAL_OUTCOME_UNKNOWN,
		);
	}

	const resp = wait.resp;
	if (!resp.ok) exitError(resp.error || spec.failed);
	const result = resp.data as { approved: boolean; task?: Task };
	if (!result.approved) exitError(spec.declined, spec.declinedHint, spec.declinedCode);
	if (codexStopHook) {
		process.stdout.write(CODEX_STOP_HOOK_SUCCESS_JSON);
		return;
	}
	reportApproved(spec, taskId, result.task, ownSession, context);
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
	handoffNote?: string,
): Promise<void> {
	if (!context?.taskId) {
		exitUsage("Run this from inside a task worktree — the new scratch task reports back to yours.");
	}

	let resp: CliResponse;
	try {
		resp = await sendRequest(socketPath, "task.createScratchAndRun", {
			projectId,
			sourceTaskId: context.taskId,
			...(handoffNote ? { handoffNote } : {}),
		}, { timeoutMs: await launchApprovalTimeoutMs(socketPath) });
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
	/** One entry per task that started, in variant order; length 1 for a plain launch. */
	launched?: Array<{ variantIndex: number | null; replyCommand: string }>;
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
	const launched = outcome.launched ?? [];
	const fallback = `dev3 message --task seq:${outcome.seq} --subject "what this is about" "your message"`;
	if (launched.length > 1) {
		// The user turned one launch into a variant group. Every sibling shares
		// `seq:<N>`, so that handle is ambiguous and each address is per-task —
		// hand out all of them rather than picking one and looking like the only.
		const rows = launched
			.map((entry, i) => `  variant #${entry.variantIndex ?? i + 1}  ${entry.replyCommand}`)
			.join("\n");
		process.stdout.write(
			`User approved — seq:${outcome.seq} is starting as ${launched.length} variants: ${outcome.title ?? ""}\n` +
			`They all share seq:${outcome.seq}, so address each one by its own id:\n` +
			`${rows}\n` +
			"They are independent agents on the same prompt. Each knows you started it and reports back to this task.\n",
		);
		return;
	}
	process.stdout.write(
		`User approved — task seq:${outcome.seq} is starting: ${outcome.title ?? ""}\n` +
		`Talk to it with: ${launched[0]?.replyCommand ?? fallback}\n` +
		"It knows you started it and will report back to this task.\n",
	);
}

async function moveTask(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	// `--tolerate-app-offline` only changes the app-offline exit code, which is
	// decided before dispatch (main.ts) — accepted and ignored here.
	rejectUnknownFlags(args, [
		"id", "task", "task-id", "project", "status", "if-status", "if-status-not", "handoff-file",
		CODEX_STOP_HOOK_FLAG.slice(2), TOLERATE_APP_OFFLINE_FLAG.slice(2),
	]);
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage("Usage: dev3 task move <id|--task id|--task-id id|--id id> --status <status>");
	}

	const newStatus = args.flags.status;
	if (!newStatus) {
		exitUsage(`--status is required. Valid built-in: ${CLI_ALLOWED_STATUSES.join(", ")}; \`completed\` and \`cancelled\` (both ask the user for approval); or a custom column ID (see \`dev3 current\`)`);
	}
	// Non-built-in values may be custom column IDs — let the server validate

	const ifStatus = args.flags["if-status"];
	const ifStatusNot = args.flags["if-status-not"];
	const codexStopHook = args.flags[CODEX_STOP_HOOK_FLAG.slice(2)] === "true";

	// `completed` is not a direct move — it asks the user for approval in the
	// app and blocks until they answer (or the wait times out).
	if (newStatus === "completed") {
		return requestDestructiveApproval(COMPLETION_APPROVAL, taskId, args, socketPath, context, codexStopHook);
	}

	// `cancelled` is the same deal, and the dialog behind it is deliberately a
	// red one: cancelling is an agent throwing its own task away, not reporting
	// it done.
	if (newStatus === "cancelled") {
		return requestDestructiveApproval(CANCELLATION_APPROVAL, taskId, args, socketPath, context, false);
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
	// Only used when this move turns out to be a launch; a same-task status move
	// carries it and the server ignores it.
	const handoffNote = readHandoffFile(args);
	if (handoffNote) params.handoffNote = handoffNote;

	// The approval dialog can sit open for minutes, so a move that might turn
	// into one waits on the long timeout. A silent move still answers instantly.
	const resp = movesForeignTaskIntoActiveColumn(taskId, newStatus, context)
		? await sendRequest(socketPath, "task.move", params, { timeoutMs: await launchApprovalTimeoutMs(socketPath) })
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
