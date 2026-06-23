import { sendRequest } from "../socket-client";
import { exitError, exitUsage, printDetail } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";

const NOTIFY_MAX_LEN = 500;

/**
 * `dev3 notify "message"` — surface an in-app toast (default) or a native OS
 * notification (`--desktop`) in the running app. When a task is in context the
 * toast/notification is clickable and lands the user on that task.
 */
export async function handleNotify(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project", "level", "desktop", "message"]);

	const message = (args.positional[0] ?? args.flags.message ?? "").toString().trim();
	if (!message) {
		exitUsage('Usage: dev3 notify "message" [--level info|success|error] [--desktop]');
	}
	if (message.length > NOTIFY_MAX_LEN) {
		exitUsage(`Message too long (${message.length} chars). Keep it under ${NOTIFY_MAX_LEN} characters.`);
	}

	const level = (args.flags.level ?? "info").toLowerCase();
	if (level !== "info" && level !== "success" && level !== "error") {
		exitUsage(`Invalid --level "${level}". Use info, success, or error.`);
	}

	// `--desktop` is a boolean flag (no value or any value except an explicit "false").
	const desktop = "desktop" in args.flags && args.flags.desktop !== "false";

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	const params: Record<string, unknown> = { message, level };
	if (desktop) params.desktop = true;

	if (rawTaskId) {
		params.taskId = expandShortId(rawTaskId, context);
		const projectId = resolveProjectId(args.flags.project, context);
		if (projectId) params.projectId = projectId;
	} else if (desktop) {
		exitUsage("--desktop needs a task — run inside a worktree or pass --task <id>.");
	}

	const resp = await sendRequest(socketPath, "ui.notify", params);
	if (!resp.ok) exitError(resp.error || "Failed to send notification");

	const data = resp.data as { delivered: boolean; mode: string };
	if (!data.delivered) {
		process.stdout.write("App is running but has no open window — nothing was shown.\n");
		return;
	}
	process.stdout.write(`${data.mode === "desktop" ? "Desktop notification" : "Toast"} sent.\n`);
}

/**
 * `dev3 attention "reason"` — light the red attention badge on a task card, with
 * an optional hoverable reason. Same visual surface as the terminal bell.
 */
export async function handleAttention(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project", "reason"]);

	const reason = (args.positional[0] ?? args.flags.reason ?? "").toString().trim();
	if (reason.length > NOTIFY_MAX_LEN) {
		exitUsage(`Reason too long (${reason.length} chars). Keep it under ${NOTIFY_MAX_LEN} characters.`);
	}

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) {
		exitUsage("No task in context. Run inside a worktree or pass --task <id> / --task-id <id>.");
	}

	const params: Record<string, unknown> = { taskId: expandShortId(rawTaskId, context), reason };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "ui.attention", params);
	if (!resp.ok) exitError(resp.error || "Failed to raise attention");

	const data = resp.data as { delivered: boolean; taskId: string };
	if (!data.delivered) {
		process.stdout.write("App is running but has no open window — badge not shown.\n");
		return;
	}
	process.stdout.write(`Attention badge raised on task ${data.taskId.slice(0, 8)}.\n`);
}

/**
 * `dev3 ui state` — report what the app is currently showing (focused task /
 * project, foreground) so an agent can decide whether a ping is even needed.
 */
export async function handleUi(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	if (subcommand !== "state") {
		exitUsage(`Unknown subcommand: ui ${subcommand || "(none)"}\nAvailable: ui state`);
	}
	rejectUnknownFlags(args, []);

	const resp = await sendRequest(socketPath, "ui.state", {});
	if (!resp.ok) exitError(resp.error || "Failed to read UI state");

	const d = resp.data as {
		appRunning: boolean;
		foreground: boolean;
		activeProjectId: string | null;
		activeTaskId: string | null;
	};

	printDetail([
		["app", d.appRunning ? "running" : "not running"],
		["foreground", d.foreground ? "yes" : "no"],
		["activeProject", d.activeProjectId ? d.activeProjectId.slice(0, 8) : "(none)"],
		["activeTask", d.activeTaskId ? d.activeTaskId.slice(0, 8) : "(none)"],
	]);

	if (context?.taskId && d.activeTaskId === context.taskId) {
		process.stdout.write(
			`\nThis task is currently focused${d.foreground ? " and the app is in the foreground." : " (app in background)."}\n`,
		);
	}
}
