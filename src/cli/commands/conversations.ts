import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Task, TaskHistoryEntry, TaskStatus } from "../../shared/types";
import { ALL_STATUSES } from "../../shared/types";
import { projectSlug } from "../../shared/conversation-search-core";
import { toPosixSeparators } from "../../shared/project-storage-key";
import { searchConversations, type EngineTask } from "../../bun/conversation-search";
import {
	conversationDumpDir,
	conversationDumpName,
	parseWorktreeConversations,
	taskContainerDir,
	writeConversationDump,
} from "../../bun/conversation-parse";
import { renderHandoff } from "../../shared/conversation-render";
import { resolveDev3Home } from "../../shared/dev3-home";
import { resolveUserHome } from "../../shared/user-home";
import { scanImportableConversations } from "../../bun/conversation-import";
import { CONVERSATION_SOURCE_LABELS, type ImportConversationsResult } from "../../shared/conversation-import-model";
import { sendRequest } from "../socket-client";
import { DEFAULT_DUMP_BUDGET, type DumpBudget } from "../../shared/conversation-dump";
import { atomicWriteFile } from "../../bun/atomic-write";
import type { ParsedArgs } from "../args";
import {
	detectFromWorktreePath,
	projectOwningCwd,
	readProjectDirect,
	resolveProjectId,
	type CliContext,
	type ProjectDirect,
} from "../context";
import { exitError, exitUsage, printTable } from "../output";
import { rejectUnknownFlags } from "../flag-validation";
import { CLI_EXIT_CODE_NO_PROJECT_FOR_CWD } from "../../shared/cli-exit-codes";

const DEV3_DIR = "/.dev3.0";

/** Marker that appears in every virtual ("Operations") task working dir. */
const OPS_MARKER = "/.dev3.0/ops/";

/**
 * The user home (where `~/.claude` lives) and the data root of the board being
 * addressed. Two different questions: a redirected instance keeps its board
 * elsewhere while its agents still write transcripts into the real home.
 *
 * A cwd inside a worktree outranks `$DEV3_HOME` for the DATA ROOT by design —
 * that is how the CLI decides which board a worktree belongs to. Everywhere else
 * the resolver wins; reading `HOME` directly here is what made a redirected board
 * invisible, so the dry-run re-offered conversations another instance had already
 * imported.
 *
 * The HOME is the other way round: a `<home>/.dev3.0/worktrees/…` cwd spells the
 * real one, and it outranks `$HOME` because the Codex sandbox rewrites `$HOME` to
 * `/tmp` while `~/.claude` stays where it was. A redirected root not named
 * `.dev3.0` says nothing about the home, so the resolver answers there.
 */
export function resolveHomes(cwd: string = process.cwd()): { home: string; dev3Home: string } {
	const info = detectFromWorktreePath(cwd);
	const homeFromWorktree = info?.realDev3Home.endsWith(DEV3_DIR)
		? info.realDev3Home.slice(0, -DEV3_DIR.length)
		: null;
	return { home: homeFromWorktree || resolveUserHome(), dev3Home: info?.realDev3Home ?? resolveDev3Home() };
}

function loadProjectTasks(dev3Home: string, slug: string): Task[] {
	const tasksFile = `${dev3Home}/data/${slug}/tasks.json`;
	if (!existsSync(tasksFile)) return [];
	try {
		return JSON.parse(readFileSync(tasksFile, "utf-8")) as Task[];
	} catch {
		return [];
	}
}

/**
 * Title/overview history moved out of tasks.json into per-task sidecars, and
 * this command reads the store directly rather than through the app. Reading the
 * blob directory once keeps the search's history signal intact; a missing or
 * unparseable sidecar just contributes nothing.
 */
export function loadArchivedHistory(dev3Home: string, slug: string): Map<string, TaskHistoryEntry[]> {
	const byTask = new Map<string, TaskHistoryEntry[]>();
	const dir = `${dev3Home}/data/${slug}/task-blobs`;
	if (!existsSync(dir)) return byTask;
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".json")) continue;
		try {
			const blob = JSON.parse(readFileSync(`${dir}/${entry}`, "utf-8")) as { taskId?: string; history?: TaskHistoryEntry[] };
			if (blob.taskId && blob.history?.length) byTask.set(blob.taskId, blob.history);
		} catch {
			// A half-written sidecar is not worth failing a search over.
		}
	}
	return byTask;
}

