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
// strings as a link href. Older prose forms ("#115", "seq 115", "task 115") are
// deliberately NOT recognised: "#115" collides with GitHub numbers.
// See decisions/2026/11/05/canonical-task-pr-reference-tokens.md.

import type { SharedArtifact, SharedImage, TaskPRBadgeInfo, TaskPriority, TaskStatus } from "./types";

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
		priority?: TaskPriority;
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
		const ref = match[1] ? buildRef(match[1], match[2], match[3]) : buildRef(match[4], match[5], match[6]);
		if (!ref) continue;
		found.push({ ref, raw: match[0], start: match.index, end: match.index + match[0].length });
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
