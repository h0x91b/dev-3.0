import { existsSync, statSync } from "node:fs";
import { extname, resolve as resolvePath } from "node:path";
import { sendRequest } from "../socket-client";
import { exitError, exitUsage } from "../output";
import { resolveValue } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { MAX_SHARED_IMAGE_BYTES, MAX_SHARED_IMAGES_PER_CALL, SHARED_IMAGE_EXTS } from "../../shared/types";

const SUPPORTED = new Set(SHARED_IMAGE_EXTS);
// Flags that take a value; anything else with a leading "--" is rejected.
const GLOBAL_VALUE_FLAGS = new Set(["task", "task-id", "project"]);

function ext(path: string): string {
	return extname(path).replace(/^\./, "").toLowerCase();
}

/**
 * `dev3 show-image <path> [--caption "..."] <path> [--caption "..."] ...` —
 * surface images (screenshots, renders, QA captures) to the human in the running
 * app, bound to the current task, as a clickable history (newest activated
 * first). Paths may be relative to the CWD or absolute; they are copied into the
 * task's worktree so the record survives the original file being deleted.
 *
 * Parsing is ORDER-AWARE (unlike the shared `parseArgs`): a `--caption`/`-c`
 * binds to the image path that immediately precedes it, so each screenshot can
 * carry its own note ("what to look at here"). Global flags (`--task`,
 * `--task-id`, `--project`) may appear anywhere.
 */
export async function handleShowImage(
	argv: string[],
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	const items: { path: string; caption?: string }[] = [];
	const flags: Record<string, string> = {};

	for (let i = 0; i < argv.length; i++) {
		let tok = argv[i];
		if (tok === "-c") tok = "--caption";

		if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			let key: string;
			let value: string;
			if (eq !== -1) {
				key = tok.slice(2, eq);
				value = resolveValue(tok.slice(eq + 1));
			} else {
				key = tok.slice(2);
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					value = resolveValue(next);
					i++;
				} else {
					value = "";
				}
			}

			if (key === "caption") {
				if (items.length === 0) {
					exitUsage('`--caption` must follow an image path, e.g. `dev3 show-image a.png --caption "..."`.');
				}
				const caption = value.trim();
				if (caption) items[items.length - 1].caption = caption;
			} else if (GLOBAL_VALUE_FLAGS.has(key)) {
				flags[key] = value;
			} else {
				exitUsage(`Unknown flag: --${key}`);
			}
		} else {
			items.push({ path: resolveValue(tok) });
		}
	}

	if (items.length === 0) {
		exitUsage('Usage: dev3 show-image <path> [--caption "..."] [<path> ...] [--task <id>]');
	}
	if (items.length > MAX_SHARED_IMAGES_PER_CALL) {
		exitUsage(`Too many images (${items.length}). Show at most ${MAX_SHARED_IMAGES_PER_CALL} per call.`);
	}

	// Resolve every path to absolute and validate up front — fail fast on the
	// first bad one so the agent gets a clear signal and nothing half-lands.
	const images: { path: string; caption?: string }[] = [];
	for (const it of items) {
		const abs = resolvePath(process.cwd(), it.path);
		if (!existsSync(abs)) {
			exitUsage(`File not found: ${it.path}`);
		}
		if (!statSync(abs).isFile()) {
			exitUsage(`Not a file: ${it.path}`);
		}
		const e = ext(abs);
		if (!SUPPORTED.has(e)) {
			exitUsage(`Unsupported image type "${e || "(none)"}" for ${it.path}. Use: ${SHARED_IMAGE_EXTS.join(", ")}.`);
		}
		if (statSync(abs).size > MAX_SHARED_IMAGE_BYTES) {
			exitUsage(`Image too large: ${it.path} (max ${Math.round(MAX_SHARED_IMAGE_BYTES / 1024 / 1024)} MB).`);
		}
		images.push(it.caption ? { path: abs, caption: it.caption } : { path: abs });
	}

	const rawTaskId = flags.task || flags["task-id"] || context?.taskId;
	if (!rawTaskId) {
		exitUsage("No task in context. Run inside a worktree or pass --task <id> / --task-id <id>.");
	}

	const params: Record<string, unknown> = {
		taskId: expandShortId(rawTaskId, context),
		images,
	};
	const projectId = resolveProjectId(flags.project, context);
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "ui.show-image", params);
	if (!resp.ok) exitError(resp.error || "Failed to show image");

	const data = resp.data as { delivered: boolean; stored: number; taskId: string; queued?: boolean; suppressed?: boolean };
	const plural = data.stored === 1 ? "image" : "images";
	if (data.queued) {
		process.stdout.write(`Stored ${data.stored} ${plural} — viewer queued until Focus Mode ends.\n`);
		return;
	}
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
