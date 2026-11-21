// Canonical task / PR reference tokens — the one place their grammar lives.
//
//   <seq:115>            task #115 on the referring text's own project
//   <seq:a1c9fe4e/115>   task #115 on another project (8-char project-id prefix)
//   <pr:115>             PR #115 in the referring project's GitHub repo
//   <pr:a1c9fe4e/115>    PR #115 in another project's repo
//
// Everything dev3 teaches or emits uses these forms. The parser also accepts the
// bare `seq:115` / `pr:115` a markdown renderer leaves behind once it has eaten
// the angle brackets (CommonMark reads `<seq:115>` as an autolink), and the same
// strings as a link href. A bare `seq:115` followed by `--project a1c9fe4e`, the
// CLI's cross-project handle, takes that flag as its qualifier. Older prose forms
// ("#115", "seq 115", "task 115") are deliberately NOT recognised: "#115" collides
// with GitHub numbers.
// See decisions/2026/11/05/canonical-task-pr-reference-tokens.md.

import type { Label, Project, SharedArtifact, SharedImage, Task, TaskPRBadgeInfo, TaskStatus } from "./types";

export type RefKind = "task" | "pr";

export interface TaskPrRef {
	kind: RefKind;
	/** Task seq or PR number. */
	number: number;
	/** Project qualifier as written (id prefix or project name); absent = the context project. */
	project?: string;
}

export interface RefMatch {
	ref: TaskPrRef;
	/** Exact matched text. */
	raw: string;
	/** Start index in the scanned text. */
	start: number;
	/** Exclusive end index in the scanned text. */
	end: number;
}

/** What a reference points at, as the backend resolved it. */
export type TaskPrRefResolution =
	| {
		kind: "task";
		taskId: string;
		projectId: string;
		projectName: string;
		seq: number;
		title: string;
		status: TaskStatus;
	}
	| {
		kind: "pr";
		number: number;
		projectId: string;
		projectName: string;
		/** Null when GitHub could not be asked and no task on the board knows the repo. */
		url: string | null;
		/** The task whose PR this is, when one on the board owns it. */
		taskId?: string;
	};

/** Hover-preview payload for a reference: what the popover shows. */
export type TaskPrRefPreview =
	| {
		kind: "task";
		target: Extract<TaskPrRefResolution, { kind: "task" }>;
		/** The task as the board holds it, so the card reuses the board's own pieces. */
		task: Task;
		/** The task's labels, resolved against its project. */
		labels: Label[];
		/** Set when the task sits in a custom column: its name and colour win. */
		customColumn: { name: string; color: string } | null;
		customStatusLabels?: Project["customStatusLabels"];
		overview: string | null;
		/** Newest last, content clipped to {@link PREVIEW_NOTE_CHARS}. */
		notes: { id: string; content: string; createdAt: string }[];
		/** Newest shared images first, at most {@link PREVIEW_IMAGE_LIMIT}. */
		images: SharedImage[];
		imageCount: number;
		/** Newest shared artifacts first, at most {@link PREVIEW_ARTIFACT_LIMIT}. */
		artifacts: SharedArtifact[];
		artifactCount: number;
	}
	| {
		kind: "pr";
		target: Extract<TaskPrRefResolution, { kind: "pr" }>;
		/** Null when neither the board nor GitHub could describe the PR. */
		badge: TaskPRBadgeInfo | null;
	};

export const PREVIEW_NOTE_LIMIT = 2;
export const PREVIEW_NOTE_CHARS = 280;
export const PREVIEW_IMAGE_LIMIT = 3;
export const PREVIEW_ARTIFACT_LIMIT = 3;

/** Length of the project-id prefix used as the cross-project qualifier. */
export const PROJECT_REF_PREFIX_LENGTH = 8;

const KIND_BY_TAG: Record<string, RefKind> = { seq: "task", pr: "pr" };
const TAG_BY_KIND: Record<RefKind, string> = { task: "seq", pr: "pr" };

