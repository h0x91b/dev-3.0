import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Task, TaskHistoryEntry, TaskStatus } from "../../shared/types";
import { ALL_STATUSES } from "../../shared/types";
import { projectSlug } from "../../shared/conversation-search-core";
import { searchConversations, type EngineTask } from "../../bun/conversation-search";
import {
	conversationDumpDir,
	conversationDumpName,
	parseWorktreeConversations,
	taskContainerDir,
	writeConversationDump,
} from "../../bun/conversation-parse";
import { renderHandoff } from "../../shared/conversation-render";
import { DEFAULT_DUMP_BUDGET, type DumpBudget } from "../../shared/conversation-dump";
import { atomicWriteFile } from "../../bun/atomic-write";
import type { ParsedArgs } from "../args";
import { detectFromWorktreePath, readProjectDirect, resolveProjectId, type CliContext } from "../context";
import { exitError, exitUsage } from "../output";
import { rejectUnknownFlags } from "../flag-validation";

/** Derive the real HOME / dev3 home, honoring sandbox-rewritten HOME via the worktree path. */
function resolveHomes(): { home: string; dev3Home: string } {
	const cwd = process.cwd();
	const info = detectFromWorktreePath(cwd);
	if (info) {
		const dev3Home = info.realDev3Home;
		const home = dev3Home.replace(/\/\.dev3\.0$/, "");
		return { home, dev3Home };
	}
	const home = process.env.HOME || "/tmp";
	return { home, dev3Home: `${home}/.dev3.0` };
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

export async function handleConversations(
	subcommand: string | undefined,
	args: ParsedArgs,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case "search":
			return searchCmd(args, context);
		case "dump":
			return dumpCmd(args, context);
		case "handoff":
			return handoffCmd(args);
		default:
			exitUsage(
				`Unknown subcommand: conversations ${subcommand || "(none)"}` +
				'\nAvailable: conversations search "<query>", conversations dump, conversations handoff',
			);
	}
}

