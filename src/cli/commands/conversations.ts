import { existsSync, readFileSync } from "node:fs";
import type { Task, TaskStatus } from "../../shared/types";
import { ALL_STATUSES } from "../../shared/types";
import { projectSlug } from "../../shared/conversation-search-core";
import { searchConversations, type EngineTask } from "../../bun/conversation-search";
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

	const engineTasks: EngineTask[] = tasks.map((t) => ({
		id: t.id,
		title: t.title,
		description: t.description,
		overview: t.overview,
		userOverview: t.userOverview,
		notes: (t.notes ?? []).map((n) => n.content),
		historyTexts: (t.history ?? []).flatMap((h) => [h.title, h.overview]).filter((s): s is string => !!s),
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

export async function handleConversations(
	subcommand: string | undefined,
	args: ParsedArgs,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case "search":
			return searchCmd(args, context);
		default:
			exitUsage(
				`Unknown subcommand: conversations ${subcommand || "(none)"}` +
				'\nAvailable: conversations search "<query>"',
			);
	}
}

