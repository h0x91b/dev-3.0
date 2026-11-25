// Cross-project file tokens: `<path:a1c9fe4e/todo/x.md>` or bare `path:a1c9fe4e/src/app.ts:12`,
// a `/`-separated path relative to that project's root that never climbs out of it.
// Grammar and why: decisions/2026/11/24/cross-project-path-tokens.md.

import { findPathCandidates, isRootedPathText } from "./path-candidates";
import { findRefsInText, projectRefQualifier, QUALIFIER } from "./task-refs";

export interface PathRef {
	/** Project qualifier as written (id prefix or project name). */
	project: string;
	/** Project-relative path, `/`-separated. */
	path: string;
	line?: number;
}

export interface PathRefMatch {
	ref: PathRef;
	raw: string;
	start: number;
	/** Exclusive end index in the scanned text. */
	end: number;
}

const SEGMENT = String.raw`[\w.@%+,=~-]+`;
const BODY = String.raw`path:(${QUALIFIER})\/((?:${SEGMENT}\/)*${SEGMENT})(?::(\d{1,9}))?`;
const PATH_REF_TEXT_REGEX = new RegExp(String.raw`<${BODY}>|(?<![\w/:.<-])${BODY}`, "g");
const PATH_REF_URI_REGEX = new RegExp(String.raw`^${BODY}$`);
// A bare token ends where the sentence does: "see path:x/a.md." drops the dot.
const TRAILING_PROSE = /[.,=~-]+$/;

function buildPathRef(project: string, path: string, line: string | undefined): PathRef | null {
	if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
	const number = line === undefined ? undefined : Number.parseInt(line, 10);
	if (number !== undefined && !(number > 0)) return null;
	return number === undefined ? { project, path } : { project, path, line: number };
}

/** Every path token in one piece of plain text, in order. */
export function findPathRefsInText(text: string): PathRefMatch[] {
	const found: PathRefMatch[] = [];
	if (!text || !text.includes("path:")) return found;
	PATH_REF_TEXT_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = PATH_REF_TEXT_REGEX.exec(text)) !== null) {
		let raw = match[0];
		let ref: PathRef | null;
		if (match[1]) {
			ref = buildPathRef(match[1], match[2], match[3]);
		} else {
			let path = match[5];
			const line = match[6];
			if (!line) {
				const trimmed = path.replace(TRAILING_PROSE, "");
				raw = raw.slice(0, raw.length - (path.length - trimmed.length));
				path = trimmed;
			}
			ref = path ? buildPathRef(match[4], path, line) : null;
		}
		if (!ref) continue;
		found.push({ ref, raw, start: match.index, end: match.index + raw.length });
	}
	return found;
}

/** A path token used as a URI (a markdown href, an OSC 8 target), with or without the brackets. */
export function parsePathRefUri(uri: string): PathRef | null {
	const trimmed = uri.trim().replace(/^<(.*)>$/, "$1");
	const match = PATH_REF_URI_REGEX.exec(trimmed);
	return match ? buildPathRef(match[1], match[2], match[3]) : null;
}

/** The bracket-less form: `path:a1c9fe4e/todo/x.md`, `:line` included when set. */
export function pathRefUri(ref: PathRef): string {
	return `path:${ref.project}/${ref.path}${ref.line ? `:${ref.line}` : ""}`;
}

export function formatPathRef(ref: PathRef): string {
	return `<${pathRefUri(ref)}>`;
}

/** Fenced code blocks stay as written: a command in one must still run. */
const FENCE = /^ {0,3}(```|~~~)/;

/**
 * Every relative path in `text` outside fenced code, refs and tokens, offered to
 * `rewrite` as `/`-separated; a non-null answer replaces it, `:line` included.
 */
export function rewriteRelativePaths(text: string, rewrite: (relativePath: string, line: number | undefined) => string | null): string {
	if (!text) return text;
	let fence: string | null = null;
	return text.split("\n").map((line) => {
		const opener = FENCE.exec(line)?.[1];
		if (fence) {
			if (opener === fence) fence = null;
			return line;
		}
		if (opener) {
			fence = opener;
			return line;
		}
		return rewriteLine(line, rewrite);
	}).join("\n");
}

function rewriteLine(line: string, rewrite: (relativePath: string, line: number | undefined) => string | null): string {
	const taken = [...findRefsInText(line), ...findPathRefsInText(line)];
	let out = "";
	let cursor = 0;
	for (const candidate of findPathCandidates(line)) {
		if (taken.some((t) => candidate.start < t.end && candidate.end >= t.start)) continue;
		const relative = projectRelative(candidate.cleanPath);
		const replacement = relative ? rewrite(relative, candidate.line) : null;
		if (replacement === null) continue;
		out += line.slice(cursor, candidate.start) + replacement;
		cursor = candidate.end + 1;
	}
	return cursor === 0 ? line : out + line.slice(cursor);
}

/**
 * Text written on `writerProjectId`, as a reader on another project must see it:
 * each relative path that `exists` on the writer's project becomes its bare
 * `path:` token. Absolute paths, URLs, existing tokens and fenced code are kept.
 */
export function qualifyPathsFor(
	text: string,
	writerProjectId: string | undefined,
	readerProjectId: string | undefined,
	exists: (relativePath: string) => boolean,
): string {
	if (!writerProjectId || writerProjectId === readerProjectId) return text;
	const project = projectRefQualifier(writerProjectId);
	return rewriteRelativePaths(text, (path, line) => (exists(path) ? pathRefUri({ project, path, line }) : null));
}

/** `todo/x.md`, `./todo/x.md` or `todo\x.md` as `todo/x.md`; null for a path a token cannot carry. */
export function projectRelative(path: string): string | null {
	if (isRootedPathText(path)) return null;
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
	if (!normalized || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return null;
	return normalized;
}

/**
 * Text handed to an agent: each path token gains the absolute path it names,
 * `path:a1c9fe4e/x.md (/abs/x.md)`, so the agent can open it without asking dev3.
 */
export function annotatePathRefs(text: string, resolve: (ref: PathRef) => string | null): string {
	let out = "";
	let cursor = 0;
	for (const { ref, end } of findPathRefsInText(text)) {
		const absolute = resolve(ref);
		if (!absolute) continue;
		// A token in a code span keeps the span whole; the path follows it.
		const at = text[end] === "`" ? end + 1 : end;
		const suffix = ` (${absolute}${ref.line ? `:${ref.line}` : ""})`;
		if (text.startsWith(suffix, at)) continue;
		out += text.slice(cursor, at) + suffix;
		cursor = at;
	}
	return cursor === 0 ? text : out + text.slice(cursor);
}
