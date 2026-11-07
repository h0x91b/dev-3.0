import type { Task } from "../../shared/types";
import { formatTaskRef } from "../../shared/task-refs";
import type { KeepAliveState } from "../../shared/types/keep-alive";
import { sendRequest } from "../socket-client";
import { exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";

function resolveTargetIds(args: ParsedArgs, context: CliContext | null): { taskId: string; projectId?: string } {
	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) {
		exitUsage("No task in context. Run from inside a worktree or pass --task <id>.");
	}
	const taskId = expandShortId(rawTaskId, context);
	const projectId = resolveProjectId(args.flags.project, context);
	return { taskId, projectId };
}

function describeState(ka: KeepAliveState | null): string {
	if (!ka || !ka.enabled) return "off";
	const parts = [`on (${ka.status ?? "watching"})`];
	if (ka.status === "gave-up" && ka.gaveUpReason) parts.push(`— gave up: ${ka.gaveUpReason}`);
	else if ((ka.attempts ?? 0) > 0) parts.push(`— ${ka.attempts} revive attempt(s)`);
	return parts.join(" ");
}

async function setEnabled(enabled: boolean, args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project"]);
	const { taskId, projectId } = resolveTargetIds(args, context);
	const params: Record<string, unknown> = { taskId, enabled };
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "keepAlive.set", params);
	if (!resp.ok) exitError(resp.error || "Failed to update keep alive");

	const task = resp.data as Task;
	process.stdout.write(`Keep alive ${enabled ? "enabled" : "disabled"} on task ${task.id.slice(0, 8)}\n`);
}

async function showStatus(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project"]);
	const { taskId, projectId } = resolveTargetIds(args, context);
	const params: Record<string, unknown> = { taskId };
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "keepAlive.status", params);
	if (!resp.ok) exitError(resp.error || "Failed to read keep alive");

	const data = resp.data as { seq: number; title: string; keepAlive: KeepAliveState | null };
	process.stdout.write(`${formatTaskRef(data.seq)} ${data.title}\n  keep alive: ${describeState(data.keepAlive)}\n`);
}

async function listKeptAlive(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "all"]);
	// Scope to the current project by default; --all spans every project.
	const projectId = args.flags.all === "true" ? undefined : resolveProjectId(args.flags.project, context);
	const params: Record<string, unknown> = {};
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "keepAlive.list", params);
	if (!resp.ok) exitError(resp.error || "Failed to list kept-alive tasks");

	const rows = resp.data as Array<{ seq: number; title: string; projectName: string; keepAlive: KeepAliveState | null }>;
	if (!rows.length) {
		process.stdout.write("No tasks are kept alive.\n");
		return;
	}
	for (const row of rows) {
		process.stdout.write(`#${row.seq}  ${row.title}  [${row.projectName}]  — ${describeState(row.keepAlive)}\n`);
	}
}

export async function handleKeepAlive(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case "on":
		case "enable":
			return setEnabled(true, args, socketPath, context);
		case "off":
		case "disable":
			return setEnabled(false, args, socketPath, context);
		case "status":
			return showStatus(args, socketPath, context);
		case "list":
			return listKeptAlive(args, socketPath, context);
		default:
			exitUsage(
				`Unknown subcommand: keep-alive ${subcommand || "(none)"}` +
					"\nAvailable: keep-alive on | off | status | list",
			);
	}
}
