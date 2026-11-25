import { existsSync } from "node:fs";
import * as data from "./data";
import { annotatePathRefs, qualifyPathsFor, rewriteRelativePaths } from "../shared/path-refs";
import { resolvePathRefIn, underRoot } from "../shared/path-ref-resolve";

/** Text an agent will read: each `path:` token gains the absolute path it names on this machine. */
export async function withAbsolutePaths(text: string): Promise<string> {
	if (!text.includes("path:")) return text;
	const projects = await data.loadProjects();
	return annotatePathRefs(text, (ref) => {
		const absolute = resolvePathRefIn(projects, ref);
		return absolute && existsSync(absolute) ? absolute : null;
	});
}

/** {@link qualifyPathsFor} against the writer project's root on disk. */
export async function qualifyWriterPaths(text: string, writerProjectId: string | undefined, readerProjectId: string | undefined): Promise<string> {
	if (!text || !writerProjectId || writerProjectId === readerProjectId) return text;
	let root: string | null = null;
	try {
		const writer = await data.getProject(writerProjectId);
		root = writer.kind === "virtual" ? null : writer.path;
	} catch {
		return text;
	}
	if (!root) return text;
	const projectRoot = root;
	return qualifyPathsFor(text, writerProjectId, readerProjectId, (relative) => {
		const absolute = underRoot(projectRoot, relative);
		return !!absolute && existsSync(absolute);
	});
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
 * that exists on the sender's project becomes absolute, and a `path:` token gains
 * its absolute path. Same machine, read once, so no portable token is needed.
 */
export async function absolutizeSenderPaths(text: string, senderProjectId: string | undefined, receiverProjectId: string): Promise<string> {
	let out = text;
	if (senderProjectId && senderProjectId !== receiverProjectId) {
		try {
			const sender = await data.getProject(senderProjectId);
			if (sender.kind !== "virtual" && sender.path) {
				out = rewriteRelativePaths(out, (relative, line) => {
					const absolute = underRoot(sender.path, relative);
					return absolute && existsSync(absolute) ? `${absolute}${line ? `:${line}` : ""}` : null;
				});
			}
		} catch {
			// unknown sender project: its paths stay as written
		}
	}
	return withAbsolutePaths(out);
}
