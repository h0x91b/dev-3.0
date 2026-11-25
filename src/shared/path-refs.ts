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
const TRAILING_PROSE = /[.,=~/-]+$/;

function buildPathRef(project: string, path: string, line: string | undefined): PathRef | null {
	if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return null;
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

/** Fenced code stays as written: a command in one must still run. Indented fences count too. */
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;

/** Each line of `text` with whether it sits inside (or is) a fence line. */
export function linesOutsideFences(text: string): Array<{ line: string; code: boolean }> {
	let fence: string | null = null;
	return text.split("\n").map((line) => {
		const opener = FENCE_OPEN.exec(line)?.[1];
		if (fence) {
			if (opener && opener[0] === fence[0] && opener.length >= fence.length && line.trim() === opener) fence = null;
			return { line, code: true };
		}
		if (opener) {
			fence = opener;
			return { line, code: true };
		}
		return { line, code: false };
	});
}

/** Inline code spans in one line, as [start, end) ranges. */
export function codeSpans(line: string): Array<{ start: number; end: number; inner: string }> {
	const spans: Array<{ start: number; end: number; inner: string }> = [];
	const re = /(`+)([\s\S]*?[^`])\1(?!`)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(line)) !== null) spans.push({ start: match.index, end: match.index + match[0].length, inner: match[2] });
	return spans;
}

/**
 * Every relative path in `text` outside fenced code, refs and tokens, offered to
 * `rewrite` as `/`-separated; a non-null answer replaces it, `:line` included.
 * In inline code only a span that is one whole path is offered, so commands keep running.
 */
export function rewriteRelativePaths(text: string, rewrite: (relativePath: string, line: number | undefined) => string | null): string {
	if (!text) return text;
	return linesOutsideFences(text).map(({ line, code }) => (code ? line : rewriteLine(line, rewrite))).join("\n");
}

function rewriteLine(line: string, rewrite: (relativePath: string, line: number | undefined) => string | null): string {
	const taken = [...findRefsInText(line), ...findPathRefsInText(line)];
	const spans = codeSpans(line);
	let out = "";
	let cursor = 0;
	for (const candidate of findPathCandidates(line)) {
		if (taken.some((t) => candidate.start < t.end && candidate.end >= t.start)) continue;
		const span = spans.find((sp) => candidate.start >= sp.start && candidate.end < sp.end);
		if (span && span.inner.trim() !== candidate.raw) continue;
		const relative = projectRelative(candidate.cleanPath);
		const replacement = relative ? rewrite(relative, candidate.line) : null;
		if (replacement === null) continue;
		// Only `path[:line]` is replaced; a `:col` tail stays as written.
		const lineSuffix = candidate.line === undefined ? "" : `:${candidate.line}`;
		const replacedEnd = candidate.start + candidate.cleanPath.length + lineSuffix.length;
		out += line.slice(cursor, candidate.start) + replacement;
		cursor = replacedEnd;
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

/** An annotation `annotatePathRefs` wrote: ` (<absolute path>[:line])` right after a token or its code span. */
const ANNOTATION = /^`? \(((?:\/|[A-Za-z]:[\\/]|\\\\)[^()\n]*)\)/;

/** Text without the absolute paths `annotatePathRefs` added, so a written-back copy stores only tokens. */
export function stripPathAnnotations(text: string): string {
	if (!text.includes("path:")) return text;
	let out = "";
	let cursor = 0;
	for (const { end } of findPathRefsInText(text)) {
		const match = ANNOTATION.exec(text.slice(end));
		if (!match) continue;
		const keep = match[0].startsWith("`") ? 1 : 0;
		out += text.slice(cursor, end + keep);
		cursor = end + match[0].length;
	}
	return cursor === 0 ? text : out + text.slice(cursor);
}

/** Characters of absolute paths added to one text at most. */
export const ANNOTATION_MAX_ADDED_CHARS = 2048;
/** The launch prompt's smaller share: it rides the Windows command line (`agent-command-line-budget.ts`). */
export const LAUNCH_ANNOTATION_MAX_ADDED_CHARS = 512;

/**
 * Text handed to an agent: each path token outside fenced code gains the absolute
 * path it names, `path:a1c9fe4e/x.md (/abs/x.md)`, replacing any older annotation.
 */
export function annotatePathRefs(text: string, resolve: (ref: PathRef) => string | null, maxAdded = ANNOTATION_MAX_ADDED_CHARS): string {
	const lines = linesOutsideFences(stripPathAnnotations(text));
	let budget = maxAdded;
	return lines.map(({ line, code }) => {
		if (code) return line;
		let out = "";
		let cursor = 0;
		for (const { ref, end } of findPathRefsInText(line)) {
			const absolute = resolve(ref);
			if (!absolute) continue;
			const suffix = ` (${absolute}${ref.line ? `:${ref.line}` : ""})`;
			if (suffix.length > budget) break;
			budget -= suffix.length;
			// A token in a code span keeps the span whole; the path follows it.
			const at = line[end] === "`" ? end + 1 : end;
			out += line.slice(cursor, at) + suffix;
			cursor = at;
		}
		return cursor === 0 ? line : out + line.slice(cursor);
	}).join("\n");
}
