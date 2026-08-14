import { sendRequest } from "../socket-client";
import { exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import {
	PANE_RUN_TAIL_MAX_LINES,
	renderPaneRunListing,
	renderPaneRunLog,
	type PaneRunListing,
	type PaneRunView,
} from "../../shared/pane-runs";

const USAGE = `Usage:
  dev3 pane list [--task <id>] [--json]                       Which backend you are on, which panes exist, which one is yours
  dev3 pane run "<command>" [--below] [--label <name>]        Run a command in a neighbouring pane; prints the run id
  dev3 pane logs <run-id> [--lines <N>] [--json]              The run's outcome + the tail of what it printed
  dev3 pane close <run-id>                                    Close the run's pane (kills the command)`;

/** The pane the calling agent is sitting in, as its own shell was told. */
function selfPaneId(): string | null {
	// Native panes export DEV3_PANE_ID; tmux exports TMUX_PANE. Nothing is inferred
	// from the platform — whichever variable is present names the backend in play.
	const native = process.env.DEV3_PANE_ID?.trim();
	if (native) return native;
	const tmuxPane = process.env.TMUX_PANE?.trim();
	return tmuxPane || null;
}

function requireTask(args: ParsedArgs, context: CliContext | null): string {
	const raw = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!raw) {
		exitUsage(`No task in context — pass --task.\n${USAGE}`);
		throw new Error("unreachable");
	}
	return expandShortId(raw, context);
}

/**
 * `dev3 pane` — the backend-neutral way for an agent to put a long-running command
 * in the pane next to it and read what that command printed. One surface on tmux,
 * on the native backend, on macOS, Linux and Windows.
 */
export async function handlePane(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case "list": {
			rejectUnknownFlags(args, ["task", "task-id", "json"]);
			const resp = await sendRequest(socketPath, "pane.list", {
				taskId: requireTask(args, context),
				selfPaneId: selfPaneId() ?? undefined,
			});
			if (!resp.ok) exitError(resp.error || "Failed to list the task's panes");
			const listing = resp.data as PaneRunListing;
			process.stdout.write("json" in args.flags ? `${JSON.stringify(listing, null, 2)}\n` : renderPaneRunListing(listing));
			return;
		}

		case "run": {
			rejectUnknownFlags(args, ["task", "task-id", "below", "label", "json"]);
			const command = args.positional[0];
			if (!command) {
				exitUsage(`dev3 pane run needs a command to run.\n${USAGE}`);
				return;
			}
			const resp = await sendRequest(socketPath, "pane.run", {
				taskId: requireTask(args, context),
				command,
				placement: "below" in args.flags ? "below" : "right",
				label: args.flags.label,
			});
			if (!resp.ok) exitError(resp.error || "Failed to start the pane run");
			const started = resp.data as { runId: string; paneId: string; backend: string; logPath: string };
			if ("json" in args.flags) {
				process.stdout.write(`${JSON.stringify(started, null, 2)}\n`);
				return;
			}
			process.stdout.write(
				`started run ${started.runId} in pane ${started.paneId} (${started.backend})\n` +
					`read it with: dev3 pane logs ${started.runId}\n`,
			);
			return;
		}

		case "logs": {
			rejectUnknownFlags(args, ["task", "task-id", "lines", "json"]);
			const runId = args.positional[0];
			if (!runId) {
				exitUsage(`dev3 pane logs needs a run id (see \`dev3 pane list\`).\n${USAGE}`);
				return;
			}
			if (args.flags.lines !== undefined) {
				const lines = Number(args.flags.lines);
				if (!Number.isInteger(lines) || lines < 1 || lines > PANE_RUN_TAIL_MAX_LINES) {
					exitUsage(`--lines must be a whole number from 1 to ${PANE_RUN_TAIL_MAX_LINES}.`);
					return;
				}
			}
			const resp = await sendRequest(socketPath, "pane.logs", {
				taskId: requireTask(args, context),
				runId,
				lines: args.flags.lines === undefined ? undefined : Number(args.flags.lines),
			});
			if (!resp.ok) exitError(resp.error || "Failed to read the run");
			const view = resp.data as PaneRunView;
			process.stdout.write("json" in args.flags ? `${JSON.stringify(view, null, 2)}\n` : renderPaneRunLog(view));
			return;
		}

		case "close": {
			rejectUnknownFlags(args, ["task", "task-id"]);
			const runId = args.positional[0];
			if (!runId) {
				exitUsage(`dev3 pane close needs a run id.\n${USAGE}`);
				return;
			}
			const resp = await sendRequest(socketPath, "pane.close", { taskId: requireTask(args, context), runId });
			if (!resp.ok) exitError(resp.error || "Failed to close the run's pane");
			const closed = (resp.data as { closed: boolean }).closed;
			process.stdout.write(closed ? `closed the pane running ${runId}\n` : `no live pane is running ${runId}\n`);
			return;
		}

		default:
			exitUsage(subcommand ? `Unknown subcommand: pane ${subcommand}\n${USAGE}` : USAGE);
	}
}