const BODY = String.raw`(seq|pr):(?:([A-Za-z0-9][\w.-]{0,63})\/)?(\d{1,9})`;
// Canonical `<seq:…>` first; otherwise a bare `seq:…` not glued to a word, a
// path or a URL on either side (so `https://x/seq:1` and `foo-seq:1` stay text).
const REF_TEXT_REGEX = new RegExp(String.raw`<${BODY}>|(?<![\w/:.<-])${BODY}(?![\w/])`, "gi");
const REF_URI_REGEX = new RegExp(String.raw`^${BODY}$`, "i");
// dev3 spells a cross-project CLI handle `--task seq:N [--variant i] --project P`
// (see `agentReplyCommand`); P qualifies the bare `seq:N` in front of it.
const CLI_PROJECT_FLAG_REGEX = /^(?:\s+--variant\s+\d+)?\s+--project\s+([A-Za-z0-9][\w.-]{0,63})/;

function buildRef(tag: string, project: string | undefined, digits: string): TaskPrRef | null {
	const kind = KIND_BY_TAG[tag.toLowerCase()];
	const number = Number.parseInt(digits, 10);
	if (!kind || !Number.isSafeInteger(number) || number <= 0) return null;
	return project ? { kind, number, project } : { kind, number };
}

/** Every task / PR reference in one piece of plain text, in order. */
export function findRefsInText(text: string): RefMatch[] {
	const found: RefMatch[] = [];
	if (!text || !/(?:seq|pr):/i.test(text)) return found;
	REF_TEXT_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = REF_TEXT_REGEX.exec(text)) !== null) {
		const end = match.index + match[0].length;
		const cliProject = match[1] || match[5] ? undefined : CLI_PROJECT_FLAG_REGEX.exec(text.slice(end))?.[1];
		const ref = match[1] ? buildRef(match[1], match[2], match[3]) : buildRef(match[4], match[5] ?? cliProject, match[6]);
		if (!ref) continue;
		found.push({ ref, raw: match[0], start: match.index, end });
	}
	return found;
}

/**
 * A reference used as a URI — a markdown autolink href or an OSC 8 target:
 * `seq:115`, `pr:a1c9fe4e/115`, with or without the angle brackets.
 */
export function parseRefUri(uri: string): TaskPrRef | null {
	const trimmed = uri.trim().replace(/^<(.*)>$/, "$1");
	const match = REF_URI_REGEX.exec(trimmed);
	return match ? buildRef(match[1], match[2], match[3]) : null;
}

/**
 * A `--task` argument as the CLI expects it: an agent pasting the canonical
 * `<seq:115>` gets the same `seq:115` the flag has always taken. Anything else
 * passes through untouched.
 */
export function normalizeTaskArg(raw: string): string {
	const match = /^<seq:(\d{1,9})>$/i.exec(raw.trim());
	return match ? `seq:${match[1]}` : raw;
}

/** The cross-project qualifier for a project id: its first 8 characters. */
export function projectRefQualifier(projectId: string): string {
	return projectId.slice(0, PROJECT_REF_PREFIX_LENGTH);
}

/** `<seq:115>`, or `<seq:a1c9fe4e/115>` when `projectId` is given. */
export function formatTaskRef(seq: number, projectId?: string): string {
	return formatRef({ kind: "task", number: seq, project: projectId ? projectRefQualifier(projectId) : undefined });
}

/** `<pr:115>`, or `<pr:a1c9fe4e/115>` when `projectId` is given. */
export function formatPrRef(number: number, projectId?: string): string {
	return formatRef({ kind: "pr", number, project: projectId ? projectRefQualifier(projectId) : undefined });
}

/** Qualify with `projectId` only when it differs from the reader's project. */
export function formatTaskRefFor(seq: number, projectId: string, readerProjectId: string | undefined): string {
	return formatTaskRef(seq, readerProjectId && readerProjectId === projectId ? undefined : projectId);
}

