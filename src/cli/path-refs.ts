import { findPathRefsInText } from "../shared/path-refs";
import { annotateWithProjects } from "../bun/path-ref-resolve";
import { readAllProjectsRaw } from "./context";

/** Text printed for an agent: each `path:` token gains the absolute path it names here. */
export function withAbsolutePaths(text: string): string {
	if (findPathRefsInText(text).length === 0) return text;
	return annotateWithProjects(text, readAllProjectsRaw());
}