async function searchCmd(args: ParsedArgs, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["limit", "all-statuses", "json", "project", "task", "task-id"]);

	const query = (args.positional[0] || "").trim();
	if (!query) {
		exitUsage('Usage: dev3 conversations search "<query>" [--limit N] [--all-statuses] [--json]');
	}

	const projectId = resolveProjectId(args.flags.project, context);
	if (!projectId) {
		exitError("Could not determine project. Run from inside a worktree or pass --project <id>.");
	}
	const project = readProjectDirect(projectId);
	if (!project) {
		exitError(`Project not found: ${projectId}`);
	}

	const { home, dev3Home } = resolveHomes();
	const slug = projectSlug(project.path);
	const tasks = loadProjectTasks(dev3Home, slug);

	const currentTaskId = (args.flags.task || args.flags["task-id"] || context?.taskId) ?? null;
	const currentTask = currentTaskId ? tasks.find((t) => t.id === currentTaskId || t.id.startsWith(currentTaskId)) : null;
	const currentGroupId = currentTask?.groupId ?? null;
	const resolvedCurrentId = currentTask?.id ?? currentTaskId;

	const limit = args.flags.limit ? Math.max(1, parseInt(args.flags.limit, 10) || 5) : 5;
	const allStatuses = args.flags["all-statuses"] === "true";
	const statuses: TaskStatus[] | undefined = allStatuses ? [...ALL_STATUSES] : undefined;

	const archivedHistory = loadArchivedHistory(dev3Home, slug);

	const engineTasks: EngineTask[] = tasks.map((t) => ({
		id: t.id,
		title: t.title,
		description: t.description,
		overview: t.overview,
		userOverview: t.userOverview,
		notes: (t.notes ?? []).map((n) => n.content),
		historyTexts: [...(t.history ?? []), ...(archivedHistory.get(t.id) ?? [])]
			.flatMap((h) => [h.title, h.overview])
			.filter((s): s is string => !!s),
		status: t.status,
		groupId: t.groupId,
		agentId: t.agentId,
	}));

	const results = searchConversations({
		query,
		tasks: engineTasks,
		projectSlug: slug,
		currentTaskId: resolvedCurrentId,
		currentGroupId,
		statuses,
		limit,
		home,
		dev3Home,
	});

	if (args.flags.json === "true") {
		process.stdout.write(JSON.stringify(results, null, 2) + "\n");
		return;
	}

	if (results.length === 0) {
		process.stdout.write(`No matching conversations for "${query}".\n`);
		return;
	}

	process.stdout.write(`Top ${results.length} past conversation(s) for "${query}":\n\n`);
	results.forEach((r, i) => {
		const title = r.title || "(untitled)";
		process.stdout.write(`[${i + 1}] ${r.taskId.slice(0, 8)}  ${r.status}  score=${r.score.toFixed(1)}\n`);
		process.stdout.write(`    ${title}\n`);
		for (const path of r.transcriptPaths.slice(0, 1)) {
			process.stdout.write(`    transcript: ${path}\n`);
		}
		for (const snippet of r.snippets) {
			process.stdout.write(`    › ${snippet}\n`);
		}
		process.stdout.write("\n");
	});
}

/** Parse a numeric flag, rejecting garbage rather than silently defaulting. */
function numberFlag(raw: string | undefined, fallback: number, label: string): number {
	if (raw === undefined) return fallback;
	const value = Number.parseInt(raw, 10);
	if (Number.isNaN(value) || value < 0) exitUsage(`${label} must be a non-negative number of characters.`);
	return value;
}

/**
 * Parse this worktree's native agent transcripts into dev3's own conversation
 * model and write them out as JSON. The native file stays the source of truth —
 * a dump is a re-derivable cache, stamped with the parser version.
 */
