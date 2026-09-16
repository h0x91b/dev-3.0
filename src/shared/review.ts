/**
 * The task review: the user's comments on what an agent produced, stored on the
 * task record so every viewer and the agent's CLI read the same list.
 *
 * A comment is text plus a typed anchor. The anchor names the surface the comment
 * was made on — a diff line range or an element of an HTML artifact — and is the
 * only part a viewer has to supply; the composer, the thread bubble, the export
 * card and the prompt sent to the agent are shared.
 *
 * Both sides of the diff use the `@git-diff-view` side names on purpose: the
 * viewer keys its widgets by them and a translation layer would only invite
 * off-by-one mistakes.
 */

export type ReviewDiffSide = "oldFile" | "newFile";

export interface ReviewDiffLineAnchor {
	kind: "diff-line";
	/** The diff file id the viewer keys its widgets by. */
	fileId: string;
	/** Repository-relative path the agent can open. */
	filePath: string;
	side: ReviewDiffSide;
	startLine: number;
	endLine: number;
}

export interface ReviewArtifactElementAnchor {
	kind: "artifact-element";
	/** `SharedArtifact.id` — the group the pin belongs to. */
	artifactId: string;
	/** The version the element was clicked on. */
	version: number;
	title: string;
	/** CSS path of the element inside the artifact document. */
	selector: string;
	/** The element's own text, trimmed and capped, so the agent can find it by eye. */
	text: string;
	/** Nearest heading above the element, when there is one. */
	heading: string | null;
}

