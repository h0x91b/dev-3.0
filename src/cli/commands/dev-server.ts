import type { DevServerStatus } from "../../shared/types";
import { sendRequest } from "../socket-client";
import { printDetail, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, type CliContext } from "../context";

function resolveTaskId(args: ParsedArgs, context: CliContext | null): string | undefined {
	const raw = args.positional[0] || args.flags.id || context?.taskId;
	if (!raw) return undefined;
	return expandShortId(raw, context);
}

function formatAssignedPorts(status: DevServerStatus): string {
	if (status.assignedPorts.length === 0) return "(none allocated)";
	return status.assignedPorts.map((port, index) => `DEV3_PORT${index}=${port}`).join(", ");
}

function formatDetectedPorts(status: DevServerStatus): string {
	if (status.ports.length === 0) return "(none detected)";
	return status.ports.map((port) => `${port.port} (${port.processName} pid ${port.pid})`).join(", ");
}

function formatPids(status: DevServerStatus): string {
	if (status.panePids.length === 0) return "(none)";
	return status.panePids.join(", ");
}

function printStatusLine(action: string, status: DevServerStatus): void {
	const shortTaskId = status.taskId.slice(0, 8);
	switch (action) {
		case "start":
			process.stdout.write(`Started dev server for task ${shortTaskId}\n`);
			return;
		case "restart":
			process.stdout.write(`Restarted dev server for task ${shortTaskId}\n`);
			return;
		case "stop":
			process.stdout.write(`Stopped dev server for task ${shortTaskId}\n`);
			return;
		default:
			process.stdout.write(`Dev server is ${status.running ? "running" : "stopped"} for task ${shortTaskId}\n`);
	}
}

function printStatusDetails(status: DevServerStatus): void {
	const fields: Array<[string, string]> = [
		["State:", status.running ? "running" : "stopped"],
		["Task:", status.taskId.slice(0, 8)],
		["Session:", status.devSessionName],
		["Viewer Pane:", status.viewerPaneId ?? "(none)"],
		["Socket:", status.tmuxSocket],
		["Worktree:", status.worktreePath ?? "(none)"],
		["Pane PIDs:", formatPids(status)],
		["Assigned Ports:", formatAssignedPorts(status)],
		["Detected Ports:", formatDetectedPorts(status)],
	];

	if (status.resourceUsage) {
		fields.push(["CPU:", String(status.resourceUsage.cpu)]);
		fields.push(["Memory:", String(status.resourceUsage.rss)]);
	}

	printDetail(fields);
}

async function runAction(
	action: "start" | "stop" | "restart" | "status",
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage(`Usage: dev3 dev-server ${action} <task-id>`);
	}

	const params: Record<string, unknown> = { taskId };
	if (args.flags.project) params.projectId = args.flags.project;
	else if (context?.projectId) params.projectId = context.projectId;

	const resp = await sendRequest(socketPath, `devServer.${action}`, params);
	if (!resp.ok) exitError(resp.error || `Failed to ${action} dev server`);

	printStatusLine(action, resp.data as DevServerStatus);
	printStatusDetails(resp.data as DevServerStatus);
}

export async function handleDevServer(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case undefined:
		case "status":
			return runAction("status", args, socketPath, context);
		case "start":
			return runAction("start", args, socketPath, context);
		case "stop":
			return runAction("stop", args, socketPath, context);
		case "restart":
			return runAction("restart", args, socketPath, context);
		default:
			exitUsage(
				`Unknown subcommand: dev-server ${subcommand}` +
				"\nAvailable: dev-server start, dev-server stop, dev-server restart, dev-server status",
			);
	}
}
