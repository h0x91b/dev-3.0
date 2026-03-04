import type { Task } from "../../shared/types";
import { STATUS_LABELS, ALL_STATUSES } from "../../shared/types";
import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import type { CliContext } from "../context";

export async function handleTasks(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	if (subcommand === "list" || !subcommand) {
		const projectId = args.flags.project || context?.projectId;
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
		if (args.flags.limit) {
			const limit = Number(args.flags.limit);
			if (!Number.isInteger(limit) || limit <= 0) {
				exitUsage(`Invalid --limit: "${args.flags.limit}". Must be a positive integer.`);
			}
			params.limit = limit;
		}

		const resp = await sendRequest(socketPath, "tasks.list", params);
		if (!resp.ok) exitError(resp.error || "Failed to list tasks");

		let tasks = resp.data as Task[];

		// Client-side label filter (server returns all tasks, we filter here)
		if (args.flags.label) {
			const labelId = args.flags.label;
			tasks = tasks.filter((t) => t.labelIds?.some((id) => id === labelId || id.startsWith(labelId)));
		}

		if (tasks.length === 0) {
			process.stdout.write("No tasks found.\n");
			return;
		}

		printTable(
			["SEQ", "ID", "STATUS", "TITLE"],
			tasks.map((t) => [
				String(t.seq),
				t.id.slice(0, 8),
				STATUS_LABELS[t.status] || t.status,
				t.title.length > 60 ? t.title.slice(0, 57) + "..." : t.title,
			]),
		);
		return;
	}

	exitError(`Unknown subcommand: tasks ${subcommand}`, "Available: tasks list", 3);
}
