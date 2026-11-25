import * as nodePath from "node:path";
import { existsSync } from "node:fs";
import { annotatePathRefs, type PathRef } from "../shared/path-refs";
import { projectMatchesQualifier } from "../shared/task-refs";

interface ProjectRoot {
	id: string;
	name?: string;
	path: string;
	kind?: string;
}

/**
 * The absolute path a token names, joined with the host's separator, or null
 * when the qualifier matches no single real project or the path leaves its root.
 * Existence is the caller's check.
 */
export function resolvePathRefIn(projects: readonly ProjectRoot[], ref: PathRef, pathApi: PathApi = nodePath): string | null {
	const matches = projects.filter((p) => p.kind !== "virtual" && !!p.path && projectMatchesQualifier(p, ref.project));
	if (matches.length !== 1) return null;
	return underRoot(matches[0]!.path, ref.path, pathApi);
}

/** The host's path module by default; a parameter so tests can run Windows and POSIX alike. */
type PathApi = Pick<typeof nodePath, "resolve" | "sep">;

/** `relative` (`/`-separated) joined onto `root`, or null when it would leave the root. */
export function underRoot(root: string, relative: string, pathApi: PathApi = nodePath): string | null {
	const base = pathApi.resolve(root);
	const absolute = pathApi.resolve(base, ...relative.split("/"));
	const prefix = base.endsWith(pathApi.sep) ? base : `${base}${pathApi.sep}`;
	return absolute === base || absolute.startsWith(prefix) ? absolute : null;
}

/** `text` for an agent on this machine: each token that names an existing file gains its absolute path. */
export function annotateWithProjects(text: string, projects: readonly ProjectRoot[], maxAdded?: number): string {
	return annotatePathRefs(text, (ref) => {
		const absolute = resolvePathRefIn(projects, ref);
		return absolute && existsSync(absolute) ? absolute : null;
	}, maxAdded);
}
