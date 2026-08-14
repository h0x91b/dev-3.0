import type { Task, TaskStatus } from "../../shared/types";
import { STATUS_LABELS, ALL_STATUSES, getTaskTitle } from "../../shared/types";
import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { resolveProjectId, type CliContext } from "../context";

// Default page size for `tasks list` when --limit is omitted. Keeps large
// boards (hundreds of tasks) from flooding the terminal; page with --offset.
const DEFAULT_LIST_LIMIT = 50;

// Listing order: live work first, then the backlog, then the archive. A default
// page must never be filled with completed tasks while something is running.
const STATUS_GROUP_RANK: Record<TaskStatus, number> = {
	"in-progress": 0,
	"user-questions": 0,
	"review-by-ai": 0,
	"review-by-user": 0,
	"review-by-colleague": 0,
	todo: 1,
	completed: 2,
	cancelled: 3,
};

// Custom-column tasks are live work too — they left To Do and never reached
// completed/cancelled, so they rank with the active group.
function groupRank(task: Task): number {
	if (task.customColumnId) return 0;
	return STATUS_GROUP_RANK[task.status] ?? 1;
}

export async function handleTasks(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	if (subcommand === "list" || !subcommand) {
		const projectId = resolveProjectId(args.flags.project, context);
		if (!projectId) {
			exitUsage("--project <id> is required (or run from inside a worktree)");
		}

		const params: Record<string, unknown> = { projectId };
		if (args.flags.status) {
			if (!ALL_STATUSES.includes(args.flags.status as typeof ALL_STATUSES[number])) {
				exitUsage(`Invalid status: "${args.flags.status}". Valid: ${ALL_STATUSES.join(", ")}`);
			}
			params.status = args.flags.status;
		}
		let limit = DEFAULT_LIST_LIMIT;
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

		let tasks = resp.data as Task[];

		// Client-side label filter (server returns all tasks, we filter here)
		if (args.flags.label) {
			const labelId = args.flags.label;
			tasks = tasks.filter((t) => t.labelIds?.some((id) => id === labelId || id.startsWith(labelId)));
		}

		// Live work first, then To Do, then completed, then cancelled; newest
		// (highest seq) first inside each group. Done before paging so
		// --offset/--limit walk the same order the board reads in.
		tasks = [...tasks].sort((a, b) => groupRank(a) - groupRank(b) || b.seq - a.seq);

		// Client-side paging (server returns all tasks matching status filter).
		// Defaults to the newest DEFAULT_LIST_LIMIT so large boards don't flood.
		const total = tasks.length;
		const page = tasks.slice(offset, offset + limit);

		if (page.length === 0) {
			if (total === 0) {
				process.stdout.write("No tasks found.\n");
			} else {
				process.stdout.write(`No tasks at offset ${offset} (${total} total).\n`);
			}
			return;
		}

		printTable(
			["SEQ", "ID", "STATUS", "TITLE"],
			page.map((t) => {
				const title = getTaskTitle(t);
				return [
					String(t.seq),
					t.id.slice(0, 8),
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
