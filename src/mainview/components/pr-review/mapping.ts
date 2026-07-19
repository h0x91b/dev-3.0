import type { PRReviewThread, TaskDiffFile } from "../../../shared/types";
import { extractReviewSnippet, type DiffSideKey } from "../diff-hunks";

export function threadSideKey(thread: PRReviewThread): DiffSideKey {
	return thread.diffSide === "LEFT" ? "oldFile" : "newFile";
}

/** GitHub threads anchored per side/line of one diff file — mirrors the local-comment layout. */
export interface GithubThreadsFileData {
	oldFile: Record<number, PRReviewThread[]>;
	newFile: Record<number, PRReviewThread[]>;
}

/** Visible threads grouped against the current diff's file list. */
export interface GithubThreadFileGroups {
	/** Threads on files present in the diff, keyed by diff file id. */
	byFile: Record<string, PRReviewThread[]>;
	/** Threads on files that are absent from the current diff, grouped by path. */
	unmapped: Array<{ path: string; threads: PRReviewThread[] }>;
	unmappedCount: number;
}

/**
 * First mapping stage (viewer level): match threads to diff files by path and
 * apply the resolved-visibility filter. Whether a thread's line is actually
 * rendered is only known once the diff library builds the file — that second
 * stage is {@link partitionThreadsForDiff}, fed per file section.
 */
export function groupGithubThreadsByFile(
	files: TaskDiffFile[],
	threads: PRReviewThread[],
	options: { showResolved: boolean },
): GithubThreadFileGroups {
	const filesByPath = new Map<string, TaskDiffFile>();
	for (const file of files) {
		for (const path of [file.newPath, file.oldPath, file.displayPath]) {
			if (path && !filesByPath.has(path)) {
				filesByPath.set(path, file);
			}
		}
	}

	const groups: GithubThreadFileGroups = { byFile: {}, unmapped: [], unmappedCount: 0 };
	const unmappedByPath = new Map<string, PRReviewThread[]>();

	for (const thread of threads) {
		if (thread.isResolved && !options.showResolved) {
			continue;
		}
		const file = filesByPath.get(thread.path);
		if (!file) {
			const group = unmappedByPath.get(thread.path) ?? [];
			group.push(thread);
			unmappedByPath.set(thread.path, group);
			groups.unmappedCount += 1;
			continue;
		}
		(groups.byFile[file.id] ??= []).push(thread);
	}

	groups.unmapped = [...unmappedByPath.entries()]
		.map(([path, group]) => ({ path, threads: group }))
		.sort((left, right) => left.path.localeCompare(right.path));
	return groups;
}

/** The subset of the diff library's DiffFile instance the partition relies on. */
interface DiffInstanceLineLookup {
	getUnifiedLineIndexByLineNumber?: (lineNumber: number, side: number) => number | undefined;
	getUnifiedLine?: (index: number) => { isHidden?: boolean } | undefined;
	getSplitLineIndexByLineNumber?: (lineNumber: number, side: number) => number | undefined;
	getSplitLeftLine?: (index: number) => { isHidden?: boolean; lineNumber?: number } | undefined;
	getSplitRightLine?: (index: number) => { isHidden?: boolean; lineNumber?: number } | undefined;
}

/**
 * Ask the built diff instance whether it actually renders `line` on `side` in
 * the given view mode. The backend ships `hunks: null` (the library computes
 * the diff itself from full file contents), so the instance — not a hunk
 * parse — is the only honest source of "is this line on screen".
 */
export function isLineRenderedInDiff(
	instance: unknown,
	viewMode: "split" | "unified",
	splitSide: { old: number; new: number },
	side: DiffSideKey,
	line: number,
): boolean {
	const lookup = instance as DiffInstanceLineLookup;
	const sideNum = side === "oldFile" ? splitSide.old : splitSide.new;
	try {
		if (viewMode === "split") {
			const index = lookup.getSplitLineIndexByLineNumber?.(line, sideNum);
			if (typeof index !== "number" || index < 0) return false;
			const item = side === "oldFile" ? lookup.getSplitLeftLine?.(index) : lookup.getSplitRightLine?.(index);
			return !!item && !item.isHidden;
		}
		const index = lookup.getUnifiedLineIndexByLineNumber?.(line, sideNum);
		if (typeof index !== "number" || index < 0) return false;
		const item = lookup.getUnifiedLine?.(index);
		return !!item && !item.isHidden;
	} catch {
		return false;
	}
}

/**
 * Second mapping stage (file-section level): split one file's threads into
 * inline anchors (their line is rendered by the built diff) and the outdated
 * group (GitHub-flagged outdated, no line, or the line is not on screen —
 * e.g. the worktree moved past the PR head). Never silently drops a thread.
 */
export function partitionThreadsForDiff(
	threads: PRReviewThread[],
	isRendered: (side: DiffSideKey, line: number) => boolean,
): { inline: GithubThreadsFileData; outdated: PRReviewThread[] } {
	const inline: GithubThreadsFileData = { oldFile: {}, newFile: {} };
	const outdated: PRReviewThread[] = [];

	for (const thread of threads) {
		const side = threadSideKey(thread);
		const line = thread.line;
		if (line === null || thread.isOutdated || !isRendered(side, line)) {
			outdated.push(thread);
			continue;
		}
		(inline[side][line] ??= []).push(thread);
	}

	return { inline, outdated };
}

/** Location of a thread resolved against the current diff, for prompts/snippets. */
export interface ThreadDiffLocation {
	file: TaskDiffFile;
	side: DiffSideKey;
	line: number;
}

/** Resolve a thread's diff location if its file is present; line falls back to originalLine. */
export function locateThread(files: TaskDiffFile[], thread: PRReviewThread): ThreadDiffLocation | null {
	const file = files.find((candidate) =>
		candidate.newPath === thread.path || candidate.oldPath === thread.path || candidate.displayPath === thread.path,
	);
	if (!file) return null;
	const line = thread.line ?? thread.originalLine;
	if (line === null) return null;
	return { file, side: threadSideKey(thread), line };
}

/**
 * Terminal-ready fix prompt for one review thread: file/line, the code the
 * thread points at (when it still resolves), every comment body, and the
 * GitHub link. Agent-facing content stays English by project convention.
 */
export function buildThreadFixPrompt(thread: PRReviewThread, location: ThreadDiffLocation | null): string {
	const lines: string[] = ["Address this GitHub PR review thread:"];
	const line = thread.line ?? thread.originalLine;
	lines.push(`File: ${thread.path}${line !== null ? `, line ${line}` : ""}${thread.diffSide === "LEFT" ? " (old side)" : ""}`);
	if (thread.isOutdated) {
		lines.push("Note: GitHub marks this thread as outdated — the code may have moved since the comment.");
	}
	if (location) {
		const snippet = extractReviewSnippet(location.file, location.side, location.line, location.line);
		if (snippet.before !== null || snippet.after !== null) {
			lines.push("Code:");
			if (snippet.before !== null) lines.push(`-${snippet.before}`);
			if (snippet.after !== null) lines.push(`+${snippet.after}`);
		}
	}
	lines.push("");
	for (const comment of thread.comments) {
		lines.push(`[${comment.author ?? "unknown"}] wrote:`);
		lines.push(comment.body.trim());
		lines.push("");
	}
	const threadUrl = thread.comments[0]?.url;
	if (threadUrl) {
		lines.push(`Thread: ${threadUrl}`);
	}
	lines.push("Read the review comments above carefully and fix the code accordingly.");
	return lines.join("\n");
}
