import { sendRequest } from "../socket-client";
import { exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";

interface BoardExportData {
	dir: string;
	taskCount: number;
	written: number;
	removed: number;
}

async function exportBoard(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "json"]);
	const projectId = resolveProjectId(args.flags.project, context);
	if (!projectId) {
		exitUsage("--project <id> is required (or run from the project's worktree or checkout)");
	}

	const resp = await sendRequest(socketPath, "board.export", { projectId });
	if (!resp.ok) exitError(resp.error || "Failed to write the board copy");

	const result = resp.data as BoardExportData;
	if (args.flags.json) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	process.stdout.write(
		`Board copy written to ${result.dir}: ${result.taskCount} task(s), ${result.written} file(s) written, ${result.removed} removed\n`,
	);
}

export async function handleBoard(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case "export":
			return exportBoard(args, socketPath, context);
		default:
			exitUsage(`Unknown subcommand: board ${subcommand || "(none)"}\nAvailable: board export`);
	}
}
