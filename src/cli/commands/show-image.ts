import { existsSync, statSync } from "node:fs";
import { extname, resolve as resolvePath } from "node:path";
import { sendRequest } from "../socket-client";
import { exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { MAX_SHARED_IMAGE_BYTES, MAX_SHARED_IMAGES_PER_CALL, SHARED_IMAGE_EXTS } from "../../shared/types";

const SUPPORTED = new Set(SHARED_IMAGE_EXTS);

function ext(path: string): string {
	return extname(path).replace(/^\./, "").toLowerCase();
}

/**
 * `dev3 show-image <path...>` — surface images (screenshots, renders, QA
 * captures) to the human in the running app, bound to the current task, as a
 * clickable history (newest activated first). Paths may be relative to the CWD
 * or absolute; they are copied into the task's worktree so the record survives
 * the original file being deleted.
 */
export async function handleShowImage(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project", "caption"]);

	if (args.positional.length === 0) {
		exitUsage('Usage: dev3 show-image <path...> [--caption "..."] [--task <id>]');
	}
	if (args.positional.length > MAX_SHARED_IMAGES_PER_CALL) {
		exitUsage(`Too many images (${args.positional.length}). Show at most ${MAX_SHARED_IMAGES_PER_CALL} per call.`);
	}

	// Resolve every path to absolute and validate up front — fail fast on the
	// first bad one so the agent gets a clear signal and nothing half-lands.
	const paths: string[] = [];
	for (const raw of args.positional) {
		const abs = resolvePath(process.cwd(), String(raw));
		if (!existsSync(abs)) {
			exitUsage(`File not found: ${raw}`);
		}
		if (!statSync(abs).isFile()) {
			exitUsage(`Not a file: ${raw}`);
		}
		const e = ext(abs);
		if (!SUPPORTED.has(e)) {
			exitUsage(`Unsupported image type "${e || "(none)"}" for ${raw}. Use: ${SHARED_IMAGE_EXTS.join(", ")}.`);
		}
		if (statSync(abs).size > MAX_SHARED_IMAGE_BYTES) {
			exitUsage(`Image too large: ${raw} (max ${Math.round(MAX_SHARED_IMAGE_BYTES / 1024 / 1024)} MB).`);
		}
		paths.push(abs);
	}

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) {
		exitUsage("No task in context. Run inside a worktree or pass --task <id> / --task-id <id>.");
	}

	const params: Record<string, unknown> = {
		taskId: expandShortId(rawTaskId, context),
		paths,
	};
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;
	const caption = (args.flags.caption ?? "").toString().trim();
	if (caption) params.caption = caption;

	const resp = await sendRequest(socketPath, "ui.show-image", params);
	if (!resp.ok) exitError(resp.error || "Failed to show image");

	const data = resp.data as { delivered: boolean; stored: number; taskId: string; suppressed?: boolean };
	const plural = data.stored === 1 ? "image" : "images";
	if (data.suppressed) {
		process.stdout.write(`Stored ${data.stored} ${plural} — focus mode is on, viewer not opened.\n`);
		return;
	}
	if (!data.delivered) {
		process.stdout.write(`Stored ${data.stored} ${plural}, but the app has no open window — nothing was shown.\n`);
		return;
	}
	process.stdout.write(`Shared ${data.stored} ${plural} to task ${data.taskId.slice(0, 8)}.\n`);
}
