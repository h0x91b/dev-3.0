import type { Task, TaskPriority, TaskStatus } from "../../shared/types";
import {
	STATUS_LABELS,
	ALL_STATUSES,
	ALL_PRIORITIES,
	DEFAULT_PRIORITY,
	getTaskTitle,
	normalizePriority,
} from "../../shared/types";
import { DEFAULT_TASKS_LIST_LIMIT, selectTasksPage, tasksListRow, type TasksListJson } from "../../shared/cli-json/tasks-list";
import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { resolveProjectId, type CliContext } from "../context";

/**
 * Parse `--priority P0,P1` into the set to keep. Accepts anything
 * {@link normalizePriority} accepts (`p1`, `1`, `P1`), comma-separated. A list
 * rather than a range: the enum has five values, so the longest useful filter is
 * five tokens, and one syntax beats teaching two.
 */
function parsePriorityFilter(raw: string): Set<TaskPriority> {
	const wanted = new Set<TaskPriority>();
	for (const token of raw.split(",")) {
		if (token.trim() === "") continue;
		const normalized = normalizePriority(token);
		if (!normalized) {
			exitUsage(`Invalid --priority: "${token.trim()}". Valid: ${ALL_PRIORITIES.join(", ")} (comma-separated for several).`);
		}
		wanted.add(normalized);
	}
	if (wanted.size === 0) {
		exitUsage(`Invalid --priority: "${raw}". Valid: ${ALL_PRIORITIES.join(", ")} (comma-separated for several).`);
	}
	return wanted;
}

interface ChildRow {
	id: string;
	seq: number;
	variantIndex: number | null;
	projectId: string;
	projectName: string;
	status: TaskStatus;
	title: string;
}

/**
 * `tasks list --children-of <ref>`: the direct children of one task (its whole
 * variant group), from every project. The parent resolves in --project, else
 * the current project.
 */
async function listChildren(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const ref = args.flags["children-of"]?.trim();
	if (!ref || ref === "true") exitUsage("--children-of needs a task: --children-of seq:<N> (or a task id).");
	const params: Record<string, unknown> = { taskId: ref };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "task.children", params);
	if (!resp.ok) exitError(resp.error || "Failed to list children");
	const { parent, children } = resp.data as { parent: { seq: number; projectName: string; title: string }; children: ChildRow[] };
	const rows = [...children].sort((a, b) => a.projectName.localeCompare(b.projectName) || a.seq - b.seq);

	if (args.flags.json !== undefined) {
		process.stdout.write(`${JSON.stringify({ schemaVersion: 1, parent, children: rows }, null, 2)}\n`);
		return;
	}
	process.stdout.write(`Children of #${parent.seq} · ${parent.projectName} — ${parent.title}\n\n`);
	if (rows.length === 0) {
		process.stdout.write("No children.\n");
		return;
	}
	printTable(
		["PROJECT", "SEQ", "ID", "STATUS", "TITLE"],
		rows.map((c) => [
			c.projectName,
			c.variantIndex !== null ? `${c.seq}-${c.variantIndex}` : String(c.seq),
			c.id.slice(0, 8),
			STATUS_LABELS[c.status] || c.status,
			c.title.length > 60 ? c.title.slice(0, 57) + "..." : c.title,
		]),
	);
}

export async function handleTasks(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	if ((subcommand === "list" || !subcommand) && args.flags["children-of"] !== undefined) {
		return listChildren(args, socketPath, context);
	}
	if (subcommand === "list" || !subcommand) {
		if (args.flags.open !== undefined && (args.flags.status === "completed" || args.flags.status === "cancelled")) {
			exitUsage("--open cannot be combined with a completed or cancelled --status.");
		}
		const projectId = resolveProjectId(args.flags.project, context);
		if (!projectId) {
			exitUsage("--project <id> is required (or run from the project's worktree or checkout)");
		}

		const params: Record<string, unknown> = { projectId };
		if (args.flags.status) {
			if (!ALL_STATUSES.includes(args.flags.status as typeof ALL_STATUSES[number])) {
				exitUsage(`Invalid status: "${args.flags.status}". Valid: ${ALL_STATUSES.join(", ")}`);
			}
			params.status = args.flags.status;
		}
		const priorityFilter = args.flags.priority ? parsePriorityFilter(args.flags.priority) : null;

		const sortKey = args.flags.sort ?? "priority";
		if (sortKey !== "priority" && sortKey !== "seq") {
			exitUsage(`Invalid --sort: "${args.flags.sort}". Valid: priority, seq.`);
		}

		let limit = DEFAULT_TASKS_LIST_LIMIT;
		if (args.flags.limit) {
			const parsed = Number(args.flags.limit);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				exitUsage(`Invalid --limit: "${args.flags.limit}". Must be a positive integer.`);
			}
			limit = parsed;
		}

		let offset = 0;
		if (args.flags.offset) {
			const parsed = Number(args.flags.offset);
			if (!Number.isInteger(parsed) || parsed < 0) {
				exitUsage(`Invalid --offset: "${args.flags.offset}". Must be a non-negative integer.`);
			}
			offset = parsed;
		}

		const resp = await sendRequest(socketPath, "tasks.list", params);
		if (!resp.ok) exitError(resp.error || "Failed to list tasks");

		const { page, total } = selectTasksPage(resp.data as Task[], {
			open: args.flags.open !== undefined,
			label: args.flags.label || undefined,
			priorities: priorityFilter ?? undefined,
			sort: sortKey,
			limit,
			offset,
		});

		if (args.flags.json !== undefined) {
			const json: TasksListJson = { schemaVersion: 1, tasks: page.map(tasksListRow), total, offset, limit };
			process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
			return;
		}

		if (page.length === 0) {
			if (total === 0) {
				process.stdout.write("No tasks found.\n");
			} else {
				process.stdout.write(`No tasks at offset ${offset} (${total} total).\n`);
			}
			return;
		}

		printTable(
			["SEQ", "ID", "PRI", "STATUS", "TITLE"],
			page.map((t) => {
				const title = getTaskTitle(t);
				return [
					String(t.seq),
					t.id.slice(0, 8),
					// Two characters wide and it is what the board ranks on — the
					// cheapest column on this table.
					t.priority ?? DEFAULT_PRIORITY,
					// Drafts share the To Do column but are not runnable — mark them
					// here so a listing never reads as "ready to pick up".
					`${STATUS_LABELS[t.status] || t.status}${t.draft === true ? " (draft)" : ""}`,
					title.length > 60 ? title.slice(0, 57) + "..." : title,
				];
			}),
		);

		// Footer: show the visible window and hint at paging when more remain.
		const from = offset + 1;
		const to = offset + page.length;
		let footer = `\nShowing ${from}-${to} of ${total}.`;
		if (to < total) {
			footer += ` Next page: --offset ${to}${args.flags.limit ? ` --limit ${limit}` : ""}.`;
		}
		process.stdout.write(`${footer}\n`);
		return;
	}

	exitUsage(`Unknown subcommand: tasks ${subcommand}\nAvailable: tasks list`);
}
