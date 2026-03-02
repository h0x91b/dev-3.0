import type { Task } from "../../shared/types";
import { STATUS_LABELS } from "../../shared/types";
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
			params.status = args.flags.status;
		}

		const resp = await sendRequest(socketPath, "tasks.list", params);
		if (!resp.ok) exitError(resp.error || "Failed to list tasks");

		const tasks = resp.data as Task[];
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
