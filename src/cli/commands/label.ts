import type { Label, Task } from "../../shared/types";
import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, type CliContext } from "../context";

async function listLabels(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const projectId = args.flags.project || context?.projectId;
	if (!projectId) {
		exitUsage("--project <id> is required (or run from inside a worktree)");
	}

	const resp = await sendRequest(socketPath, "label.list", { projectId });
	if (!resp.ok) exitError(resp.error || "Failed to list labels");

	const labels = resp.data as Label[];
	if (labels.length === 0) {
		process.stdout.write("No labels\n");
		return;
	}

	printTable(
		["ID", "COLOR", "NAME"],
		labels.map((l) => [l.id.slice(0, 8), l.color, l.name]),
	);
}

async function createLabel(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const projectId = args.flags.project || context?.projectId;
	if (!projectId) {
		exitUsage("--project <id> is required (or run from inside a worktree)");
	}

	const name = (args.flags.name || args.positional[0] || "").trim();
	if (!name) {
		exitUsage('Usage: dev3 label create --name "bug" (or dev3 label create "bug")');
	}

	const params: Record<string, unknown> = { projectId, name };
	if (args.flags.color) params.color = args.flags.color;

	const resp = await sendRequest(socketPath, "label.create", params);
	if (!resp.ok) exitError(resp.error || "Failed to create label");

	const label = resp.data as Label;
	process.stdout.write(`Created label ${label.id.slice(0, 8)} "${label.name}" (${label.color})\n`);
}

async function deleteLabel(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const projectId = args.flags.project || context?.projectId;
	if (!projectId) {
		exitUsage("--project <id> is required (or run from inside a worktree)");
	}

	const labelId = args.positional[0] || args.flags.id;
	if (!labelId) {
		exitUsage("Usage: dev3 label delete <label-id>");
	}

	const resp = await sendRequest(socketPath, "label.delete", { projectId, labelId });
	if (!resp.ok) exitError(resp.error || "Failed to delete label");

	process.stdout.write(`Deleted label ${labelId.slice(0, 8)}\n`);
}

async function setTaskLabels(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const projectId = args.flags.project || context?.projectId;
	if (!projectId) {
		exitUsage("--project <id> is required (or run from inside a worktree)");
	}

	const rawTaskId = args.flags.task || context?.taskId;
	if (!rawTaskId) {
		exitUsage("--task <id> is required (or run from inside a worktree)");
	}
	const taskId = expandShortId(rawTaskId, context);

	// Collect label IDs from positional args
	const labelIds = args.positional;
	if (labelIds.length === 0) {
		exitUsage('Usage: dev3 label set <label-id> [<label-id> ...]\nUse "dev3 label set --clear" to remove all labels.');
	}

	const resp = await sendRequest(socketPath, "task.setLabels", { taskId, projectId, labelIds });
	if (!resp.ok) exitError(resp.error || "Failed to set labels");

	const task = resp.data as Task;
	process.stdout.write(`Set ${task.labelIds?.length ?? 0} label(s) on task ${task.id.slice(0, 8)}\n`);
}

async function clearTaskLabels(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const projectId = args.flags.project || context?.projectId;
	if (!projectId) {
		exitUsage("--project <id> is required (or run from inside a worktree)");
	}

	const rawTaskId = args.flags.task || context?.taskId;
	if (!rawTaskId) {
		exitUsage("--task <id> is required (or run from inside a worktree)");
	}
	const taskId = expandShortId(rawTaskId, context);

	const resp = await sendRequest(socketPath, "task.setLabels", { taskId, projectId, labelIds: [] });
	if (!resp.ok) exitError(resp.error || "Failed to clear labels");

	process.stdout.write(`Cleared all labels from task ${taskId.slice(0, 8)}\n`);
}

export async function handleLabel(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case "list":
			return listLabels(args, socketPath, context);
		case "create":
			return createLabel(args, socketPath, context);
		case "delete":
			return deleteLabel(args, socketPath, context);
		case "set":
			if (args.flags.clear === "true") {
				return clearTaskLabels(args, socketPath, context);
			}
			return setTaskLabels(args, socketPath, context);
		default:
			exitUsage(
				`Unknown subcommand: label ${subcommand || "(none)"}` +
				"\nAvailable: label list, label create, label delete, label set",
			);
	}
}
