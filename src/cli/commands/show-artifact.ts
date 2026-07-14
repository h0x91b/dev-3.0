import { existsSync, statSync } from "node:fs";
import { extname, resolve as resolvePath } from "node:path";
import {
	MAX_SHARED_ARTIFACT_HTML_BYTES,
	MAX_SHARED_ARTIFACT_IMAGES,
	MAX_SHARED_IMAGE_BYTES,
	SHARED_IMAGE_EXTS,
} from "../../shared/types";
import { resolveValue } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { exitError, exitUsage } from "../output";
import { sendRequest } from "../socket-client";

const IMAGE_EXTS = new Set(SHARED_IMAGE_EXTS);
const VALUE_FLAGS = new Set(["title", "task", "task-id", "project"]);

function nextValue(argv: string[], index: number, flag: string): { value: string; index: number } {
	const next = argv[index + 1];
	if (!next || next.startsWith("--")) exitUsage(`--${flag} requires a value`);
	return { value: resolveValue(next), index: index + 1 };
}

/** `dev3 show-artifact report.html --images chart.png diagram.webp --title "Report"`. */
export async function handleShowArtifact(argv: string[], socketPath: string, context: CliContext | null): Promise<void> {
	let html = "";
	let collectingImages = false;
	const images: string[] = [];
	const flags: Record<string, string> = {};

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--images") {
			collectingImages = true;
			continue;
		}
		if (token.startsWith("--images=")) {
			collectingImages = true;
			const value = resolveValue(token.slice("--images=".length));
			if (value) images.push(value);
			continue;
		}
		if (token.startsWith("--")) {
			collectingImages = false;
			const eq = token.indexOf("=");
			const key = token.slice(2, eq === -1 ? undefined : eq);
			if (!VALUE_FLAGS.has(key)) exitUsage(`Unknown flag: --${key}`);
			if (eq !== -1) flags[key] = resolveValue(token.slice(eq + 1));
			else {
				const result = nextValue(argv, i, key);
				flags[key] = result.value;
				i = result.index;
			}
			continue;
		}
		const value = resolveValue(token);
		if (collectingImages) images.push(value);
		else if (!html) html = value;
		else exitUsage(`Unexpected path: ${token}. Put image assets after --images.`);
	}

	if (!html) exitUsage('Usage: dev3 show-artifact <file.html> [--images <image...>] [--title "..."] [--task <id>]');
	const htmlPath = resolvePath(process.cwd(), html);
	if (!existsSync(htmlPath) || !statSync(htmlPath).isFile()) exitUsage(`HTML file not found: ${html}`);
	if (extname(htmlPath).toLowerCase() !== ".html") exitUsage(`Artifact must be an .html file: ${html}`);
	if (statSync(htmlPath).size > MAX_SHARED_ARTIFACT_HTML_BYTES) exitUsage("HTML artifact is too large (max 5 MB)");
	if (images.length > MAX_SHARED_ARTIFACT_IMAGES) exitUsage(`Too many images (max ${MAX_SHARED_ARTIFACT_IMAGES})`);

	const imagePaths = images.map((path) => {
		const absolute = resolvePath(process.cwd(), path);
		if (!existsSync(absolute) || !statSync(absolute).isFile()) exitUsage(`Image file not found: ${path}`);
		const ext = extname(absolute).replace(/^\./, "").toLowerCase();
		if (!IMAGE_EXTS.has(ext)) exitUsage(`Unsupported artifact image type "${ext || "(none)"}": ${path}`);
		if (statSync(absolute).size > MAX_SHARED_IMAGE_BYTES) exitUsage(`Artifact image is too large: ${path}`);
		return absolute;
	});

	const rawTaskId = flags.task || flags["task-id"] || context?.taskId;
	if (!rawTaskId) exitUsage("No task in context. Run inside a worktree or pass --task <id> / --task-id <id>.");
	const params: Record<string, unknown> = {
		taskId: expandShortId(rawTaskId, context),
		htmlPath,
		imagePaths,
	};
	const projectId = resolveProjectId(flags.project, context);
	if (projectId) params.projectId = projectId;
	if (flags.title?.trim()) params.title = flags.title.trim();

	const response = await sendRequest(socketPath, "ui.show-artifact", params);
	if (!response.ok) exitError(response.error || "Failed to show artifact");
	const data = response.data as { delivered: boolean; stored: number; taskId: string; queued?: boolean; suppressed?: boolean };
	if (data.queued) process.stdout.write("Stored artifact — viewer queued until Focus Mode ends.\n");
	else if (data.suppressed) process.stdout.write("Stored artifact — focus mode is on, viewer not opened.\n");
	else if (!data.delivered) process.stdout.write("Stored artifact, but the app has no open window — nothing was shown.\n");
	else process.stdout.write(`Shared artifact to task ${data.taskId.slice(0, 8)}.\n`);
}
