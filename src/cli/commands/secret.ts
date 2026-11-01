import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { exitError, exitUsage } from "../output";
import { sendRequest } from "../socket-client";
import { SECRET_RUN_MS, SECRET_WAIT_MS, validateSecretCommand, type SecretResult } from "../../shared/secret-request";

export async function handleSecret(subcommand: string | undefined, args: ParsedArgs, socket: string, context: CliContext | null): Promise<void> {
	if (subcommand !== "run") exitUsage("Usage: dev3 secret run --env NAME -- command [args...]");
	rejectUnknownFlags(args, ["env", "task", "task-id", "project"]);
	if (args.positional.length) exitUsage("Put the command after --.");
	try { validateSecretCommand(args.flags.env, args.passthrough); }
	catch { exitUsage("Supply --env NAME and a command after --. Never pass the secret on the command line."); }
	const task = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!task) exitUsage("Run inside a task worktree or pass --task <id>.");
	const response = await sendRequest(socket, "secret.run", {
		taskId: expandShortId(task, context), projectId: resolveProjectId(args.flags.project, context),
		env: args.flags.env, command: args.passthrough,
	}, { timeoutMs: SECRET_WAIT_MS + SECRET_RUN_MS + 30_000 });
	if (!response.ok) exitError(response.error || "Secret command failed.");
	const result = response.data as SecretResult;
	if (result.status !== "finished") exitError(`Secret command ${result.status}. No output was returned.`);
	if (result.exitCode !== 0) exitError(`Secret command exited with status ${result.exitCode}. Output was discarded.`);
	process.stdout.write("Secret command succeeded. Output was discarded.\n");
}
