import { sendRequest } from "../socket-client";
import { exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { PEEK_MAX_LINES, renderTaskPeek, type TaskPeekSnapshot } from "../../shared/task-peek";

const USAGE = "Usage: dev3 peek [--task <id|seq:N>] [--project <id>] [--pane <N|paneId>] [--lines <N>] [--json]";

/**
 * `dev3 peek` — a read-only glance at a task's terminal: pane summary with
 * output freshness plus the tail of one pane. Never focuses, writes, or takes
 * ownership, so a coordinator can check on a worker without interrupting it.
 *
 * A task with no live terminal is a SUCCESSFUL answer ("no terminal session,
 * because …") — "is it even alive?" is exactly what the caller asked.
 */
export async function handlePeek(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project", "pane", "lines", "json"]);

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) {
		exitUsage(`No task in context — pass --task.\n${USAGE}`);
		return;
	}

	const params: Record<string, unknown> = { taskId: expandShortId(rawTaskId, context) };

	// Deliberately NOT the context project: a coordinator peeks at peers in other
	// projects too, and the server resolves a bare ref across all of them. Passing
	// `--project` narrows the search when a `seq:` ref is ambiguous.
	if (args.flags.project) params.projectId = resolveProjectId(args.flags.project, context);

	if (args.flags.pane !== undefined) {
		const pane = String(args.flags.pane).trim();
		if (!pane) exitUsage(`--pane needs a pane number or pane id.\n${USAGE}`);
		params.pane = pane;
	}

	if (args.flags.lines !== undefined) {
		const lines = Number(args.flags.lines);
		if (!Number.isInteger(lines) || lines < 1 || lines > PEEK_MAX_LINES) {
			exitUsage(`--lines must be a whole number from 1 to ${PEEK_MAX_LINES}.`);
			return;
		}
		params.lines = lines;
	}

	const resp = await sendRequest(socketPath, "task.peek", params);
	if (!resp.ok) exitError(resp.error || "Failed to peek at the task");

	const snapshot = resp.data as TaskPeekSnapshot;

	if ("json" in args.flags) {
		process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
		return;
	}

	process.stdout.write(renderTaskPeek(snapshot, new Date()));
}
