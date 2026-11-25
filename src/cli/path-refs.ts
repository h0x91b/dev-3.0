import { existsSync } from "node:fs";
import { annotatePathRefs } from "../shared/path-refs";
import { resolvePathRefIn } from "../shared/path-ref-resolve";
import { readAllProjectsRaw } from "./context";

/** Text printed for an agent: each `path:` token gains the absolute path it names here. */
export function withAbsolutePaths(text: string): string {
	if (!text.includes("path:")) return text;
	const projects = readAllProjectsRaw();
	return annotatePathRefs(text, (ref) => {
		const absolute = resolvePathRefIn(projects, ref);
		return absolute && existsSync(absolute) ? absolute : null;
	});
}
