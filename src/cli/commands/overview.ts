import type { Task } from "../../shared/types";
import { sendRequest } from "../socket-client";
import { exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, type CliContext } from "../context";

const OVERVIEW_MAX_LEN = 500;

function resolveTargetIds(
	args: ParsedArgs,
	context: CliContext | null,
): { taskId: string; projectId?: string } {
	const rawTaskId = args.flags.task || context?.taskId;
	if (!rawTaskId) {
		exitUsage("No task in context. Run from inside a worktree or pass --task <id>.");
	}
	const taskId = expandShortId(rawTaskId, context);
	const projectId = args.flags.project || context?.projectId || undefined;
	return { taskId, projectId };
}

async function setOverview(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	const raw = (args.positional[0] ?? args.flags.text ?? "").toString();
	const overview = raw.trim();
	if (!overview) {
		exitUsage('Usage: dev3 overview set "One clean paragraph describing the task."');
	}
	if (overview.length > OVERVIEW_MAX_LEN) {
		exitUsage(
			`Overview too long (${overview.length} chars). Keep it under ${OVERVIEW_MAX_LEN} characters — one paragraph.`,
		);
	}

	const { taskId, projectId } = resolveTargetIds(args, context);
	const params: Record<string, unknown> = { taskId, overview };
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "overview.set", params);
	if (!resp.ok) exitError(resp.error || "Failed to set overview");

	const task = resp.data as Task;
	process.stdout.write(
		`Overview set on task ${task.id.slice(0, 8)} (${overview.length} chars)\n`,
	);
}

async function showOverview(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	const { taskId, projectId } = resolveTargetIds(args, context);
	const params: Record<string, unknown> = { taskId };
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "overview.show", params);
	if (!resp.ok) exitError(resp.error || "Failed to load overview");

	const data = resp.data as {
		overview: string | null;
		userOverview: string | null;
		description: string;
	};

	const aiOverview = data.overview?.trim() || "";
	const userOverview = data.userOverview?.trim() || "";

	// If the user has edited the overview, their version is what the user
	// actually sees. Agents keep writing to `overview` freely, but surface
	// this state so they don't wonder why their edits don't show up.
	if (userOverview) {
		process.stdout.write(
			"(user-edited — the version below is what the user sees; agent edits to the AI overview are kept but hidden)\n\n",
		);
		process.stdout.write(`${userOverview}\n`);
		if (aiOverview && aiOverview !== userOverview) {
			process.stdout.write(`\n--- AI overview (currently hidden by user edit) ---\n${aiOverview}\n`);
		}
		return;
	}

	if (aiOverview) {
		process.stdout.write(`${aiOverview}\n`);
		return;
	}

	// No overview at all — show a hint + the raw description so the agent
	// can see what the task is actually about and write a proper overview.
	process.stdout.write("(no overview set — run `dev3 overview set \"...\"` to add one)\n");
	if (data.description) {
		process.stdout.write(`\n--- description ---\n${data.description}\n`);
	}
}

async function clearOverview(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	const { taskId, projectId } = resolveTargetIds(args, context);
	const params: Record<string, unknown> = { taskId };
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "overview.clear", params);
	if (!resp.ok) exitError(resp.error || "Failed to clear overview");

	const task = resp.data as Task;
	process.stdout.write(`Overview cleared on task ${task.id.slice(0, 8)}\n`);
}

export async function handleOverview(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case "set":
			return setOverview(args, socketPath, context);
		case "show":
			return showOverview(args, socketPath, context);
		case "clear":
			return clearOverview(args, socketPath, context);
		default:
			exitUsage(
				`Unknown subcommand: overview ${subcommand || "(none)"}` +
					"\nAvailable: overview set \"...\", overview show, overview clear",
			);
	}
}