async function dumpCmd(args: ParsedArgs, _context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["raw", "stdout", "latest", "out", "verbatim", "compact", "payload", "action"]);

	const info = detectFromWorktreePath(process.cwd());
	if (!info) {
		exitError("Run `dev3 conversations dump` from inside a task worktree.");
	}

	const { home } = resolveHomes();
	// Build the worktree path from the detected parts, not from cwd: transcript
	// stores are keyed on the worktree root, so running from a subdirectory would
	// otherwise find nothing.
	const taskContainer = taskContainerDir(info.realDev3Home, info.projectSlug, info.taskShortId);
	const worktreePath = `${taskContainer}/worktree`;
	const includeRaw = args.flags.raw === "true";
	const parsed = parseWorktreeConversations(worktreePath, { home, includeRaw });

	if (parsed.length === 0) {
		process.stdout.write("No parseable transcripts found for this worktree.\n");
		return;
	}

	const selected = args.flags.latest === "true" ? parsed.slice(0, 1) : parsed;

	if (args.flags.stdout === "true") {
		const payload = selected.length === 1 ? selected[0].conversation : selected.map((p) => p.conversation);
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}

	const dir = args.flags.out || conversationDumpDir(taskContainer);
	const budget: DumpBudget = {
		action: numberFlag(args.flags.action, DEFAULT_DUMP_BUDGET.action, "--action"),
		payload: numberFlag(args.flags.payload, DEFAULT_DUMP_BUDGET.payload, "--payload"),
	};
	const writeOptions = {
		budget,
		verbatim: args.flags.verbatim === "true",
		compact: args.flags.compact === "true",
	};

	process.stdout.write(`Parsed ${selected.length} conversation(s) → ${dir}\n\n`);
	for (const { conversation } of selected) {
		const path = await writeConversationDump(dir, conversationDumpName(conversation), conversation, writeOptions);
		const s = conversation.stats;
		process.stdout.write(`${conversation.source}  ${conversation.sessionId ?? "(no session id)"}\n`);
		process.stdout.write(
			`    ${s.turns} turns · ${s.events} conversation events (+${s.sessionEvents} session) · ${s.messages} messages · ${s.toolCalls} tool calls · ${s.thinkingBlocks} thinking · ${s.usage.output} out-tokens\n`,
		);
		process.stdout.write(`    fidelity: ${conversation.fidelity.level}\n`);
		for (const warning of conversation.fidelity.warnings) {
			process.stdout.write(`    ⚠ ${warning}\n`);
		}
		process.stdout.write(`    → ${path}\n\n`);
	}
}

/**
 * Retell this task's conversation as one message another agent can be handed.
 * Prints to stdout so it can be piped straight into `dev3 message`.
 */
async function handoffCmd(args: ParsedArgs): Promise<void> {
	rejectUnknownFlags(args, ["for", "thinking", "tool-output", "turns", "out"]);

	const info = detectFromWorktreePath(process.cwd());
	if (!info) {
		exitError("Run `dev3 conversations handoff` from inside a task worktree.");
	}

	const target = args.flags.for ?? "markdown";
	if (target !== "markdown" && target !== "claude" && target !== "codex") {
		exitUsage("--for must be one of: markdown, claude, codex");
	}

	const { home } = resolveHomes();
	const taskContainer = taskContainerDir(info.realDev3Home, info.projectSlug, info.taskShortId);
	const parsed = parseWorktreeConversations(`${taskContainer}/worktree`, { home });
	if (parsed.length === 0) {
		exitError("No parseable transcripts found for this worktree.");
	}

	const toolOutput = args.flags["tool-output"] ? Number.parseInt(args.flags["tool-output"], 10) : undefined;
	if (toolOutput !== undefined && Number.isNaN(toolOutput)) {
		exitUsage("--tool-output must be a number of characters (0 drops tool output).");
	}
	const turns = args.flags.turns ? Number.parseInt(args.flags.turns, 10) : undefined;
	if (turns !== undefined && Number.isNaN(turns)) {
		exitUsage("--turns must be a number of most-recent turns to keep.");
	}

	// Newest transcript first — the conversation being handed over is the live one.
	const text = renderHandoff(parsed[0].conversation, {
		target,
		includeThinking: args.flags.thinking === "true",
		toolOutputLimit: toolOutput,
		maxTurns: turns,
	});

	if (args.flags.out) {
		await atomicWriteFile(args.flags.out, text);
		process.stdout.write(`Wrote ${text.length} characters → ${args.flags.out}\n`);
		return;
	}
	process.stdout.write(text);
}

/**
 * Import the Claude Code and Codex conversations that ran in this project's directory and
 * belong to no dev3 task.
 *
 * `--dry-run` answers entirely from local files — the same scan the app runs, so
 * the list can be inspected on a machine where dev3 is not even open. A real
 * import creates tasks, so it goes through the app like every other write.
 */
