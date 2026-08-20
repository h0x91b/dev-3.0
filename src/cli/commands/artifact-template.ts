import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { ARTIFACT_TEMPLATE_FILES } from "../../shared/artifact-template";
import type { ParsedArgs } from "../args";
import { expandShortId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { exitError, exitUsage } from "../output";
import { sendRequest } from "../socket-client";

const USAGE = "Usage: dev3 artifact-template [--task <id|seq:N>]";

/** Where the copy lands, matching the path the artifact workflow already documents. */
const TARGET_DIR_NAME = "dev3-artifact-report";

/**
 * `dev3 artifact-template` — put a fresh copy of this task's artifact starter
 * into ./dev3-artifact-report and print where it went.
 *
 * `DEV3_ARTIFACT_TEMPLATE_DIR` is baked into a session's environment when the
 * agent is launched, so a session started by an older app version — or a shell
 * that never inherited that env — cannot reach the starter at all. This command
 * is that recovery path (issue #1437). Re-running it restores the managed files
 * over an existing copy.
 */
export async function handleArtifactTemplate(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id"]);

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) exitUsage(`No task in context — pass --task.\n${USAGE}`);

	const params: Record<string, unknown> = { taskId: expandShortId(String(rawTaskId), context) };
	if (context?.projectId) params.projectId = context.projectId;
	if (context?.worktreePath) params.worktreePath = context.worktreePath;

	const response = await sendRequest(socketPath, "artifact.template-dir", params);
	if (!response.ok) exitError(response.error || "Failed to provision the dev3 artifact starter");
	const sourceDir = (response.data as { dir: string }).dir;

	const target = resolvePath(process.cwd(), TARGET_DIR_NAME);
	mkdirSync(target, { recursive: true });
	for (const name of ARTIFACT_TEMPLATE_FILES) {
		const source = join(sourceDir, name);
		if (!existsSync(source)) exitError(`The dev3 artifact starter is incomplete — ${name} is missing from ${sourceDir}`);
		copyFileSync(source, join(target, name));
	}

	process.stdout.write(`${target}\n`);
}
