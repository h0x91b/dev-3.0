import { existsSync } from "node:fs";
import * as data from "./data";
import { createLogger } from "./logger";
import { findPathRefsInText, qualifyPathsFor, rewriteRelativePaths, stripPathAnnotations } from "../shared/path-refs";
import { annotateWithProjects, underRoot } from "./path-ref-resolve";

const log = createLogger("path-refs");

/** Distinct relative paths checked on disk per text, as `resolveTerminalPaths` caps its batch. */
const MAX_PATH_CHECKS = 64;

/** Text an agent will read: each `path:` token gains the absolute path it names on this machine. */
export async function withAbsolutePaths(text: string, maxAdded?: number): Promise<string> {
	if (!text || findPathRefsInText(text).length === 0) return text;
	try {
		return annotateWithProjects(text, await data.loadProjects(), maxAdded);
	} catch (err) {
		log.warn("path annotation skipped", { error: String(err) });
		return text;
	}
}

async function projectRoot(projectId: string | undefined): Promise<string | null> {
	if (!projectId) return null;
	try {
		const project = await data.getProject(projectId);
		return project.kind === "virtual" || !project.path ? null : project.path;
	} catch {
		return null;
	}
}

/**
 * Whether a relative path names the writer's file and not the reader's: a path
 * both boards hold (`README.md`) is ambiguous and stays as written. Memoized and capped.
 */
function writerOnly(writerRoot: string, readerRoot: string | null): (relative: string) => boolean {
	const seen = new Map<string, boolean>();
	return (relative) => {
		const known = seen.get(relative);
		if (known !== undefined) return known;
		if (seen.size >= MAX_PATH_CHECKS) return false;
		const onWriter = underRoot(writerRoot, relative);
		const onReader = readerRoot ? underRoot(readerRoot, relative) : null;
		const result = !!onWriter && existsSync(onWriter) && !(onReader && existsSync(onReader));
		seen.set(relative, result);
		return result;
	};
}

/** {@link qualifyPathsFor} against the writer and reader project roots on disk; drops agent annotations first. */
export async function qualifyWriterPaths(text: string, writerProjectId: string | undefined, readerProjectId: string | undefined): Promise<string> {
	const stripped = stripPathAnnotations(text);
	if (!stripped || !writerProjectId || writerProjectId === readerProjectId) return stripped;
	const writerRoot = await projectRoot(writerProjectId);
	if (!writerRoot) return stripped;
	const exists = writerOnly(writerRoot, await projectRoot(readerProjectId));
	return qualifyPathsFor(stripped, writerProjectId, readerProjectId, exists);
}

/**
 * {@link qualifyWriterPaths} for an edit of `previous`: a line already in
 * `previous` stays as written, as `qualifyEditedRefsFor` does for task refs.
 */
export async function qualifyEditedWriterPaths(text: string, previous: string | null | undefined, writerProjectId: string | undefined, readerProjectId: string | undefined): Promise<string> {
	const qualified = await qualifyWriterPaths(text, writerProjectId, readerProjectId);
	if (qualified === text || !previous) return qualified;
	const kept = new Set(previous.split("\n"));
	const original = text.split("\n");
	return qualified.split("\n").map((line, i) => (kept.has(original[i]!) ? original[i]! : line)).join("\n");
}

/**
 * A message from another board, as its receiving agent reads it: a relative path
 * only the sender's project holds becomes absolute, and a `path:` token gains its
 * absolute path. Same machine, read once, so no portable token is needed.
 */
export async function absolutizeSenderPaths(text: string, senderProjectId: string | undefined, receiverProjectId: string): Promise<string> {
	let out = text;
	if (senderProjectId && senderProjectId !== receiverProjectId) {
		const senderRoot = await projectRoot(senderProjectId);
		if (senderRoot) {
			const exists = writerOnly(senderRoot, await projectRoot(receiverProjectId));
			out = rewriteRelativePaths(out, (relative, line) => {
				if (!exists(relative)) return null;
				return `${underRoot(senderRoot, relative)}${line ? `:${line}` : ""}`;
			});
		}
	}
	return withAbsolutePaths(out);
}
