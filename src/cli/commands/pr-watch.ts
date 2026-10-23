import type { ParsedArgs } from "../args";
import { exitError, exitUsage } from "../output";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { sendRequest } from "../socket-client";
import { CLI_EXIT_CODE_PR_WATCH_NO_PR } from "../../shared/cli-exit-codes";
import { PR_WATCH_NO_PR_PREFIX, PR_WATCH_UNTIL, type PrWatchUntil } from "../../shared/pr-watch";
import { requireValuelessFlag } from "./pr";

const WATCH_USAGE = "Usage: dev3 pr watch [--until ci|merged] [--pr <N>] [--task <id>] [--project <id>] | dev3 pr watch --off | dev3 pr watch --list";

/** Longer than the app's 15 s cap on each `gh` call it makes while subscribing. */
const SUBSCRIBE_TIMEOUT_MS = 45_000;

const WATCH_SUMMARY: Record<PrWatchUntil, string> = {
	ci: "CI finishes",
	merged: "it is merged or closed",
};

/**
 * `dev3 pr watch` — subscribe this task's agent to its PR. The app stores the
 * subscription and the command returns at once; the app's own PR poll types ONE
 * message into the agent when the event happens, so nobody has to poll `gh`.
 */
export async function handlePrWatch(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["until", "pr", "task", "task-id", "project", "off", "list"]);
	const off = requireValuelessFlag(args, "off");
	const list = requireValuelessFlag(args, "list");
	if (off && list) exitUsage(`--off and --list cannot be combined.\n${WATCH_USAGE}`);
	if ((off || list) && (args.flags.until !== undefined || args.flags.pr !== undefined)) {
		exitUsage(`--off and --list take no --until or --pr.\n${WATCH_USAGE}`);
	}

	const until = (args.flags.until ?? "ci") as PrWatchUntil;
	if (!(PR_WATCH_UNTIL as readonly string[]).includes(until)) {
		exitUsage(`--until takes ${PR_WATCH_UNTIL.join(" or ")}, got "${args.flags.until}".\n${WATCH_USAGE}`);
	}
	let prNumber: number | undefined;
	if (args.flags.pr !== undefined) {
		prNumber = Number(args.flags.pr);
		if (!/^\d+$/.test(args.flags.pr) || prNumber < 1) exitUsage(`--pr takes a pull request number, got "${args.flags.pr}".`);
	}

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) exitUsage("No task in context. Run inside a worktree or pass --task <id>.");
	const params: Record<string, unknown> = { taskId: expandShortId(rawTaskId, context) };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;

	if (off || list) {
		const resp = await sendRequest(socketPath, off ? "pr.watch.off" : "pr.watch.list", params);
		if (!resp.ok) exitError(resp.error || "Failed to reach the app");
		if (off) {
			const { removed } = resp.data as { removed: number };
			process.stdout.write(removed > 0 ? `Removed ${removed} PR watch${removed === 1 ? "" : "es"}.\n` : "No PR watches on this task.\n");
			return;
		}
		const { watches } = resp.data as { watches: Array<{ until: string; prNumber: number; headSha: string; createdAt: string }> };
		if (watches.length === 0) process.stdout.write("No PR watches on this task.\n");
		for (const watch of watches) {
			process.stdout.write(`PR #${watch.prNumber}  until ${watch.until}  head ${watch.headSha}  since ${watch.createdAt}\n`);
		}
		return;
	}

	params.until = until;
	if (prNumber !== undefined) params.prNumber = prNumber;
	// Our pane and pid, so the message comes back to this agent and not to a sibling; the app decides whether it applies.
	const sourcePaneId = context?.taskId ? (process.env.TMUX_PANE?.trim() || process.env.DEV3_PANE_ID?.trim()) : undefined;
	if (context?.taskId) params.sourceTaskId = context.taskId;
	if (sourcePaneId) {
		params.sourcePaneId = sourcePaneId;
		params.sourcePid = process.pid;
	}
	// The app caps its own `gh` calls at 15 s; the wait here must outlast them.
	const resp = await sendRequest(socketPath, "pr.watch.add", params, { timeoutMs: SUBSCRIBE_TIMEOUT_MS });
	if (!resp.ok) {
		const error = resp.error || "Failed to subscribe";
		if (error.startsWith(PR_WATCH_NO_PR_PREFIX)) {
			exitError(error.slice(PR_WATCH_NO_PR_PREFIX.length), undefined, CLI_EXIT_CODE_PR_WATCH_NO_PR);
		}
		exitError(error);
	}
	const data = resp.data as { prNumber: number };
	process.stdout.write(`Watching PR #${data.prNumber} until ${WATCH_SUMMARY[until]} — dev3 will message this agent. No need to poll gh.\n`);
}
