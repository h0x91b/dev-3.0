import type { Label, Task } from "../../shared/types";
import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";

async function listLabels(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project"]);
	const projectId = resolveProjectId(args.flags.project, context);
	if (!projectId) {
		exitUsage("--project <id> is required (or run from the project's worktree or checkout)");
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
	rejectUnknownFlags(args, ["project", "name", "color"]);
	const projectId = resolveProjectId(args.flags.project, context);
	if (!projectId) {
		exitUsage("--project <id> is required (or run from the project's worktree or checkout)");
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
	rejectUnknownFlags(args, ["project", "id"]);
	const projectId = resolveProjectId(args.flags.project, context);
	if (!projectId) {
		exitUsage("--project <id> is required (or run from the project's worktree or checkout)");
	}

	const labelId = args.positional[0] || args.flags.id;
	if (!labelId) {
		exitUsage("Usage: dev3 label delete <label-id>");
	}

	const resp = await sendRequest(socketPath, "label.delete", { projectId, labelId });
	if (!resp.ok) exitError(resp.error || "Failed to delete label");

	process.stdout.write(`Deleted label ${labelId.slice(0, 8)}\n`);
}

type LabelChange = "set" | "add" | "remove";

const LABEL_CHANGE_METHOD: Record<LabelChange, string> = {
	set: "task.setLabels",
	add: "task.addLabels",
	remove: "task.removeLabels",
};

/**
 * `label set` REPLACES the task's whole label set; `label add` / `label remove`
 * change only the named labels and leave the rest alone.
 */
async function changeTaskLabels(
	change: LabelChange,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project"]);
	const projectId = resolveProjectId(args.flags.project, context);
	if (!projectId) {
		exitUsage("--project <id> is required (or run from the project's worktree or checkout)");
	}

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) {
		exitUsage("--task <id> or --task-id <id> is required (or run from inside a worktree)");
	}
	const taskId = expandShortId(rawTaskId, context);

	const labelIds = args.positional;
	if (labelIds.length === 0) {
		exitUsage(
			change === "set"
				? 'Usage: dev3 label set <label-id> [<label-id> ...]  (replaces ALL of the task\'s labels)\n' +
					'Use "dev3 label add" to keep the existing ones, "dev3 label set --clear" to remove all.'
				: `Usage: dev3 label ${change} <label-id> [<label-id> ...]`,
		);
	}

	const resp = await sendRequest(socketPath, LABEL_CHANGE_METHOD[change], { taskId, projectId, labelIds });
	if (!resp.ok) exitError(resp.error || `Failed to ${change} labels`);

	const task = resp.data as Task;
	const now = task.labelIds ?? [];
	const verb = change === "set" ? "Set" : change === "add" ? "Added" : "Removed";
	process.stdout.write(
		`${verb} label(s) on task ${task.id.slice(0, 8)}; it now has ${now.length}: ` +
			`${now.length > 0 ? now.map((id) => id.slice(0, 8)).join(", ") : "(none)"}\n`,
	);
}

async function clearTaskLabels(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project", "clear"]);
	const projectId = resolveProjectId(args.flags.project, context);
	if (!projectId) {
		exitUsage("--project <id> is required (or run from the project's worktree or checkout)");
	}

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) {
		exitUsage("--task <id> or --task-id <id> is required (or run from inside a worktree)");
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
			return changeTaskLabels("set", args, socketPath, context);
		case "add":
		case "remove":
			return changeTaskLabels(subcommand, args, socketPath, context);
		default:
			exitUsage(
				`Unknown subcommand: label ${subcommand || "(none)"}` +
				"\nAvailable: label list, label create, label delete, label set, label add, label remove",
			);
	}
}
