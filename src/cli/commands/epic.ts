import type { CliResponse, Epic } from "../../shared/types";
import { EPIC_CREATE_FORBIDDEN_PREFIX, EPIC_REF_INVALID_PREFIX } from "../../shared/types";
import { CLI_EXIT_CODE_EPIC_CREATE_FORBIDDEN, CLI_EXIT_CODE_EPIC_REF_INVALID } from "../../shared/cli-exit-codes";
import { sendRequest } from "../socket-client";
import { exitError, exitUsage, printTable } from "../output";
import type { ParsedArgs } from "../args";
import type { CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { flagValue, isUnknownMethod, withBooleanFlags } from "./spaces";

/** Exit for a failed epic request, with the dedicated codes for a bad ref or a refused create. */
export function exitEpicRequestFailed(resp: CliResponse, fallback: string): never {
	const error = resp.error || fallback;
	if (error.startsWith(EPIC_REF_INVALID_PREFIX)) exitError(error.slice(EPIC_REF_INVALID_PREFIX.length), undefined, CLI_EXIT_CODE_EPIC_REF_INVALID);
	if (error.startsWith(EPIC_CREATE_FORBIDDEN_PREFIX)) exitError(error.slice(EPIC_CREATE_FORBIDDEN_PREFIX.length), undefined, CLI_EXIT_CODE_EPIC_CREATE_FORBIDDEN);
	if (isUnknownMethod(resp)) exitError(error, "The running dev3 app is older than this CLI. Update or restart the app, then retry.");
	exitError(error);
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function describe(epic: Epic): string {
	return `${epic.id.slice(0, 8)} "${epic.name}" ${epic.color}${epic.archived ? " (archived)" : ""}`;
}

async function listEpics(args: ParsedArgs, socketPath: string): Promise<void> {
	rejectUnknownFlags(args, ["json", "all"]);
	const resp = await sendRequest(socketPath, "epic.list");
	if (!resp.ok) exitEpicRequestFailed(resp, "Failed to list epics");
	const all = resp.data as Array<Epic & { taskCount: number }>;
	const epics = "all" in args.flags ? all : all.filter((e) => !e.archived);
	if ("json" in args.flags) return printJson(epics);
	if (epics.length === 0) {
		const hidden = all.length - epics.length;
		process.stdout.write(hidden > 0
			? `No active epics (${hidden} archived — see them with --all).\n`
			: 'No epics. Create one with: dev3 epic create --name "Payments v2"\n');
		return;
	}
	printTable(
		["ID", "COLOR", "NAME", "STATE", "TASKS"],
		[...epics].sort((a, b) => a.name.localeCompare(b.name)).map((e) => [
			e.id.slice(0, 8),
			e.color,
			e.name,
			e.archived ? "archived" : "active",
			String(e.taskCount),
		]),
	);
}

async function createEpic(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["name", "color", "json"]);
	const name = (flagValue(args, "name") ?? args.positional[0] ?? "").trim();
	if (!name || args.positional.length > 1) exitUsage('Usage: dev3 epic create --name "Payments v2" [--color #3b82f6]');
	const params: Record<string, unknown> = { name };
	const color = flagValue(args, "color");
	if (color) params.color = color;
	// The app decides who may create: the user outside any task, or a coordinator.
	if (context?.taskId) params.sourceTaskId = context.taskId;
	const resp = await sendRequest(socketPath, "epic.create", params);
	if (!resp.ok) exitEpicRequestFailed(resp, "Failed to create epic");
	const epic = resp.data as Epic;
	if ("json" in args.flags) return printJson(epic);
	process.stdout.write(`Created epic ${describe(epic)}\nAttach a task: dev3 task update --epic ${epic.id.slice(0, 8)}\n`);
}

async function updateEpic(
	verb: "update" | "archive" | "unarchive",
	args: ParsedArgs,
	socketPath: string,
): Promise<void> {
	rejectUnknownFlags(args, verb === "update" ? ["name", "color", "json"] : ["json"]);
	const ref = args.positional[0];
	if (!ref || args.positional.length > 1) exitUsage(`Usage: dev3 epic ${verb} <name|id>${verb === "update" ? " [--name \"...\"] [--color #hex]" : ""}  (quote a name with spaces)`);
	const params: Record<string, unknown> = { epic: ref };
	if (verb === "update") {
		const name = flagValue(args, "name");
		const color = flagValue(args, "color");
		if (name === undefined && color === undefined) exitUsage("Nothing to update. Provide --name or --color.");
		if (name !== undefined) params.name = name;
		if (color !== undefined) params.color = color;
	} else {
		params.archived = verb === "archive";
	}
	const resp = await sendRequest(socketPath, "epic.update", params);
	if (!resp.ok) exitEpicRequestFailed(resp, `Failed to ${verb} epic`);
	const epic = resp.data as Epic;
	if ("json" in args.flags) return printJson(epic);
	const past = verb === "update" ? "Updated" : verb === "archive" ? "Archived" : "Unarchived";
	process.stdout.write(`${past} epic ${describe(epic)}\n`);
}

export async function handleEpic(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	args = withBooleanFlags(args, ["json", "all"]);
	switch (subcommand) {
		case undefined:
		case "list":
			return listEpics(args, socketPath);
		case "create":
			return createEpic(args, socketPath, context);
		case "update":
		case "archive":
		case "unarchive":
			return updateEpic(subcommand, args, socketPath);
		default:
			exitUsage(`Unknown subcommand: epic ${subcommand}\nAvailable: epic list, epic create, epic update, epic archive, epic unarchive`);
	}
}