async function importCmd(args: ParsedArgs, context: CliContext | null, socketPath: string | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "dry-run", "json", "sessions"]);

	const projectId = resolveProjectId(args.flags.project, context);
	if (!projectId) {
		exitError("Could not determine project. Run from inside a worktree or pass --project <id>.");
	}
	const project = readProjectDirect(projectId);
	if (!project) {
		exitError(`Project not found: ${projectId}`);
	}

	const dryRun = args.flags["dry-run"] === "true";
	const asJson = args.flags.json === "true";
	const requested = (args.flags.sessions ?? "").split(",").map((id) => id.trim()).filter(Boolean);

	const { home, dev3Home } = resolveHomes();
	const tasks = loadProjectTasks(dev3Home, projectSlug(project.path));
	const found = scanImportableConversations({
		projectPath: project.path,
		importedSessionIds: tasks
			.map((task) => task.importedSessionId)
			.filter((id): id is string => typeof id === "string" && id.length > 0),
		home,
		dev3Home,
	});
	const selected = requested.length > 0 ? found.filter((c) => requested.includes(c.sessionId)) : found;

	if (dryRun) {
		if (asJson) {
			process.stdout.write(`${JSON.stringify(selected, null, 2)}\n`);
			return;
		}
		if (selected.length === 0) {
			process.stdout.write("No importable conversations for this project.\n");
			return;
		}
		process.stdout.write(`${selected.length} conversation(s) would be imported (nothing was created):\n\n`);
		printTable(
			["SESSION", "AGENT", "LAST ACTIVE", "TURNS", "COLUMN", "TITLE"],
			selected.map((c) => [
				c.sessionId.slice(0, 8),
				CONVERSATION_SOURCE_LABELS[c.source],
				new Date(c.lastActivityMs).toISOString().slice(0, 16).replace("T", " "),
				String(c.turns),
				c.targetStatus === "user-questions" ? "Has Questions" : "Completed",
				c.title,
			]),
		);
		return;
	}

	if (!socketPath) {
		exitError("dev3 must be running to import conversations. Use --dry-run to inspect the list without it.");
	}
	if (selected.length === 0) {
		process.stdout.write("No importable conversations for this project.\n");
		return;
	}

	const resp = await sendRequest(socketPath, "conversations.import", {
		projectId,
		sessionIds: selected.map((c) => c.sessionId),
	});
	if (!resp.ok) exitError(resp.error || "Failed to import conversations");
	const result = resp.data as ImportConversationsResult;

	if (asJson) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		process.stdout.write(`Imported ${result.imported} conversation(s) as tasks.\n`);
		for (const task of result.tasks) {
			process.stdout.write(`  seq ${task.seq}  ${task.status}  ${task.title}\n`);
		}
	}
	if (result.problems.length > 0) {
		exitError(
			`${result.problems.length} conversation(s) had trouble`,
			result.problems.map((p) => `${p.title}: ${p.error}`).join("\n"),
		);
	}
}

/** What `dev3 import` needs before it has any use for the app: who, and where. */
export interface ImportTarget {
	sessionId: string;
	project: ProjectDirect;
}

/**
 * Both halves of `dev3 import`, answered from local files alone.
 *
 * Kept separate from the handler so `main.ts` can ask BEFORE it goes looking for
 * the app: a directory no project owns is the commonest answer this command has,
 * and reporting "dev3 is not running" instead sends the reader to restart an app
 * that would not have helped.
 */
export function resolveImportTarget(cwd: string = process.cwd()): ImportTarget {
	const sessionId = process.env.CLAUDE_CODE_SESSION_ID?.trim();
	if (!sessionId) {
		exitError(
			"Not running inside a Claude Code session.",
			"`dev3 import` imports the conversation it is run from, so it needs CLAUDE_CODE_SESSION_ID.\n" +
			"To import past conversations instead, use `dev3 conversations import`.",
		);
	}

	const project = projectOwningCwd(cwd);
	if (!project) exitNoProjectForCwd(cwd);
	return { sessionId, project };
}

/**
 * `dev3 import` — put the conversation you are sitting in onto the board.
 *
 * Run from the agent's own shell, so both halves are already known: the cwd says
 * which project owns the work, and `CLAUDE_CODE_SESSION_ID` says which
 * conversation this is. `dev3 conversations import` covers the batch case; this
 * covers "this one, now".
 *
 * A conversation that is still going in gets imported as it stands right now:
 * the description is the transcript up to this moment and does not follow the
 * rest of the session, and a recent conversation also arrives with a worktree of
 * its own (`importOne`). Both are stated in `dev3 import --help`.
 */