export interface ReviewImageRegionAnchor {
	kind: "image-region";
	/** `SharedImage.id`. */
	imageId: string;
	name: string;
	/** Absolute path of the stored copy, so the agent can open it. */
	path: string;
	caption: string | null;
	/** Region in image coordinates normalised to 0..1, so it survives any zoom or viewport. */
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ReviewFileRangeAnchor {
	kind: "file-range";
	/** Absolute path as previewed (Cmd-click in the terminal). */
	path: string;
	/** Null when the selection came from a rendered document with no source-line mapping. */
	startLine: number | null;
	endLine: number | null;
	/** The selected text, trimmed and capped. */
	excerpt: string;
}

export interface ReviewTerminalTextAnchor {
	kind: "terminal-text";
	/** The selected terminal text, trimmed and capped. */
	excerpt: string;
}

export type ReviewAnchor =
	| ReviewDiffLineAnchor
	| ReviewArtifactElementAnchor
	| ReviewImageRegionAnchor
	| ReviewFileRangeAnchor
	| ReviewTerminalTextAnchor;

/** Selections longer than this are cut in the anchor; the agent has the file or the scrollback for the rest. */
export const REVIEW_EXCERPT_LIMIT = 600;

export function clipReviewExcerpt(text: string, limit = REVIEW_EXCERPT_LIMIT): string {
	const clean = text.replace(/\r/g, "").trim();
	return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function formatRegion(anchor: ReviewImageRegionAnchor): string {
	const pct = (value: number) => `${Math.round(value * 100)}%`;
	return `x ${pct(anchor.x)}–${pct(anchor.x + anchor.w)}, y ${pct(anchor.y)}–${pct(anchor.y + anchor.h)}`;
}

export type ReviewReplyAuthor = "user" | "agent";

export interface ReviewReply {
	id: string;
	body: string;
	author: ReviewReplyAuthor;
	createdAt: string;
}

export interface ReviewComment {
	id: string;
	body: string;
	createdAt: string;
	anchor: ReviewAnchor;
	/** Set once the comment was handed to the agent; keeps it out of the next batch. */
	sentAt?: string;
	/** Set by whoever closed the thread — the agent through the CLI or the user. */
	resolvedAt?: string;
	resolvedBy?: ReviewReplyAuthor;
	replies?: ReviewReply[];
}

/** Text over this length is cut in the anchor so a pin never carries a whole table. */
export const REVIEW_ANCHOR_TEXT_LIMIT = 200;

/**
 * Cap on comments kept per task. Resolved comments go first when the cap is hit,
 * oldest first, so an open comment is never evicted by a closed one.
 */
export const MAX_REVIEW_COMMENTS_KEPT = 200;

export function appendReviewComment(existing: ReviewComment[] | undefined, comment: ReviewComment): ReviewComment[] {
	const next = [...(existing ?? []), comment];
	if (next.length <= MAX_REVIEW_COMMENTS_KEPT) return next;
	const overflow = next.length - MAX_REVIEW_COMMENTS_KEPT;
	const dropIds = new Set<string>();
	for (const candidate of next) {
		if (dropIds.size >= overflow) break;
		if (candidate.resolvedAt) dropIds.add(candidate.id);
	}
	for (const candidate of next) {
		if (dropIds.size >= overflow) break;
		dropIds.add(candidate.id);
	}
	return next.filter((candidate) => !dropIds.has(candidate.id));
}

export function isReviewCommentOpen(comment: Pick<ReviewComment, "resolvedAt">): boolean {
	return !comment.resolvedAt;
}

export function countOpenReviewComments(comments: ReviewComment[] | undefined): number {
	return (comments ?? []).filter(isReviewCommentOpen).length;
}

export function reviewCommentsForArtifact(comments: ReviewComment[] | undefined, artifactId: string): ReviewComment[] {
	return (comments ?? []).filter(
		(comment) => comment.anchor.kind === "artifact-element" && comment.anchor.artifactId === artifactId,
	);
}

/** One line of the prompt: what the comment points at, without the comment itself. */
export function describeReviewAnchor(anchor: ReviewAnchor): string {
	if (anchor.kind === "diff-line") {
		const range = anchor.startLine === anchor.endLine ? `${anchor.startLine}` : `${anchor.startLine}-${anchor.endLine}`;
		return `${anchor.filePath}:${range}`;
	}
	if (anchor.kind === "artifact-element") {
		const where = anchor.heading ? `${anchor.heading} › ` : "";
		return `${anchor.title} v${anchor.version} › ${where}${anchor.text || anchor.selector}`;
	}
	if (anchor.kind === "image-region") return `${anchor.name} (${formatRegion(anchor)})`;
	if (anchor.kind === "file-range") {
		const range = anchor.startLine === null ? "" : anchor.endLine === null || anchor.endLine === anchor.startLine ? `:${anchor.startLine}` : `:${anchor.startLine}-${anchor.endLine}`;
		return `${anchor.path}${range}`;
	}
	return `terminal › ${anchor.excerpt.split("\n")[0]}`;
}

/**
 * One entry of the prompt handed to the agent. Local comments and GitHub PR
 * threads share the shape; a GitHub entry has no id the agent could resolve.
 */
export interface ReviewPromptEntry {
	/** The review comment id, so the agent can `dev3 review resolve` it; null for GitHub threads. */
	id: string | null;
	anchor: ReviewAnchor;
	comment: string;
	/** The removed/added lines under a diff anchor; artifact anchors carry none. */
	snippet?: { before: string | null; after: string | null };
	origin: "local" | "github";
	author: string | null;
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function reviewOpenTag(entry: ReviewPromptEntry): string {
	const attrs: string[] = [];
	if (entry.id) attrs.push(`id="${escapeAttribute(entry.id)}"`);
	if (entry.origin === "github") {
		attrs.push("origin=\"github\"");
		if (entry.author) attrs.push(`author="${escapeAttribute(entry.author)}"`);
	}
	return attrs.length ? `<review ${attrs.join(" ")}>` : "<review>";
}

function anchorLines(entry: ReviewPromptEntry): string[] {
	const { anchor } = entry;
	if (anchor.kind === "diff-line") {
		const lineAttr = anchor.startLine === anchor.endLine
			? String(anchor.startLine)
			: `"${anchor.startLine}-${anchor.endLine}"`;
		const lines = [`<file src="${anchor.filePath}" line=${lineAttr}>`];
		if (entry.snippet?.before) lines.push(`-${entry.snippet.before}`);
		if (entry.snippet?.after) lines.push(`+${entry.snippet.after}`);
		lines.push("</file>");
		return lines;
	}
	if (anchor.kind === "artifact-element") {
		const attrs = [
			`title="${escapeAttribute(anchor.title)}"`,
			`version="${anchor.version}"`,
			`selector="${escapeAttribute(anchor.selector)}"`,
		];
		if (anchor.heading) attrs.push(`heading="${escapeAttribute(anchor.heading)}"`);
		return [`<artifact ${attrs.join(" ")}>`, anchor.text, "</artifact>"];
	}
	if (anchor.kind === "image-region") {
		const attrs = [
			`src="${escapeAttribute(anchor.path)}"`,
			`region="${formatRegion(anchor)}"`,
		];
		if (anchor.caption) attrs.push(`caption="${escapeAttribute(anchor.caption)}"`);
		return [`<image ${attrs.join(" ")}/>`];
	}
	if (anchor.kind === "file-range") {
		const line = anchor.startLine === null
			? ""
			: anchor.endLine === null || anchor.endLine === anchor.startLine ? ` line=${anchor.startLine}` : ` line="${anchor.startLine}-${anchor.endLine}"`;
		return [`<file src="${escapeAttribute(anchor.path)}"${line}>`, anchor.excerpt, "</file>"];
	}
	return ["<terminal>", anchor.excerpt, "</terminal>"];
}

/**
 * The prompt the agent receives. Every entry names what it points at and what
 * was said; the footer tells the agent how to close the loop through the CLI.
 */
export function buildReviewPrompt(entries: ReviewPromptEntry[]): string {
	const lines = ["<reviews>"];
	let hasGithub = false;
	let hasArtifact = false;
	let hasOther = false;
	let hasIds = false;
	for (const entry of entries) {
		if (entry.origin === "github") hasGithub = true;
		if (entry.anchor.kind === "artifact-element") hasArtifact = true;
		if (entry.anchor.kind !== "diff-line") hasOther = true;
		if (entry.id) hasIds = true;
		lines.push(reviewOpenTag(entry));
		lines.push(...anchorLines(entry));
		lines.push(`<comment>${entry.comment}</comment>`);
		lines.push("</review>");
	}
	lines.push("</reviews>");
	lines.push("---");
	const subject = hasOther ? "my review comments" : "my comments about code changes";
	lines.push(hasGithub
		? `Above are code review comments. Reviews marked origin="github" come from GitHub PR reviewers; the rest are my own. Read them carefully and process all of them.`
		: `Above ${subject}, read them carefully and process all of them.`);
	if (hasArtifact) {
		lines.push("An <artifact> entry points at an element of an HTML artifact you published with `dev3 show-artifact`: fix the report and republish it under the same title.");
	}
	if (entries.some((entry) => entry.anchor.kind === "image-region")) {
		lines.push("An <image> entry points at a region (percent of width/height) of an image you shared with `dev3 show-image`; open the file to look at it.");
	}
	if (entries.some((entry) => entry.anchor.kind === "terminal-text")) {
		lines.push("A <terminal> entry quotes text from your own terminal output.");
	}
	if (hasIds) {
		lines.push("When a comment is handled run `dev3 review resolve <id> --reply \"what you did\"`; to answer without closing it run `dev3 review reply <id> \"...\"`. `dev3 review list` shows what is still open.");
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Mutations. Pure, so the RPC handlers, the CLI socket routes and the renderer's
// optimistic state all apply exactly the same rule.

function findReviewComment(comments: ReviewComment[] | undefined, id: string): ReviewComment | undefined {
	return (comments ?? []).find((comment) => comment.id === id);
}

/** Exact id first, then a unique prefix — the CLI prints 8-character prefixes. */
export function resolveReviewCommentId(comments: ReviewComment[] | undefined, ref: string): { id: string } | { error: string } {
	const list = comments ?? [];
	if (list.some((comment) => comment.id === ref)) return { id: ref };
	const matches = list.filter((comment) => comment.id.startsWith(ref));
	if (matches.length === 1) return { id: matches[0].id };
	if (matches.length === 0) return { error: `Review comment not found: ${ref}` };
	return { error: `Ambiguous review comment id: ${ref} matches ${matches.length} comments` };
}

export function updateReviewCommentBody(comments: ReviewComment[] | undefined, id: string, body: string): ReviewComment[] {
	// Editing revives the comment: the agent got the old text, so the new text
	// has to be deliverable again.
	return (comments ?? []).map((comment) => (
		comment.id === id ? { ...comment, body, sentAt: undefined } : comment
	));
}

export function deleteReviewComment(comments: ReviewComment[] | undefined, id: string): ReviewComment[] {
	return (comments ?? []).filter((comment) => comment.id !== id);
}

export function markReviewCommentsSent(comments: ReviewComment[] | undefined, ids: Iterable<string>, at = new Date().toISOString()): ReviewComment[] {
	const set = new Set(ids);
	return (comments ?? []).map((comment) => (set.has(comment.id) ? { ...comment, sentAt: at } : comment));
}

export function replyToReviewComment(
	comments: ReviewComment[] | undefined,
	id: string,
	reply: { body: string; author: ReviewReplyAuthor },
	now = new Date().toISOString(),
): ReviewComment[] {
	if (!findReviewComment(comments, id)) throw new Error(`Review comment not found: ${id}`);
	const entry: ReviewReply = { id: crypto.randomUUID(), body: reply.body, author: reply.author, createdAt: now };
	return (comments ?? []).map((comment) => (
		comment.id === id ? { ...comment, replies: [...(comment.replies ?? []), entry] } : comment
	));
}

export function resolveReviewComment(
	comments: ReviewComment[] | undefined,
	id: string,
	by: ReviewReplyAuthor,
	reply?: string,
	now = new Date().toISOString(),
): ReviewComment[] {
	const withReply = reply ? replyToReviewComment(comments, id, { body: reply, author: by }, now) : comments ?? [];
	if (!findReviewComment(withReply, id)) throw new Error(`Review comment not found: ${id}`);
	return withReply.map((comment) => (
		comment.id === id ? { ...comment, resolvedAt: now, resolvedBy: by } : comment
	));
}

export function reopenReviewComment(comments: ReviewComment[] | undefined, id: string): ReviewComment[] {
	if (!findReviewComment(comments, id)) throw new Error(`Review comment not found: ${id}`);
	return (comments ?? []).map((comment) => {
		if (comment.id !== id) return comment;
		const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...rest } = comment;
		return rest;
	});
}
