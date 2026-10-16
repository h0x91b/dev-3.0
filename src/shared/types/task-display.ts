import type { Task } from "./task";

/** Returns the display title: custom override if set, otherwise auto-generated. */
export function getTaskTitle(task: Task): string {
	return task.customTitle || task.title;
}

/**
 * Human-readable task identifier: the per-project sequential number, plus the
 * variant suffix when the task is one of several attempts in a group
 * (e.g. `"981"` or `"981-1"`). No leading `#` — callers add it for display
 * (GlobalHeader) while analytics uses the bare form in page paths. Single source
 * of truth for the seq/variant format shown across the app.
 */
export function taskSeqLabel(task: Pick<Task, "seq" | "variantIndex">): string {
	return task.variantIndex != null ? `${task.seq}-${task.variantIndex}` : `${task.seq}`;
}

/**
 * Returns the effective displayed overview: the user override if set, otherwise
 * the agent-written overview. Mirrors the precedence used in the task cards and
 * CLI. Returns null when neither is present.
 */
export function getTaskOverview(task: Task): string | null {
	return task.userOverview?.trim() || task.overview?.trim() || null;
}

/** What changed in a {@link TaskHistoryEntry}. */
export type TaskHistoryChange = "created" | "title" | "overview" | "both";

/**
 * One immutable snapshot of a task's displayed title + overview, captured at the
 * moment either of them changed. Append-only; see {@link Task.history}.
 */
export interface TaskHistoryEntry {
	/** ISO timestamp of the change. */
	at: string;
	/** Effective title at this point (custom override or auto-generated). */
	title: string;
	/** Effective overview at this point (user override or agent overview), or null. */
	overview: string | null;
	/** Which displayed value(s) changed and triggered this snapshot. */
	changed: TaskHistoryChange;
}

/** Humanize a status slug for display in notifications (e.g. "in-progress" → "In Progress"). */
export function formatStatus(status: string): string {
	return status
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

/** Generate a short title from a description (first ~maxLen chars, word-boundary truncated). */
export function titleFromDescription(
	description: string,
	maxLen = 80,
): string {
	const text = description.replace(/\n/g, " ").trim();
	if (text.length <= maxLen) return text;
	const truncated = text.slice(0, maxLen);
	const lastSpace = truncated.lastIndexOf(" ");
	if (lastSpace > maxLen * 0.4) {
		return truncated.slice(0, lastSpace) + "\u2026";
	}
	return truncated + "\u2026";
}

/** Words of the "about" clause in a review title \u2014 five, as the board asks for. */
const REVIEW_TITLE_TOPIC_WORDS = 5;

/**
 * The "about \u2026" clause of a review title, condensed from a pull-request title or
 * a commit subject. Drops the conventional-commit prefix and GitHub's squash
 * `(#123)` suffix, both of which would spend words on things the card already
 * shows, then keeps the first {@link REVIEW_TITLE_TOPIC_WORDS} words. No
 * ellipsis on purpose: a trailing `\u2026` is this project's marker for a title
 * nobody has written yet (see `titleFromDescription`).
 */
export function reviewTitleTopic(source: string | null | undefined): string {
	const text = (source ?? "")
		.replace(/\s+/g, " ")
		.replace(/\s*\(#\d+\)\s*$/, "")
		.replace(/^\s*\w+(\([^)]*\))?!?:\s*/, "")
		.trim();
	if (!text) return "";
	// Cutting at five words lands mid-sentence, so the join often ends on the comma
	// or dash that led into the words we dropped.
	return text.split(" ").slice(0, REVIEW_TITLE_TOPIC_WORDS).join(" ").replace(/[,;:—–-]+$/, "");
}

/**
 * Board identity for a PR-review task. Every review card used to read "Review the
 * code changes on this branch. Your task is to perform a thorough\u2026" \u2014 the preset
 * preamble run through {@link titleFromDescription} \u2014 so N reviews produced N
 * indistinguishable cards. Each clause is dropped rather than filled with a
 * placeholder when its part is unknown, so a branch with no pull request and no
 * readable author still gets a shorter honest title instead of "from unknown".
 * Returns "" when even the subject is unknown, which means "keep the old title".
 */
export function reviewTaskTitle(parts: {
	prNumber?: number | null;
	branch?: string | null;
	author?: string | null;
	topic?: string | null;
}): string {
	const branch = parts.branch?.trim();
	const subject = parts.prNumber != null ? `#${parts.prNumber}` : branch;
	if (!subject) return "";
	const author = parts.author?.trim();
	const topic = reviewTitleTopic(parts.topic);
	return `Review of ${subject}${author ? ` from ${author}` : ""}${topic ? ` about ${topic}` : ""}`;
}