export async function handleImportCurrentSession(
	args: ParsedArgs,
	socketPath: string | null,
	target: ImportTarget = resolveImportTarget(),
): Promise<void> {
	rejectUnknownFlags(args, ["json"]);
	const asJson = args.flags.json === "true";
	const { sessionId, project } = target;

	const { home, dev3Home } = resolveHomes();
	const tasks = loadProjectTasks(dev3Home, projectSlug(project.path));
	const found = scanImportableConversations({
		projectPath: project.path,
		importedSessionIds: tasks
			.map((task) => task.importedSessionId)
			.filter((id): id is string => typeof id === "string" && id.length > 0),
		home,
		dev3Home,
	});

	const match = found.find((c) => c.sessionId === sessionId);
	if (!match) {
		const alreadyImported = tasks.find((task) => task.importedSessionId === sessionId);
		if (alreadyImported) {
			process.stdout.write(`This conversation is already on the board as seq ${alreadyImported.seq}.\n`);
			return;
		}
		// Every other miss is the same answer: the transcript is not yet in a
		// shape the importer accepts (no title until the agent writes one, or
		// nothing on disk yet for a brand-new session).
		exitError(
			"This conversation is not importable yet.",
			"It needs a title the agent has written and at least one exchange on disk. Try again after a reply.",
		);
	}

	if (!socketPath) {
		exitError("dev3 must be running to import a conversation.");
	}
	const resp = await sendRequest(socketPath, "conversations.import", {
		projectId: project.id,
		sessionIds: [match.sessionId],
	});
	if (!resp.ok) exitError(resp.error || "Failed to import the conversation");
	const result = resp.data as ImportConversationsResult;

	if (asJson) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		for (const task of result.tasks) {
			process.stdout.write(`Imported as seq ${task.seq} (${task.status}): ${task.title}\n`);
		}
	}
	// Checked in BOTH modes: an import that could not build its worktree must not
	// exit 0 just because the caller asked for JSON.
	if (result.problems.length > 0) {
		exitError(
			`${result.problems.length} conversation(s) had trouble`,
			result.problems.map((p) => `${p.title}: ${p.error}`).join("\n"),
		);
	}
}

/**
 * The common miss: this directory belongs to no board, so nothing can own the
 * import.
 *
 * Two of those directories are where agents actually live, and "add this
 * repository to dev3" is wrong advice in both — a dev3 worktree already belongs
 * to a project (its conversation IS a task), and a virtual board has no
 * repository to import into at all. They get told what is true instead.
 */
function exitNoProjectForCwd(cwd: string): never {
	const lines = ["No dev3 project owns this directory:", `  ${cwd}`, ""];

	if (detectFromWorktreePath(cwd)) {
		lines.push(
			"This is a dev3 task's own worktree, so this conversation is already the task",
			"you are working in — there is nothing to put on the board.",
			"",
			"To import a conversation that ran in the project's own checkout, run",
			"`dev3 import` from there instead.",
		);
	} else if (toPosixSeparators(cwd).includes(OPS_MARKER)) {
		lines.push(
			"This is a virtual (\"Operations\") board's working directory. A virtual board",
			"has no repository, so no conversation can be imported into it.",
			"",
			"Run `dev3 import` from a git project's own checkout instead.",
		);
	} else {
		lines.push(
			"A conversation is imported into the project that owns the directory it ran in,",
			"and nowhere else — anywhere else would attach it to the wrong repository.",
			"",
			"Next step: add this repository to dev3 (\"Add project\" on the dashboard), then",
			"run `dev3 import` here again.",
		);
	}

	process.stderr.write(`${lines.join("\n")}\n`);
	process.exit(CLI_EXIT_CODE_NO_PROJECT_FOR_CWD);
}

export async function handleConversations(
	subcommand: string | undefined,
	args: ParsedArgs,
	context: CliContext | null,
	socketPath: string | null = null,
): Promise<void> {
	switch (subcommand) {
		case "search":
			return searchCmd(args, context);
		case "dump":
			return dumpCmd(args, context);
		case "handoff":
			return handoffCmd(args);
		case "import":
			return importCmd(args, context, socketPath);
		default:
			exitUsage(
				`Unknown subcommand: conversations ${subcommand || "(none)"}` +
				'\nAvailable: conversations search "<query>", conversations dump, conversations handoff, conversations import',
			);
	}
}

