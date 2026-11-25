import * as data from "./data";
import { createLogger } from "./logger";
import { findPathRefsInText, qualifyPathsFor, rewriteRelativePaths } from "../shared/path-refs";
import { annotateWithProjects, stripWithProjects, underRoot, writerOnly } from "./path-ref-resolve";

const log = createLogger("path-refs");

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

/** Text about to be stored: the absolute paths dev3 printed for an agent come back out. */
export async function withoutAbsolutePaths(text: string): Promise<string> {
	if (!text || findPathRefsInText(text).length === 0) return text;
	try {
		return stripWithProjects(text, await data.loadProjects());
	} catch (err) {
		log.warn("path annotation strip skipped", { error: String(err) });
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

/** {@link qualifyPathsFor} against the writer and reader project roots on disk; drops agent annotations first. */
export async function qualifyWriterPaths(text: string, writerProjectId: string | undefined, readerProjectId: string | undefined): Promise<string> {
	const stripped = await withoutAbsolutePaths(text);
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

/** Where a sender's relative paths live: its task worktree first, then the project folder. */
async function senderRoots(projectId: string, taskId: string | undefined): Promise<string[]> {
	const root = await projectRoot(projectId);
	if (!root) return [];
	try {
		const worktree = taskId ? (await data.getTask(await data.getProject(projectId), taskId)).worktreePath : null;
		return worktree && worktree !== root ? [worktree, root] : [root];
	} catch {
		return [root];
	}
}

/**
 * A message from another board, as its receiving agent reads it: a relative path that
 * exists in the sender's worktree or project becomes absolute (even one both boards
 * hold), and a `path:` token gains its absolute path.
 */
export async function absolutizeSenderPaths(text: string, sender: { projectId?: string; taskId?: string } | null | undefined, receiverProjectId: string): Promise<string> {
	let out = text;
	if (sender?.projectId && sender.projectId !== receiverProjectId) {
		const checks = (await senderRoots(sender.projectId, sender.taskId)).map((root) => ({ root, exists: writerOnly(root, null) }));
		if (checks.length > 0) {
			out = rewriteRelativePaths(out, (relative, line) => {
				const hit = checks.find(({ exists }) => exists(relative));
				return hit ? `${underRoot(hit.root, relative)}${line ? `:${line}` : ""}` : null;
			});
		}
	}
	return withAbsolutePaths(out);
}