// Markdown code: a fenced block, an unterminated fence opened at a line start
// (runs to the end), or an inline span.
const CODE_REGEX = /```[\s\S]*?```|(?:^|\n)```[\s\S]*$|`[^`\n]*`/g;
// What sits right before a bare `seq:N` that is a CLI argument: a flag value
// (`--task seq:4`, `--task "seq:4"`, `--depends-on seq:3, seq:4`) or a positional id
// (`dev3 task show seq:4`, `~/.dev3.0/bin/dev3 task show seq:4`).
const CLI_ARG_BEFORE_REGEX = /(?:--[a-z][\w-]*(?:=|\s+)["']?(?:(?:seq|pr):\d+,\s*)*|(?:^|[\s/])dev3(?:\s+[a-z][\w-]*){1,2}\s+["']?)$/i;
// How far back on its line a ref looks for a flag or a `dev3` command.
const CLI_ARG_LOOKBEHIND = 200;

function codeRanges(text: string): [number, number][] {
	return [...text.matchAll(CODE_REGEX)].map((m) => [m.index, m.index + m[0].length]);
}

/** A bare `seq:N` the reader would run as a command, where a qualifier would break it. */
function isCliHandle(text: string, start: number, code: [number, number][]): boolean {
	if (code.some(([from, to]) => start >= from && start < to)) return true;
	const lineStart = Math.max(text.lastIndexOf("\n", start - 1) + 1, start - CLI_ARG_LOOKBEHIND);
	return CLI_ARG_BEFORE_REGEX.test(text.slice(lineStart, start));
}

/**
 * Text written on `writerProjectId`, as a reader on another project must see it:
 * each unqualified `<seq:N>` / `<pr:N>`, and each bare `seq:N` / `pr:N` in prose,
 * gains the writer's project and keeps its form (`seq:N` becomes `seq:a1c9fe4e/N`). A bare one used as a CLI argument stays as written
 * (inside markdown code, after a `--flag`, or as `dev3 <cmd> <sub>`'s positional id),
 * because a qualifier would break the command.
 */
export function qualifyRefsFor(text: string, writerProjectId: string | undefined, readerProjectId: string | undefined): string {
	if (!writerProjectId || writerProjectId === readerProjectId) return text;
	const project = projectRefQualifier(writerProjectId);
	const refs = findRefsInText(text);
	const code = refs.some((r) => !r.raw.startsWith("<")) ? codeRanges(text) : [];
	let out = "";
	let cursor = 0;
	for (const { ref, raw, start, end } of refs) {
		if (ref.project) continue;
		const bracketed = raw.startsWith("<");
		if (!bracketed && isCliHandle(text, start, code)) continue;
		// Keep the writer's form: a title renders as plain text, where brackets show.
		const qualified = { ...ref, project };
		out += text.slice(cursor, start) + (bracketed ? formatRef(qualified) : refUri(qualified));
		cursor = end;
	}
	return cursor === 0 ? text : out + text.slice(cursor);
}

/**
 * {@link qualifyRefsFor} for an edit of `previous`: a line already in `previous`
 * stays as written, because its refs were the reader's own before the writer
 * read it back. Only the lines the writer added gain its project.
 */
export function qualifyEditedRefsFor(text: string, previous: string | null | undefined, writerProjectId: string | undefined, readerProjectId: string | undefined): string {
	const qualified = qualifyRefsFor(text, writerProjectId, readerProjectId);
	if (qualified === text || !previous) return qualified;
	const kept = new Set(previous.split("\n"));
	const original = text.split("\n");
	return qualified.split("\n").map((line, i) => (kept.has(original[i]!) ? original[i]! : line)).join("\n");
}

export function formatRef(ref: TaskPrRef): string {
	return `<${refUri(ref)}>`;
}

/** The bracket-less form, used as a link href: `seq:115`. */
export function refUri(ref: TaskPrRef): string {
	return `${TAG_BY_KIND[ref.kind]}:${ref.project ? `${ref.project}/` : ""}${ref.number}`;
}

/**
 * Does a project match a written qualifier? An id prefix (≥ 4 chars) or the
 * project's name, case-insensitively — the name is a lenient fallback for
 * hand-written references, never what dev3 emits.
 */
export function projectMatchesQualifier(project: { id: string; name?: string }, qualifier: string): boolean {
	const q = qualifier.toLowerCase();
	if (q.length >= 4 && project.id.toLowerCase().startsWith(q)) return true;
	return !!project.name && project.name.toLowerCase() === q;
}
