import type { Task } from "../../shared/types";
import { STATUS_LABELS, ALL_STATUSES, getTaskTitle } from "../../shared/types";
import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { resolveProjectId, type CliContext } from "../context";

// Default page size for `tasks list` when --limit is omitted. Keeps large
// boards (hundreds of tasks) from flooding the terminal; page with --offset.
const DEFAULT_LIST_LIMIT = 50;

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

		// Newest first — sort by seq descending so the most recent tasks lead.
		// Done before paging so --offset/--limit walk from the newest task.
		tasks = [...tasks].sort((a, b) => b.seq - a.seq);

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
					STATUS_LABELS[t.status] || t.status,
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
