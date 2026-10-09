import { sendRequest } from "../socket-client";
import { exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { PEEK_MAX_LINES, renderTaskPeek, type TaskPeekSnapshot } from "../../shared/task-peek";
import { CLI_EXIT_CODE_PEEK_FOLLOW_UNSUPPORTED } from "../../shared/cli-exit-codes";
import {
	abortableSleep,
	PEEK_FOLLOW_DEFAULT_INTERVAL_S,
	PEEK_FOLLOW_MAX_INTERVAL_S,
	PEEK_FOLLOW_MIN_INTERVAL_S,
	runPeekFollow,
} from "../peek-follow";

const USAGE = "Usage: dev3 peek [--task <id|seq:N>] [--project <id>] [--pane <N|paneId>] [--lines <N>] [--json] [--follow [--interval <seconds>]]";

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
	rejectUnknownFlags(args, ["task", "task-id", "project", "pane", "lines", "json", "follow", "interval"]);
	const intervalMs = parseFollowInterval(args);

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) {
		exitUsage(`No task in context — pass --task.\n${USAGE}`);
		return;
	}

	const params: Record<string, unknown> = { taskId: expandShortId(rawTaskId, context) };

	// The project the shell sits in SCOPES the lookup, exactly like every other
	// task-targeting command: every board counts `seq` from 1, so resolving a bare
	// ref across all of them would hand back a stranger's task. `--project` is the
	// cross-project escape hatch; outside any project the lookup stays global and
	// a collision is reported instead of guessed.
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;

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

	const fetchSnapshot = async (): Promise<TaskPeekSnapshot> => {
		const resp = await sendRequest(socketPath, "task.peek", params);
		if (!resp.ok) exitError(resp.error || "Failed to peek at the task");
		return resp.data as TaskPeekSnapshot;
	};
	const json = "json" in args.flags;

	if (intervalMs !== null) {
		await follow(fetchSnapshot, json, intervalMs);
		return;
	}

	const snapshot = await fetchSnapshot();
	if (json) {
		process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
		return;
	}
	process.stdout.write(renderTaskPeek(snapshot, new Date()));
}

/** Null when not following; otherwise the validated sample interval in ms. */
function parseFollowInterval(args: ParsedArgs): number | null {
	const follow = args.flags.follow;
	if (follow === undefined) {
		if (args.flags.interval !== undefined) exitUsage(`--interval only applies with --follow.\n${USAGE}`);
		return null;
	}
	if (follow !== "true") exitUsage(`--follow takes no value; set the sampling period with --interval <seconds>.\n${USAGE}`);
	if (args.flags.interval === undefined) return PEEK_FOLLOW_DEFAULT_INTERVAL_S * 1000;
	const seconds = Number(args.flags.interval);
	if (!Number.isInteger(seconds) || seconds < PEEK_FOLLOW_MIN_INTERVAL_S || seconds > PEEK_FOLLOW_MAX_INTERVAL_S) {
		exitUsage(`--interval must be a whole number of seconds from ${PEEK_FOLLOW_MIN_INTERVAL_S} to ${PEEK_FOLLOW_MAX_INTERVAL_S}.`);
	}
	return seconds * 1000;
}

/**
 * Run the sampled follow until Ctrl-C (or a closed stdout pipe), one compact JSON
 * object per line with `--json` (NDJSON) or one rendered snapshot per sample.
 */
async function follow(fetchSnapshot: () => Promise<TaskPeekSnapshot>, json: boolean, intervalMs: number): Promise<void> {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	process.stdout.on("error", stop);
	let emitted = 0;
	try {
		const end = await runPeekFollow({
			fetchSnapshot,
			emit: (snapshot) => {
				if (json) process.stdout.write(`${JSON.stringify(snapshot)}\n`);
				else process.stdout.write(`${emitted > 0 ? "\n" : ""}${renderTaskPeek(snapshot, new Date())}`);
				emitted++;
			},
			sleep: abortableSleep,
			now: Date.now,
		}, intervalMs, controller.signal);
		if (end === "unsupported") {
			exitError(
				"--follow needs a pane whose screen this backend can read; this one publishes none.",
				"The snapshot above is the whole answer. One-shot `dev3 peek` still shows the pane summary.",
				CLI_EXIT_CODE_PEEK_FOLLOW_UNSUPPORTED,
			);
		}
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		process.stdout.off("error", stop);
	}
}
