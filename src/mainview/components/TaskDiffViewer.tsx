import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent as ReactMouseEvent, type MutableRefObject, type ReactElement, type ReactNode } from "react";
import type { NavigationGuard } from "../navigation-guard";
import type {
	PRReviewThread,
	Project,
	Task,
	TaskDiffFile,
	TaskDiffFileStatus,
	TaskDiffMode,
	TaskDiffResponse,
	TaskDiffSkippedFile,
	TaskPRCommentsPayload,
} from "../../shared/types";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { toast } from "../toast";
import { useT } from "../i18n";
import HelpSpot from "./HelpSpot";
import { useResolvedTheme } from "../hooks/useResolvedTheme";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { formatBytes } from "../utils/formatBytes";
import BottomSheet from "./BottomSheet";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import { resolveAutoDiffViewMode, resolveDiffViewMode } from "./global-settings/utils";
import type { TaskInlineDiffRequest } from "./task-inline-diff";
import { extractReviewSnippet, getReviewFilePath, parseDiffHunkLines, type DiffSideKey } from "./diff-hunks";
import { PrConversationBlock } from "./pr-review/PrConversationBlock";
import { GithubThreadView, OutdatedThreadsGroup, type ThreadSendState } from "./pr-review/GithubThreadView";
import { buildThreadFixPrompt, groupGithubThreadsByFile, isLineRenderedInDiff, locateThread, partitionThreadsForDiff } from "./pr-review/mapping";
import { isTestFile } from "../../shared/test-files";
import { useIncludeTestsInDiff } from "../utils/includeTestsInDiff";
import "@git-diff-view/react/styles/diff-view-pure.css";
import "./TaskDiffViewer.css";

const LS_DIFF_READ_STATE = "dev3-inline-diff-read-state-v1";
const LS_DIFF_MODE_PREFERENCE = "dev3-inline-diff-mode-v1";
const LS_DIFF_FILES_COLLAPSED = "dev3-inline-diff-files-collapsed-v1";
const LS_DIFF_REVIEW = "dev3-inline-diff-review-v1";
const DEFAULT_DIFF_MODE: TaskDiffMode = "uncommitted";
// `recent` mode: how many trailing commits (`HEAD~N..HEAD`) to diff. The presets
// the ▾ popover offers, and the default N used on every open. N itself is never
// persisted — only the mode selection is (see readPreferredDiffMode).
const RECENT_COUNT_PRESETS = [1, 2, 3, 5, 10] as const;
const DEFAULT_RECENT_COUNT = 1;
const EAGER_FILE_COUNT = 2;
// @git-diff-view skips syntax highlighting for files longer than this many lines
// (library default is 2000, which left large source files — e.g. this one — plain).
// Raise it so realistic source files still get highlighted; the per-line node guard
// inside the library still protects against pathologically long single lines.
const SYNTAX_HIGHLIGHT_MAX_LINES = 50000;

function readFilesCollapsed(): boolean {
	try {
		return localStorage.getItem(LS_DIFF_FILES_COLLAPSED) === "1";
	} catch {
		return false;
	}
}

function writeFilesCollapsed(collapsed: boolean): void {
	try {
		localStorage.setItem(LS_DIFF_FILES_COLLAPSED, collapsed ? "1" : "0");
	} catch {
		/* ignore quota / privacy-mode errors */
	}
}

function readPreferredDiffMode(): TaskDiffMode {
	try {
		const stored = localStorage.getItem(LS_DIFF_MODE_PREFERENCE);
		if (stored === "branch" || stored === "uncommitted" || stored === "unpushed" || stored === "recent") {
			return stored;
		}
	} catch {
		/* localStorage unavailable — fall through to default */
	}
	return DEFAULT_DIFF_MODE;
}

function writePreferredDiffMode(mode: TaskDiffMode): void {
	try {
		localStorage.setItem(LS_DIFF_MODE_PREFERENCE, mode);
	} catch {
		/* ignore quota / privacy-mode errors */
	}
}

function applyPreferredDiffMode(request: TaskInlineDiffRequest): TaskInlineDiffRequest {
	// When the caller pinpoints a specific file (e.g. clicked from the branch-diff list),
	// honor their intent — the file may not exist in another mode. Otherwise, use the
	// user's last selection (or uncommitted as the new default).
	if (request.focusFile) {
		return request;
	}
	const preferred = readPreferredDiffMode();
	if (preferred === request.mode) {
		return request;
	}
	return { ...request, mode: preferred };
}

type DiffViewMode = "unified" | "split";

type DiffInstance = {
	initTheme: (theme?: "light" | "dark") => void;
	initRaw: () => void;
	initSyntax: () => void;
	buildSplitDiffLines: () => void;
	buildUnifiedDiffLines: () => void;
};

type DiffLibrary = {
	DiffView: ComponentType<any>;
	DiffFile: new (
		oldFileName: string,
		oldFileContent: string,
		newFileName: string,
		newFileContent: string,
		diffList: string[],
		oldFileLang?: string,
		newFileLang?: string,
		uuid?: string,
	) => DiffInstance;
	DiffModeEnum: {
		Split: number;
		Unified: number;
	};
	SplitSide: {
		old: number;
		new: number;
	};
	generateDiffFile: (...args: any[]) => DiffInstance;
};

type InlineCommentSideKey = DiffSideKey;

interface InlineDiffComment {
	id: string;
	body: string;
	createdAt: string;
	startLine: number;
	endLine: number;
	side: InlineCommentSideKey;
}

interface InlineDiffCommentThread {
	comments: InlineDiffComment[];
}

interface InlineDiffCommentFileData {
	oldFile: Record<string, { data: InlineDiffCommentThread }>;
	newFile: Record<string, { data: InlineDiffCommentThread }>;
}

type InlineDiffCommentsState = Record<string, InlineDiffCommentFileData>;

interface InlineReviewExportEntry {
	id: string;
	fileId: string;
	filePath: string;
	side: InlineCommentSideKey;
	startLine: number;
	endLine: number;
	comment: string;
	snippet: {
		before: string | null;
		after: string | null;
	};
	fileOrder: number;
	createdAt: string;
	/** Who authored the review: the user's own inline comment or a GitHub PR reviewer. */
	origin: "local" | "github";
	/** GitHub login of the thread's first commenter; null for local entries. */
	author: string | null;
}

interface DiffSearchLineCandidate {
	side: InlineCommentSideKey;
	lineNumber: number | null;
	text: string;
}

interface DiffSearchMatch {
	id: string;
	fileId: string;
	filePath: string;
	kind: "path" | "content";
	text: string;
	lineNumber: number | null;
	side: InlineCommentSideKey | null;
}

interface TaskDiffViewerProps {
	task: Task;
	project: Project;
	request: TaskInlineDiffRequest;
	onBack: () => void;
	navigationGuardRef?: MutableRefObject<NavigationGuard | null>;
}

interface TaskDiffFileSectionProps {
	file: TaskDiffFile;
	worktreePath: string | null | undefined;
	diffLib: DiffLibrary;
	resolvedTheme: "dark" | "light";
	viewMode: DiffViewMode;
	/** Phone-width layout: file paths render as one truncating line. */
	narrow: boolean;
	searchQuery: string;
	isCurrentPathMatch: boolean;
	comments: InlineDiffCommentFileData;
	eager: boolean;
	expanded: boolean;
	isRead: boolean;
	onAddComment: (params: {
		fileId: string;
		side: InlineCommentSideKey;
		startLine: number;
		endLine: number;
		body: string;
	}) => void;
	editingCommentId: string | null;
	editingCommentDraft: string;
	onEditDraftChange: (value: string) => void;
	onStartEditComment: (commentId: string, body: string) => void;
	onCancelEditComment: () => void;
	onSaveEditComment: (commentId: string, body: string) => void;
	onDeleteComment: (commentId: string) => void;
	onToggleExpanded: () => void;
	onToggleRead: () => void;
	registerCommentRef: (commentId: string, element: HTMLDivElement | null) => void;
	sectionRef: (element: HTMLDivElement | null) => void;
	/** GitHub review threads on this file (branch mode); the section partitions
	 * them into inline anchors vs the outdated group once the diff is built. */
	githubThreads?: PRReviewThread[];
	githubExportSelection: Record<string, boolean>;
	onToggleThreadExport: (threadId: string) => void;
	onSendThreadToAgent: (thread: PRReviewThread) => void;
	threadSendStates: Record<string, ThreadSendState>;
}

/** Per-line extend payload passed to the diff library: the local thread and/or GitHub threads. */
interface ExtendLineData {
	local?: InlineDiffCommentThread;
	github?: PRReviewThread[];
}

type DiffTreeNode = DiffTreeFolderNode | DiffTreeFileNode;

interface DiffTreeFolderNode {
	type: "folder";
	key: string;
	name: string;
	path: string;
	children: DiffTreeNode[];
}

interface DiffTreeFileNode {
	type: "file";
	key: string;
	name: string;
	path: string;
	fileId: string;
	status: TaskDiffFileStatus;
	skipped?: "binary" | "too-large";
}

function createEmptyInlineCommentFileData(): InlineDiffCommentFileData {
	return {
		oldFile: {},
		newFile: {},
	};
}

function getInlineCommentSideKey(side: number, splitSide: DiffLibrary["SplitSide"]): InlineCommentSideKey {
	return side === splitSide.old ? "oldFile" : "newFile";
}

function getInlineCommentSideLabel(side: InlineCommentSideKey): "infoPanel.diffCommentSideOld" | "infoPanel.diffCommentSideNew" {
	return side === "oldFile" ? "infoPanel.diffCommentSideOld" : "infoPanel.diffCommentSideNew";
}

function formatInlineCommentLineLabel(
	t: ReturnType<typeof useT>,
	side: InlineCommentSideKey,
	startLine: number,
	endLine: number,
): string {
	const sideLabel = t(getInlineCommentSideLabel(side));
	const lo = Math.min(startLine, endLine);
	const hi = Math.max(startLine, endLine);
	return lo === hi
		? t("infoPanel.diffCommentLine", { side: sideLabel, line: String(lo) })
		: t("infoPanel.diffCommentLines", { side: sideLabel, start: String(lo), end: String(hi) });
}

function getCopiedFilePath(worktreePath: string | null | undefined, file: TaskDiffFile): string {
	const filePath = getReviewFilePath(file);
	if (!worktreePath) {
		return filePath;
	}
	return `${worktreePath.replace(/\/+$/, "")}/${filePath.replace(/^\/+/, "")}`;
}

function getReviewCommentPreview(value: string, maxLength = 100): string {
	const normalized = value.trim().replace(/\s+/g, " ");
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, maxLength)}...`;
}

function collectDiffSearchCandidates(file: TaskDiffFile): DiffSearchLineCandidate[] {
	const candidates: DiffSearchLineCandidate[] = [];
	const seen = new Set<string>();

	const addCandidate = (side: InlineCommentSideKey, lineNumber: number | null, text: string) => {
		const trimmedText = text.trim();
		if (!trimmedText) {
			return;
		}
		const key = `${side}:${lineNumber ?? "?"}:${trimmedText}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		candidates.push({
			side,
			lineNumber,
			text: trimmedText,
		});
	};

	if (file.hunks && file.hunks.length > 0) {
		for (const hunk of file.hunks) {
			for (const line of parseDiffHunkLines(hunk)) {
				if (line.kind === "-") {
					addCandidate("oldFile", line.oldLine, line.content);
				} else {
					addCandidate("newFile", line.newLine, line.content);
				}
			}
		}
		if (candidates.length > 0) {
			return candidates;
		}
	}

	file.oldContent.split("\n").forEach((line, index) => addCandidate("oldFile", index + 1, line));
	file.newContent.split("\n").forEach((line, index) => addCandidate("newFile", index + 1, line));
	return candidates;
}

function buildDiffSearchMatches(files: TaskDiffFile[], query: string): DiffSearchMatch[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) {
		return [];
	}

	const matches: DiffSearchMatch[] = [];
	for (const file of files) {
		const filePath = getReviewFilePath(file);
		if (filePath.toLocaleLowerCase().includes(needle)) {
			matches.push({
				id: `${file.id}:path`,
				fileId: file.id,
				filePath,
				kind: "path",
				text: filePath,
				lineNumber: null,
				side: null,
			});
		}

		for (const candidate of collectDiffSearchCandidates(file)) {
			if (!candidate.text.toLocaleLowerCase().includes(needle)) {
				continue;
			}
			matches.push({
				id: `${file.id}:${candidate.side}:${candidate.lineNumber ?? "?"}:${candidate.text}`,
				fileId: file.id,
				filePath,
				kind: "content",
				text: candidate.text,
				lineNumber: candidate.lineNumber,
				side: candidate.side,
			});
		}
	}

	return matches;
}

function renderHighlightedText(text: string, query: string, isCurrent = false): ReactNode {
	const needle = query.trim();
	if (!needle) {
		return text;
	}

	const lowerText = text.toLocaleLowerCase();
	const lowerNeedle = needle.toLocaleLowerCase();
	const parts: ReactNode[] = [];
	let from = 0;
	let matchIndex = 0;

	while (from < text.length) {
		const matchStart = lowerText.indexOf(lowerNeedle, from);
		if (matchStart === -1) {
			break;
		}
		if (matchStart > from) {
			parts.push(text.slice(from, matchStart));
		}
		const matchEnd = matchStart + needle.length;
		parts.push(
			<span
				key={`${text}:${matchStart}:${matchIndex}`}
				className={`dev3-diff-search-highlight${isCurrent && matchIndex === 0 ? " dev3-diff-search-current-hit" : ""}`}
			>
				{text.slice(matchStart, matchEnd)}
			</span>,
		);
		from = matchEnd;
		matchIndex += 1;
	}

	if (parts.length === 0) {
		return text;
	}
	if (from < text.length) {
		parts.push(text.slice(from));
	}
	return parts;
}

function clearDiffSearchDecorations(root: ParentNode | null) {
	if (!root) {
		return;
	}

	for (const line of root.querySelectorAll(".dev3-diff-search-match-line")) {
		line.classList.remove("dev3-diff-search-match-line");
	}
	for (const line of root.querySelectorAll(".dev3-diff-search-current-line")) {
		line.classList.remove("dev3-diff-search-current-line");
	}
}

function lineContainsQuery(container: HTMLElement, query: string): boolean {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) {
		return false;
	}
	return (container.textContent ?? "").toLocaleLowerCase().includes(needle);
}

function hasAnyInlineComments(state: InlineDiffCommentsState): boolean {
	for (const fileData of Object.values(state)) {
		for (const sideMap of [fileData.oldFile, fileData.newFile]) {
			for (const slot of Object.values(sideMap)) {
				if (slot.data.comments.length > 0) {
					return true;
				}
			}
		}
	}
	return false;
}

function buildInlineReviewExportEntries(
	files: TaskDiffFile[],
	inlineComments: InlineDiffCommentsState,
): InlineReviewExportEntry[] {
	const fileOrder = new Map(files.map((file, index) => [file.id, index]));
	const result: InlineReviewExportEntry[] = [];

	for (const file of files) {
		const fileComments = inlineComments[file.id];
		if (!fileComments) {
			continue;
		}

		for (const side of ["oldFile", "newFile"] as const) {
			for (const thread of Object.values(fileComments[side])) {
				for (const comment of thread.data.comments) {
					result.push({
						id: comment.id,
						fileId: file.id,
						filePath: getReviewFilePath(file),
						side: comment.side,
						startLine: comment.startLine,
						endLine: comment.endLine,
						comment: comment.body,
						snippet: extractReviewSnippet(file, comment.side, comment.startLine, comment.endLine),
						fileOrder: fileOrder.get(file.id) ?? Number.MAX_SAFE_INTEGER,
						createdAt: comment.createdAt,
						origin: "local",
						author: null,
					});
				}
			}
		}
	}

	return result.sort(compareReviewExportEntries);
}

function compareReviewExportEntries(left: InlineReviewExportEntry, right: InlineReviewExportEntry): number {
	return (
		left.fileOrder - right.fileOrder
		|| left.startLine - right.startLine
		|| left.createdAt.localeCompare(right.createdAt)
	);
}

/**
 * Export entries for the GitHub review threads the user opted into the batch
 * export. Threads whose anchor no longer resolves against the current diff
 * (outdated / file absent) still export — with the original path/line and no
 * snippet — so the agent sees the reviewer's words either way.
 */
function buildGithubReviewExportEntries(
	files: TaskDiffFile[],
	threads: PRReviewThread[],
	selection: Record<string, boolean>,
): InlineReviewExportEntry[] {
	const fileOrder = new Map(files.map((file, index) => [file.id, index]));
	const result: InlineReviewExportEntry[] = [];

	for (const thread of threads) {
		if (!selection[thread.id]) {
			continue;
		}
		const location = locateThread(files, thread);
		const line = thread.line ?? thread.originalLine ?? 0;
		const comment = thread.comments
			.map((item) => (item.author ? `[${item.author}] ${item.body.trim()}` : item.body.trim()))
			.join("\n\n");
		result.push({
			id: thread.id,
			fileId: location?.file.id ?? thread.path,
			filePath: thread.path,
			side: thread.diffSide === "LEFT" ? "oldFile" : "newFile",
			startLine: line,
			endLine: line,
			comment,
			snippet: location
				? extractReviewSnippet(location.file, location.side, location.line, location.line)
				: { before: null, after: null },
			fileOrder: location ? fileOrder.get(location.file.id) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER,
			createdAt: thread.comments[0]?.createdAt ?? "",
			origin: "github",
			author: thread.comments[0]?.author ?? null,
		});
	}

	return result.sort(compareReviewExportEntries);
}

function buildInlineReviewXml(entries: InlineReviewExportEntry[]): string {
	const lines = ["<reviews>"];
	let hasGithubEntries = false;

	for (const entry of entries) {
		const lineAttr = entry.startLine === entry.endLine
			? String(entry.startLine)
			: `"${entry.startLine}-${entry.endLine}"`;
		if (entry.origin === "github") {
			hasGithubEntries = true;
			lines.push(`<review origin="github"${entry.author ? ` author="${entry.author}"` : ""}>`);
		} else {
			lines.push("<review>");
		}
		lines.push(`<file src="${entry.filePath}" line=${lineAttr}>`);
		if (entry.snippet.before) {
			lines.push(`-${entry.snippet.before}`);
		}
		if (entry.snippet.after) {
			lines.push(`+${entry.snippet.after}`);
		}
		lines.push("</file>");
		lines.push(`<comment>${entry.comment}</comment>`);
		lines.push("</review>");
	}

	lines.push("</reviews>");
	lines.push("---");
	lines.push(hasGithubEntries
		? "Above are code review comments. Reviews marked origin=\"github\" come from GitHub PR reviewers; the rest are my own. Read them carefully and process all of them."
		: "Above my comments about code changes, read them carefully and process all of them.");
	return lines.join("\n");
}

function InlineCommentThreadView({
	thread,
	side,
	lineNumber,
	registerCommentRef,
	editingCommentId,
	editingCommentDraft,
	onEditDraftChange,
	onStartEdit,
	onCancelEdit,
	onSaveEdit,
	onDeleteComment,
}: {
	thread: InlineDiffCommentThread;
	side: InlineCommentSideKey;
	lineNumber: number;
	registerCommentRef: (commentId: string, element: HTMLDivElement | null) => void;
	editingCommentId: string | null;
	editingCommentDraft: string;
	onEditDraftChange: (value: string) => void;
	onStartEdit: (commentId: string, body: string) => void;
	onCancelEdit: () => void;
	onSaveEdit: (commentId: string, body: string) => void;
	onDeleteComment: (commentId: string) => void;
}) {
	const t = useT();
	const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
	const focusedEditCommentIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!editingCommentId) {
			focusedEditCommentIdRef.current = null;
			return;
		}
		if (focusedEditCommentIdRef.current === editingCommentId) {
			return;
		}
		const textarea = editTextareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.focus();
		const end = textarea.value.length;
		textarea.setSelectionRange(end, end);
		focusedEditCommentIdRef.current = editingCommentId;
	}, [editingCommentId]);

	return (
		<div
			className="dev3-inline-comment dev3-inline-comment--thread border-t border-edge bg-base/75 px-4 py-3 space-y-2"
			data-testid="inline-comment-thread"
		>
			<div className="dev3-inline-comment__meta text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-fg-muted">
				{formatInlineCommentLineLabel(
					t,
					side,
					thread.comments.reduce((min, c) => Math.min(min, c.startLine), lineNumber),
					thread.comments.reduce((max, c) => Math.max(max, c.endLine), lineNumber),
				)}
			</div>
			{thread.comments.map((comment) => (
				<div
					key={comment.id}
					ref={(element) => registerCommentRef(comment.id, element)}
					data-inline-comment-id={comment.id}
					className="dev3-inline-comment__bubble scroll-mt-24 rounded-lg border border-edge bg-raised px-3 py-2"
				>
					{editingCommentId === comment.id ? (
						<div className="space-y-2">
							<textarea
								ref={editTextareaRef}
								value={editingCommentDraft}
								onChange={(event) => onEditDraftChange(event.target.value)}
								rows={3}
								className="dev3-inline-comment__textarea w-full resize-y rounded-lg border border-edge bg-base px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-edge-active focus:bg-elevated"
							/>
							<div className="flex items-center justify-end gap-2">
								<button
									type="button"
									onClick={onCancelEdit}
									className="dev3-inline-comment__button dev3-inline-comment__button--secondary inline-flex h-8 items-center justify-center rounded-md border border-edge bg-base px-3 text-xs font-semibold text-fg-2 transition-colors hover:bg-elevated-hover"
								>
									{t("infoPanel.diffCommentCancel")}
								</button>
								<button
									type="button"
									onClick={() => onSaveEdit(comment.id, editingCommentDraft)}
									disabled={!editingCommentDraft.trim()}
									aria-label={t("infoPanel.diffReviewSave")}
									className="dev3-inline-comment__button dev3-inline-comment__button--primary inline-flex h-8 items-center justify-center rounded-md border border-accent bg-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:border-edge disabled:bg-base disabled:text-fg-muted"
								>
									{t("infoPanel.diffReviewSave")}
								</button>
							</div>
						</div>
					) : (
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0 flex-1 text-sm text-fg whitespace-pre-wrap break-words">
								{comment.body}
							</div>
							<div className="flex shrink-0 items-center gap-1">
								<button
									type="button"
									onClick={() => onStartEdit(comment.id, comment.body)}
									aria-label={t("infoPanel.diffReviewEdit")}
									className="inline-flex h-7 items-center justify-center rounded-md border border-edge bg-base px-2 text-[0.6875rem] font-semibold text-fg-2 transition-colors hover:bg-elevated-hover"
								>
									{t("infoPanel.diffReviewEdit")}
								</button>
								<button
									type="button"
									onClick={() => onDeleteComment(comment.id)}
									aria-label={t("infoPanel.diffReviewDelete")}
									className="inline-flex h-7 items-center justify-center rounded-md border border-danger/25 bg-danger/10 px-2 text-[0.6875rem] font-semibold text-danger transition-colors hover:bg-danger/15"
								>
									{t("infoPanel.diffReviewDelete")}
								</button>
							</div>
						</div>
					)}
				</div>
			))}
		</div>
	);
}

function InlineCommentComposer({
	filePath,
	side,
	startLine,
	endLine,
	onCancel,
	onSubmit,
}: {
	filePath: string;
	side: InlineCommentSideKey;
	startLine: number;
	endLine: number;
	onCancel: () => void;
	onSubmit: (body: string) => void;
}) {
	const t = useT();
	const [value, setValue] = useState("");
	const trimmedValue = value.trim();

	return (
		<form
			className="dev3-inline-comment dev3-inline-comment--composer border-t border-edge bg-base/90 px-4 py-3 space-y-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (!trimmedValue) {
					return;
				}
				onSubmit(trimmedValue);
				setValue("");
			}}
		>
			<div className="space-y-1">
				<div className="dev3-inline-comment__title text-[0.75rem] font-semibold text-fg">
					{t("infoPanel.diffCommentAdd")}
				</div>
				<div className="dev3-inline-comment__meta text-[0.6875rem] text-fg-3">
					{filePath} · {formatInlineCommentLineLabel(t, side, startLine, endLine)}
				</div>
			</div>
			<textarea
				value={value}
				onChange={(event) => setValue(event.target.value)}
				placeholder={t("infoPanel.diffCommentPlaceholder")}
				rows={3}
				autoFocus
				className="dev3-inline-comment__textarea w-full resize-y rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-edge-active focus:bg-elevated"
			/>
			<div className="dev3-inline-comment__actions flex items-center justify-end gap-2">
				<button
					type="button"
					onClick={onCancel}
					className="dev3-inline-comment__button dev3-inline-comment__button--secondary inline-flex h-8 items-center justify-center rounded-md border border-edge bg-base px-3 text-xs font-semibold text-fg-2 transition-colors hover:bg-elevated-hover"
				>
					{t("infoPanel.diffCommentCancel")}
				</button>
				<button
					type="submit"
					disabled={!trimmedValue}
					className="dev3-inline-comment__button dev3-inline-comment__button--primary inline-flex h-8 items-center justify-center rounded-md border border-accent bg-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:border-edge disabled:bg-base disabled:text-fg-muted"
				>
					{t("infoPanel.diffCommentSubmit")}
				</button>
			</div>
		</form>
	);
}

function hashText(value: string): string {
	let hash = 5381;
	for (let i = 0; i < value.length; i++) {
		hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
	}
	return (hash >>> 0).toString(36);
}

function getFileReadSignature(taskId: string, file: TaskDiffFile): string {
	return `${taskId}:${file.oldPath ?? ""}:${file.newPath ?? ""}:${getDiffFileContentHash(file)}`;
}

// Hash of the diff payload (hunks + both sides of content). Combined with `file.id`,
// this produces a uuid that invalidates the @git-diff-view/core File cache whenever
// the diff content actually changes — see usage in the DiffFile constructor.
export function getDiffFileContentHash(file: TaskDiffFile): string {
	const payload = `${file.hunks?.join("\n") ?? ""}\u0001${file.oldContent}\u0000${file.newContent}`;
	return hashText(payload);
}

function getSkippedFileReadSignature(taskId: string, skipped: TaskDiffSkippedFile): string {
	const payload = `${skipped.status}:${skipped.reason}:${skipped.oldSize ?? ""}:${skipped.newSize ?? ""}`;
	return `${taskId}:${skipped.oldPath ?? ""}:${skipped.newPath ?? ""}:${hashText(payload)}`;
}

function readStoredReadState(): Record<string, boolean> {
	try {
		const raw = localStorage.getItem(LS_DIFF_READ_STATE);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return parsed as Record<string, boolean>;
		}
	} catch {}
	return {};
}

function writeStoredReadState(state: Record<string, boolean>): void {
	try {
		localStorage.setItem(LS_DIFF_READ_STATE, JSON.stringify(state));
	} catch {}
}

function reviewStorageKey(taskId: string): string {
	return `${LS_DIFF_REVIEW}:${taskId}`;
}

// A persisted review is a short-lived safety net, not a permanent store: it lets
// the user come back and re-copy after an accidental clipboard clobber (e.g. a
// stray terminal selection after copying). It is kept for at most this long since
// the review was first created, then auto-expires so stale comments never linger.
const REVIEW_TTL_MS = 3 * 24 * 60 * 60 * 1000;

interface StoredReview {
	savedAt: number;
	comments: InlineDiffCommentsState;
}

function readStoredReview(taskId: string): InlineDiffCommentsState {
	try {
		const raw = localStorage.getItem(reviewStorageKey(taskId));
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw) as Partial<StoredReview> | null;
		const savedAt = typeof parsed?.savedAt === "number" ? parsed.savedAt : null;
		const comments = parsed?.comments && typeof parsed.comments === "object" ? parsed.comments : null;
		// Unknown/legacy shape or past the TTL — drop it.
		if (savedAt === null || comments === null || Date.now() - savedAt > REVIEW_TTL_MS) {
			localStorage.removeItem(reviewStorageKey(taskId));
			return {};
		}
		return comments;
	} catch {}
	return {};
}

function writeStoredReview(taskId: string, state: InlineDiffCommentsState): void {
	try {
		if (!hasAnyInlineComments(state)) {
			localStorage.removeItem(reviewStorageKey(taskId));
			return;
		}
		// Preserve the original creation time across edits so the TTL counts from
		// when the review was first started, not from the latest keystroke.
		let savedAt = Date.now();
		const existingRaw = localStorage.getItem(reviewStorageKey(taskId));
		if (existingRaw) {
			try {
				const existing = JSON.parse(existingRaw) as Partial<StoredReview> | null;
				if (typeof existing?.savedAt === "number") {
					savedAt = existing.savedAt;
				}
			} catch {
				// Corrupt existing entry — proceed with fresh savedAt so the write
				// still completes instead of being silently swallowed by the outer catch.
			}
		}
		const payload: StoredReview = { savedAt, comments: state };
		localStorage.setItem(reviewStorageKey(taskId), JSON.stringify(payload));
	} catch {}
}

// Global garbage-collection for persisted reviews. The per-key TTL in
// readStoredReview only fires when *that* task's diff is reopened, so a review
// for a task that is never revisited (or has been deleted) would linger forever.
// This sweep walks every review key and drops expired or corrupt entries; it runs
// whenever any diff viewer mounts, keeping the working set to "reviews touched in
// the last few days" regardless of which tasks are reopened.
function pruneExpiredReviews(now: number = Date.now()): void {
	try {
		const prefix = `${LS_DIFF_REVIEW}:`;
		const staleKeys: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key || !key.startsWith(prefix)) {
				continue;
			}
			try {
				const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<StoredReview> | null;
				const savedAt = typeof parsed?.savedAt === "number" ? parsed.savedAt : null;
				if (savedAt === null || now - savedAt > REVIEW_TTL_MS) {
					staleKeys.push(key);
				}
			} catch {
				staleKeys.push(key);
			}
		}
		for (const key of staleKeys) {
			localStorage.removeItem(key);
		}
	} catch {}
}

function normalizeDiffPath(value: string | null | undefined): string {
	return (value ?? "")
		.replace(/^\.?\//, "")
		.replace(/^[ab]\//, "");
}

function findDiffFileByPath(files: TaskDiffFile[], path: string | undefined): TaskDiffFile | null {
	if (!path) {
		return null;
	}
	const targetPath = normalizeDiffPath(path);
	return files.find((file) => (
		normalizeDiffPath(file.id) === targetPath
		|| normalizeDiffPath(file.displayPath) === targetPath
		|| normalizeDiffPath(file.newPath) === targetPath
		|| normalizeDiffPath(file.oldPath) === targetPath
	)) ?? null;
}

function statusClassName(status: TaskDiffFileStatus): string {
	switch (status) {
		case "added":
		case "untracked":
			return "text-success bg-success/10 border-success/25";
		case "deleted":
			return "text-danger bg-danger/10 border-danger/25";
		case "renamed":
		case "copied":
			return "text-accent bg-accent/10 border-accent/25";
		default:
			return "text-fg-2 bg-raised border-edge";
	}
}

function formatSkippedSize(size: number | null): string {
	return size === null ? "—" : formatBytes(size);
}

function statusLabelLong(status: TaskDiffFileStatus, t: (key: any, vars?: any) => string): string {
	switch (status) {
		case "added":
			return t("infoPanel.diffStatusAdded");
		case "modified":
			return t("infoPanel.diffStatusModified");
		case "deleted":
			return t("infoPanel.diffStatusDeleted");
		case "renamed":
			return t("infoPanel.diffStatusRenamed");
		case "copied":
			return t("infoPanel.diffStatusCopied");
		case "type-changed":
			return t("infoPanel.diffStatusTypeChanged");
		case "untracked":
			return t("infoPanel.diffStatusUntracked");
		default:
			return status;
	}
}

function statusLabel(status: TaskDiffFileStatus): string {
	switch (status) {
		case "added":
			return "A";
		case "modified":
			return "M";
		case "deleted":
			return "D";
		case "renamed":
			return "R";
		case "copied":
			return "C";
		case "type-changed":
			return "T";
		case "untracked":
			return "?";
		default:
			return "•";
	}
}

function getFileDiffStats(file: TaskDiffFile): { insertions: number; deletions: number } {
	return { insertions: file.insertions, deletions: file.deletions };
}

function diffFileFullPath(file: TaskDiffFile | TaskDiffSkippedFile): string {
	return file.newPath ?? file.oldPath ?? file.displayPath;
}

// The backend assembles `files` by concatenating tracked-modified entries with untracked entries
// (see git.ts: `[...entries, ...untrackedEntries]`). This makes the right-panel list order out of
// sync with the alphabetical file tree on the left. Sorting both lists by their full path keeps
// the tree click → right-panel scroll mapping monotonic.
function sortTaskDiffResponse(response: TaskDiffResponse): TaskDiffResponse {
	const byPath = (left: TaskDiffFile | TaskDiffSkippedFile, right: TaskDiffFile | TaskDiffSkippedFile) =>
		diffFileFullPath(left).localeCompare(diffFileFullPath(right));
	return {
		...response,
		files: [...response.files].sort(byPath),
		skippedFiles: [...response.skippedFiles].sort(byPath),
	};
}

function buildDiffTree(files: TaskDiffFile[], skippedFiles: TaskDiffSkippedFile[]): DiffTreeNode[] {
	const root: DiffTreeNode[] = [];

	function findOrCreateFolder(children: DiffTreeNode[], name: string, path: string): DiffTreeFolderNode {
		const existing = children.find((child): child is DiffTreeFolderNode => child.type === "folder" && child.name === name);
		if (existing) {
			return existing;
		}
		const nextFolder: DiffTreeFolderNode = {
			type: "folder",
			key: `folder:${path}`,
			name,
			path,
			children: [],
		};
		children.push(nextFolder);
		return nextFolder;
	}

	function sortNodes(nodes: DiffTreeNode[]): DiffTreeNode[] {
		nodes.sort((left, right) => {
			if (left.type !== right.type) {
				return left.type === "folder" ? -1 : 1;
			}
			return left.name.localeCompare(right.name);
		});
		for (const node of nodes) {
			if (node.type === "folder") {
				sortNodes(node.children);
			}
		}
		return nodes;
	}

	function insertFileNode(fullPath: string, node: DiffTreeFileNode): void {
		const segments = fullPath.split("/").filter(Boolean);
		if (segments.length === 0) {
			return;
		}
		let currentChildren = root;
		let currentPath = "";
		for (let index = 0; index < segments.length - 1; index++) {
			const segment = segments[index];
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			currentChildren = findOrCreateFolder(currentChildren, segment, currentPath).children;
		}
		currentChildren.push({ ...node, name: segments[segments.length - 1] });
	}

	for (const file of files) {
		const fullPath = file.newPath ?? file.oldPath ?? file.displayPath;
		insertFileNode(fullPath, {
			type: "file",
			key: `file:${file.id}`,
			name: "",
			path: fullPath,
			fileId: file.id,
			status: file.status,
		});
	}

	for (const skipped of skippedFiles) {
		const fullPath = skipped.newPath ?? skipped.oldPath ?? skipped.displayPath;
		insertFileNode(fullPath, {
			type: "file",
			key: `file:${skipped.id}`,
			name: "",
			path: fullPath,
			fileId: skipped.id,
			status: skipped.status,
			skipped: skipped.reason,
		});
	}

	return sortNodes(root);
}

function TaskDiffFileSection({
	file,
	worktreePath,
	diffLib,
	resolvedTheme,
	viewMode,
	narrow,
	searchQuery,
	isCurrentPathMatch,
	comments,
	eager,
	expanded,
	isRead,
	onAddComment,
	editingCommentId,
	editingCommentDraft,
	onEditDraftChange,
	onStartEditComment,
	onCancelEditComment,
	onSaveEditComment,
	onDeleteComment,
	onToggleExpanded,
	onToggleRead,
	registerCommentRef,
	sectionRef,
	githubThreads,
	githubExportSelection,
	onToggleThreadExport,
	onSendThreadToAgent,
	threadSendStates,
}: TaskDiffFileSectionProps) {
	const t = useT();
	const fileStats = getFileDiffStats(file);
	const [outdatedOpen, setOutdatedOpen] = useState(false);
	const [activated, setActivated] = useState(eager);
	const [diffFile, setDiffFile] = useState<DiffInstance | null>(null);
	const [buildError, setBuildError] = useState<string | null>(null);
	const [copiedPath, setCopiedPath] = useState(false);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const diffInstanceRef = useRef<DiffInstance | null>(null);
	const builtModesRef = useRef<Set<DiffViewMode>>(new Set());
	const isFirstExpandedEffectRef = useRef(true);
	const copiedPathResetRef = useRef<number | null>(null);
	const dragHostRef = useRef<HTMLDivElement | null>(null);
	const widgetHookRef = useRef<{ getReadonlyState: () => { setWidget: (arg: { side?: number; lineNumber?: number }) => void } } | null>(null);
	const gutterDragRef = useRef<{ side: InlineCommentSideKey; sideNum: number; anchor: number; current: number } | null>(null);
	const [pendingRange, setPendingRange] = useState<{ side: InlineCommentSideKey; startLine: number; endLine: number } | null>(null);

	const clearRangeHighlight = useCallback(() => {
		dragHostRef.current
			?.querySelectorAll(".dev3-diff-line-range")
			.forEach((row) => row.classList.remove("dev3-diff-line-range"));
	}, []);

	// Read the side + line number from a gutter cell. Handles both layouts:
	//  - split:   cell `.diff-line-{old,new}-num` with a `[data-line-num]` span
	//  - unified: cell `.diff-line-num` with `[data-line-old-num]`/`[data-line-new-num]` spans
	// `lockedSide` constrains which side to read in unified mode (and is used to
	// reject rows that belong to the other side in split mode).
	const readGutterCell = useCallback((cell: Element | null, lockedSide?: InlineCommentSideKey): { side: InlineCommentSideKey; line: number } | null => {
		if (!cell) {
			return null;
		}
		const readAttr = (attr: string): number => Number(cell.querySelector(`[${attr}]`)?.getAttribute(attr) ?? NaN);
		if (cell.classList.contains("diff-line-old-num")) {
			const line = readAttr("data-line-num");
			return Number.isFinite(line) ? { side: "oldFile", line } : null;
		}
		if (cell.classList.contains("diff-line-new-num")) {
			const line = readAttr("data-line-num");
			return Number.isFinite(line) ? { side: "newFile", line } : null;
		}
		// Unified: pick the locked side, else prefer the new side when present.
		const oldLine = readAttr("data-line-old-num");
		const newLine = readAttr("data-line-new-num");
		if (lockedSide === "oldFile") {
			return Number.isFinite(oldLine) ? { side: "oldFile", line: oldLine } : null;
		}
		if (lockedSide === "newFile") {
			return Number.isFinite(newLine) ? { side: "newFile", line: newLine } : null;
		}
		if (Number.isFinite(newLine)) {
			return { side: "newFile", line: newLine };
		}
		return Number.isFinite(oldLine) ? { side: "oldFile", line: oldLine } : null;
	}, []);

	const applyRangeHighlight = useCallback((side: InlineCommentSideKey, a: number, b: number) => {
		const host = dragHostRef.current;
		if (!host) {
			return;
		}
		const lo = Math.min(a, b);
		const hi = Math.max(a, b);
		host.querySelectorAll(".dev3-diff-line-range").forEach((row) => row.classList.remove("dev3-diff-line-range"));
		host.querySelectorAll(".diff-line-old-num, .diff-line-new-num, .diff-line-num").forEach((cell) => {
			const info = readGutterCell(cell, side);
			if (info && info.side === side && info.line >= lo && info.line <= hi) {
				cell.closest(".diff-line")?.classList.add("dev3-diff-line-range");
			}
		});
	}, [readGutterCell]);

	// Re-apply the range highlight after React commits (the library re-renders the
	// table rows when the composer widget opens, which wipes manually-added classes).
	useEffect(() => {
		if (pendingRange) {
			applyRangeHighlight(pendingRange.side, pendingRange.startLine, pendingRange.endLine);
		} else {
			clearRangeHighlight();
		}
	}, [pendingRange, diffFile, applyRangeHighlight, clearRangeHighlight]);

	const handleGutterMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
		if (event.button !== 0) {
			return;
		}
		const target = event.target as HTMLElement;
		// Let the hover "+" widget handle single-line comments.
		if (target.closest(".diff-add-widget, .diff-add-widget-wrapper")) {
			return;
		}
		const numCell = target.closest(".diff-line-old-num, .diff-line-new-num, .diff-line-num");
		const anchorInfo = readGutterCell(numCell);
		if (!anchorInfo) {
			return;
		}
		const sideKey = anchorInfo.side;
		const sideNum = sideKey === "oldFile" ? diffLib.SplitSide.old : diffLib.SplitSide.new;
		const lineValue = anchorInfo.line;
		// Prevent native text selection while dragging across the gutter.
		event.preventDefault();
		gutterDragRef.current = { side: sideKey, sideNum, anchor: lineValue, current: lineValue };
		setPendingRange(null);
		dragHostRef.current?.classList.add("dev3-diff-selecting");
		applyRangeHighlight(sideKey, lineValue, lineValue);

		const onMove = (moveEvent: MouseEvent) => {
			const drag = gutterDragRef.current;
			if (!drag) {
				return;
			}
			const row = (moveEvent.target as HTMLElement | null)?.closest(".diff-line");
			if (!row || !dragHostRef.current?.contains(row)) {
				return;
			}
			const cell = row.querySelector(".diff-line-old-num, .diff-line-new-num, .diff-line-num");
			const info = readGutterCell(cell, drag.side);
			if (!info || info.side !== drag.side || info.line === drag.current) {
				return;
			}
			drag.current = info.line;
			applyRangeHighlight(drag.side, drag.anchor, info.line);
		};

		const onUp = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			const drag = gutterDragRef.current;
			gutterDragRef.current = null;
			dragHostRef.current?.classList.remove("dev3-diff-selecting");
			if (!drag) {
				return;
			}
			const lo = Math.min(drag.anchor, drag.current);
			const hi = Math.max(drag.anchor, drag.current);
			if (lo === hi) {
				// No range dragged — leave single-line commenting to the "+" widget.
				clearRangeHighlight();
				return;
			}
			setPendingRange({ side: drag.side, startLine: lo, endLine: hi });
			widgetHookRef.current?.getReadonlyState().setWidget({ side: drag.sideNum, lineNumber: hi });
		};

		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	}, [diffLib, readGutterCell, applyRangeHighlight, clearRangeHighlight]);

	useEffect(() => {
		setActivated(eager);
		isFirstExpandedEffectRef.current = true;
	}, [eager, file.id]);

	useEffect(() => {
		diffInstanceRef.current = null;
		builtModesRef.current = new Set();
		setDiffFile(null);
		setBuildError(null);
	}, [diffLib, file.hunks, file.id, file.newContent, file.newPath, file.oldContent, file.oldPath]);

	useEffect(() => () => {
		if (copiedPathResetRef.current !== null) {
			window.clearTimeout(copiedPathResetRef.current);
		}
	}, []);

	useEffect(() => {
		if (isFirstExpandedEffectRef.current) {
			isFirstExpandedEffectRef.current = false;
			return;
		}
		if (expanded) {
			setActivated(true);
		}
	}, [expanded]);

	useEffect(() => {
		if (activated) {
			return;
		}

		const element = hostRef.current;
		if (!element) {
			return;
		}
		if (typeof IntersectionObserver === "undefined") {
			setActivated(true);
			return;
		}

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						setActivated(true);
						observer.disconnect();
						break;
					}
				}
			},
			{ rootMargin: "2000px 0px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [activated]);

	useEffect(() => {
		if (!activated) {
			return;
		}

		let cancelled = false;

		const timer = window.setTimeout(() => {
			try {
				let nextDiffFile = diffInstanceRef.current;
				if (!nextDiffFile) {
					const oldPath = file.oldPath ?? file.newPath ?? "/dev/null";
					const newPath = file.newPath ?? file.oldPath ?? "/dev/null";
					// The @git-diff-view/core cache is keyed by uuid alone (ignores file content).
					// Using a stable `file.id` across re-renders returns a stale cached File after
					// the branch is rebased or the diff changes. Mix a content hash into the uuid
					// so the cache invalidates when the old/new content or hunks change.
					const diffCacheUuid = `${file.id}:${getDiffFileContentHash(file)}`;
					nextDiffFile = file.hunks
						? new diffLib.DiffFile(oldPath, file.oldContent, newPath, file.newContent, file.hunks, undefined, undefined, diffCacheUuid)
						: diffLib.generateDiffFile(oldPath, file.oldContent, newPath, file.newContent);
					nextDiffFile.initTheme(resolvedTheme);
					nextDiffFile.initRaw();
					// Populate syntax-highlight data up front so the first render of
					// <DiffView diffViewHighlight> already reads colored tokens. The
					// library's own post-mount initSyntax + notifyAll does not reliably
					// re-render the memoized line rows, leaving the diff unhighlighted.
					nextDiffFile.initSyntax();
					diffInstanceRef.current = nextDiffFile;
				} else {
					nextDiffFile.initTheme(resolvedTheme);
				}
				if (!builtModesRef.current.has(viewMode)) {
					if (viewMode === "split") {
						nextDiffFile.buildSplitDiffLines();
					} else {
						nextDiffFile.buildUnifiedDiffLines();
					}
					builtModesRef.current.add(viewMode);
				}
				if (!cancelled) {
					setBuildError(null);
					setDiffFile(nextDiffFile);
				}
			} catch (err) {
				if (!cancelled) {
					setBuildError(String(err));
					setDiffFile(null);
				}
			}
		}, 0);

		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [activated, diffLib, file.hunks, file.id, file.newContent, file.newPath, file.oldContent, file.oldPath, resolvedTheme, viewMode]);

	const DiffView = diffLib.DiffView;
	const diffMode = viewMode === "split" ? diffLib.DiffModeEnum.Split : diffLib.DiffModeEnum.Unified;
	const diffRenderKey = `${file.id}:${viewMode}:${resolvedTheme}:${getDiffFileContentHash(file)}`;
	const copiedFilePath = getCopiedFilePath(worktreePath, file);

	// The built diff instance is the only honest source of "is this line on
	// screen" (the backend ships hunks: null — the library computes the diff
	// itself), so the inline-vs-outdated partition waits for diffFile.
	const githubPartition = useMemo(() => {
		if (!githubThreads?.length || !diffFile) {
			return null;
		}
		return partitionThreadsForDiff(githubThreads, (side, line) =>
			isLineRenderedInDiff(diffFile, viewMode, diffLib.SplitSide, side, line));
	}, [githubThreads, diffFile, viewMode, diffLib]);
	// Threads on a file whose diff never finished building must not vanish:
	// until the partition exists they all count as unanchored.
	const githubOutdatedThreads = githubPartition?.outdated ?? githubThreads ?? [];

	// The diff library takes one extend-data slot per side+line, so local
	// comments and GitHub threads anchored to the same line merge into one
	// payload and render stacked inside renderExtendLine.
	const extendData = useMemo(() => {
		const merged: { oldFile: Record<string, { data: ExtendLineData }>; newFile: Record<string, { data: ExtendLineData }> } = {
			oldFile: {},
			newFile: {},
		};
		for (const side of ["oldFile", "newFile"] as const) {
			for (const [line, slot] of Object.entries(comments[side])) {
				merged[side][line] = { data: { local: slot.data } };
			}
			const githubSide = githubPartition?.inline[side];
			if (githubSide) {
				for (const [line, threads] of Object.entries(githubSide)) {
					merged[side][line] = { data: { ...merged[side][line]?.data, github: threads } };
				}
			}
		}
		return merged;
	}, [comments, githubPartition]);

	function handleCopyPath() {
		navigator.clipboard.writeText(copiedFilePath).then(() => {
			setCopiedPath(true);
			if (copiedPathResetRef.current !== null) {
				window.clearTimeout(copiedPathResetRef.current);
			}
			copiedPathResetRef.current = window.setTimeout(() => {
				setCopiedPath(false);
				copiedPathResetRef.current = null;
			}, 1500);
		}).catch(() => {});
	}

	return (
		<div
			ref={(element) => {
				hostRef.current = element;
				sectionRef(element);
			}}
			className={`border border-edge rounded-xl ${isRead ? "bg-elevated" : "bg-raised"}`}
			data-file-id={file.id}
		>
			<div className={`sticky top-0 z-10 px-4 py-3 border-b border-edge flex flex-wrap items-center gap-3 backdrop-blur ${isRead ? "bg-elevated/95" : "bg-raised/95"}`}>
				<div className="min-w-0 flex-1 flex items-center gap-2">
					<span className={`inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded-md border text-[0.6875rem] font-bold ${statusClassName(file.status)}`}>
						{statusLabel(file.status)}
					</span>

					<button
						onClick={onToggleExpanded}
						aria-expanded={expanded}
						className="min-w-0 flex items-center text-left hover:text-fg transition-colors"
						title={file.displayPath}
					>
						{narrow ? (() => {
							// One line, never a multi-row wrap: the directory part
							// truncates away while the basename always stays visible
							// (it is what identifies the file on a phone).
							const slashIdx = file.displayPath.lastIndexOf("/");
							const dirPart = slashIdx >= 0 ? file.displayPath.slice(0, slashIdx + 1) : "";
							const basePart = slashIdx >= 0 ? file.displayPath.slice(slashIdx + 1) : file.displayPath;
							return (
								<span className={`min-w-0 flex w-full items-baseline font-mono text-sm ${isRead ? "text-fg-muted line-through decoration-1" : "text-fg"}${isCurrentPathMatch ? " dev3-diff-search-current-hit" : ""}`}>
									{dirPart && (
										<span className="min-w-0 truncate opacity-70">
											{renderHighlightedText(dirPart, searchQuery, false)}
										</span>
									)}
									<span className="min-w-0 max-w-full shrink-0 truncate">
										{renderHighlightedText(basePart, searchQuery, isCurrentPathMatch)}
									</span>
								</span>
							);
						})() : (
							<span className={`font-mono text-sm break-words min-w-0 ${isRead ? "text-fg-muted line-through decoration-1" : "text-fg"}${isCurrentPathMatch ? " dev3-diff-search-current-hit" : ""}`}>
								{renderHighlightedText(file.displayPath, searchQuery, isCurrentPathMatch)}
							</span>
						)}
					</button>

					<button
						type="button"
						onClick={handleCopyPath}
						aria-label={copiedPath
							? t("infoPanel.diffFilePathCopied", { file: copiedFilePath })
							: t("infoPanel.diffCopyFilePath", { file: copiedFilePath })}
						title={copiedPath
							? t("infoPanel.diffFilePathCopied", { file: copiedFilePath })
							: t("infoPanel.diffCopyFilePath", { file: copiedFilePath })}
						className={`inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border transition-colors ${
							copiedPath
								? "border-success/30 bg-success/10 text-success"
								: "border-edge bg-base text-fg-2 hover:bg-elevated-hover"
						}`}
					>
						<span
							aria-hidden="true"
							className="text-[1rem] leading-none"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						>
							{copiedPath ? "\uF00C" : "\uF4BB"}
						</span>
					</button>

					{(fileStats.insertions > 0 || fileStats.deletions > 0) && (
						<span className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-base/80 px-2 py-0.5 text-[0.6875rem] font-mono">
							{fileStats.insertions > 0 && <span className="text-success">+{fileStats.insertions}</span>}
							{fileStats.deletions > 0 && <span className="text-danger">−{fileStats.deletions}</span>}
						</span>
					)}
				</div>

				<label className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-semibold cursor-pointer transition-colors ${isRead ? "border-success/30 bg-success/10 text-success" : "border-edge bg-base text-fg-2 hover:bg-elevated-hover"}`}>
					<input
						type="checkbox"
						checked={isRead}
						onChange={onToggleRead}
						aria-label={t("infoPanel.diffReadFile", { file: file.displayPath })}
						className="sr-only"
					/>
					<span
						aria-hidden="true"
						className={`inline-flex h-4 w-4 items-center justify-center rounded-[4px] border text-[0.7rem] leading-none ${isRead ? "border-success bg-success text-base" : "border-edge bg-base text-transparent"}`}
					>
						{"\u2713"}
					</span>
					<span>{t("infoPanel.diffRead")}</span>
				</label>

				<button
					onClick={onToggleExpanded}
					aria-label={expanded ? t("infoPanel.diffCollapseFile", { file: file.displayPath }) : t("infoPanel.diffExpandFile", { file: file.displayPath })}
					aria-expanded={expanded}
					className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-edge bg-base text-[0.95rem] leading-none text-fg-2 hover:bg-elevated-hover transition-colors"
				>
					{expanded ? "\u25BE" : "\u25B8"}
				</button>
			</div>

			{expanded && (
				buildError ? (
					<div className="px-4 py-5 text-sm text-danger">{buildError}</div>
				) : diffFile ? (
					<>
					<div ref={dragHostRef} className="dev3-diff-drag-host" onMouseDown={handleGutterMouseDown}>
					<DiffView
						key={diffRenderKey}
						diffFile={diffFile}
						diffViewTheme={resolvedTheme}
						diffViewMode={diffMode}
						diffViewWrap={false}
						diffViewHighlight={true}
						diffViewAddWidget
						extendData={extendData}
						onCreateUseWidgetHook={(hook: typeof widgetHookRef.current) => { widgetHookRef.current = hook; }}
						renderWidgetLine={({ lineNumber, side, onClose }: { lineNumber: number; side: number; onClose: () => void }) => {
							const sideKey = getInlineCommentSideKey(side, diffLib.SplitSide);
							const isPendingRange = pendingRange?.side === sideKey && pendingRange.endLine === lineNumber;
							const startLine = isPendingRange ? pendingRange.startLine : lineNumber;
							const closeComposer = () => {
								onClose();
								setPendingRange(null);
								clearRangeHighlight();
							};
							return (
								<InlineCommentComposer
									filePath={file.displayPath}
									side={sideKey}
									startLine={startLine}
									endLine={lineNumber}
									onCancel={closeComposer}
									onSubmit={(body) => {
										onAddComment({
											fileId: file.id,
											side: sideKey,
											startLine,
											endLine: lineNumber,
											body,
										});
										closeComposer();
									}}
								/>
							);
						}}
						renderExtendLine={({ data, lineNumber, side }: { data: ExtendLineData; lineNumber: number; side: number }) => (
							<>
								{data.github?.map((thread) => (
									<GithubThreadView
										key={thread.id}
										thread={thread}
										exportSelected={!!githubExportSelection[thread.id]}
										onToggleExport={onToggleThreadExport}
										onSendToAgent={onSendThreadToAgent}
										sendState={threadSendStates[thread.id]}
										registerRef={registerCommentRef}
									/>
								))}
								{data.local && (
									<InlineCommentThreadView
										thread={data.local}
										side={getInlineCommentSideKey(side, diffLib.SplitSide)}
										lineNumber={lineNumber}
										registerCommentRef={registerCommentRef}
										editingCommentId={editingCommentId}
										editingCommentDraft={editingCommentDraft}
										onEditDraftChange={onEditDraftChange}
										onStartEdit={onStartEditComment}
										onCancelEdit={onCancelEditComment}
										onSaveEdit={onSaveEditComment}
										onDeleteComment={onDeleteComment}
									/>
								)}
							</>
						)}
						className="diff-tailwindcss-wrapper"
					/>
					</div>
					<OutdatedThreadsGroup
						threads={githubOutdatedThreads}
						open={outdatedOpen}
						onToggle={() => setOutdatedOpen((current) => !current)}
						exportSelection={githubExportSelection}
						onToggleExport={onToggleThreadExport}
						onSendToAgent={onSendThreadToAgent}
						sendStates={threadSendStates}
						registerRef={registerCommentRef}
					/>
					</>
				) : (
					<div className="p-4 space-y-3 animate-pulse">
						<div className="h-4 w-36 rounded bg-elevated" />
						<div className="h-24 rounded bg-base" />
					</div>
				)
			)}
		</div>
	);
}

function TaskDiffViewer({ task, project, request, onBack, navigationGuardRef }: TaskDiffViewerProps) {
	const t = useT();
	const resolvedTheme = useResolvedTheme();
	const toolbarRef = useRef<HTMLDivElement | null>(null);
	const scrollRegionRef = useRef<HTMLDivElement | null>(null);
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
	const pendingScrollFrameRef = useRef<number | null>(null);
	const pendingCommentScrollFrameRef = useRef<number | null>(null);
	const pendingSearchScrollFrameRef = useRef<number | null>(null);
	const commentRefs = useRef<Record<string, HTMLDivElement | null>>({});
	const [diffLib, setDiffLib] = useState<DiffLibrary | null>(null);
	const [payload, setPayload] = useState<TaskDiffResponse | null>(null);
	const [currentRequest, setCurrentRequest] = useState<TaskInlineDiffRequest>(() => applyPreferredDiffMode(request));
	const [requestVersion, setRequestVersion] = useState(0);
	// `recent` mode's trailing-commit count. Deliberately NOT persisted: it resets
	// to DEFAULT_RECENT_COUNT on every open so the default is always "last commit".
	const [recentCount, setRecentCount] = useState(DEFAULT_RECENT_COUNT);
	const [recentMenuOpen, setRecentMenuOpen] = useState(false);
	const recentMenuRef = useRef<HTMLDivElement | null>(null);
	const recentCaretRef = useRef<HTMLButtonElement | null>(null);
	const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
	const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
	const [readFiles, setReadFiles] = useState<Record<string, boolean>>({});
	const [activeFileId, setActiveFileId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [showLoadingState, setShowLoadingState] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [viewMode, setViewMode] = useState<DiffViewMode | null>(null);
	// Lazy-initialize from localStorage so the first persist-effect fire (when
	// payload arrives) sees the stored review rather than `{}` — otherwise the
	// persist effect would delete the localStorage entry before the restore effect's
	// setInlineComments causes a second render that writes it back.
	const [inlineComments, setInlineComments] = useState<InlineDiffCommentsState>(() => readStoredReview(task.id));
	const [copiedReviewXml, setCopiedReviewXml] = useState(false);
	const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
	const [editingCommentDraft, setEditingCommentDraft] = useState("");
	// GitHub PR review layer (read-only). Fetched once per diff open when the
	// task carries a sticky PR; the refresh button re-fetches with force. The
	// export selection and send states are deliberately session-local — unlike
	// local comments, the source of truth lives on GitHub.
	const [prComments, setPrComments] = useState<TaskPRCommentsPayload | null>(null);
	const [prCommentsError, setPrCommentsError] = useState<string | null>(null);
	const [prCommentsRefreshing, setPrCommentsRefreshing] = useState(false);
	const [showResolvedThreads, setShowResolvedThreads] = useState(false);
	const [githubExportSelection, setGithubExportSelection] = useState<Record<string, boolean>>({});
	const [threadSendStates, setThreadSendStates] = useState<Record<string, ThreadSendState>>({});
	const prFetchSeqRef = useRef(0);
	const [isSearchOpen, setIsSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [activeSearchIndex, setActiveSearchIndex] = useState(0);
	const [filesCollapsed, setFilesCollapsed] = useState<boolean>(() => readFilesCollapsed());
	// Narrow (phone / narrow window): the 22rem files aside cannot sit beside the
	// diff — it would starve the diff to a sliver. Instead the diff owns the full
	// width and the file list moves into a bottom sheet behind a "Files" button.
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [filesSheetOpen, setFilesSheetOpen] = useState(false);
	// Split view is unusable at phone width (two code columns); force Unified on
	// narrow, and close the files sheet if the viewport widens back out.
	useEffect(() => {
		if (narrow && viewMode === "split") setViewMode("unified");
		if (!narrow) setFilesSheetOpen(false);
	}, [narrow, viewMode]);
	const [includeTests, setIncludeTests] = useIncludeTestsInDiff();
	// Dismiss the recent-commits preset popover on outside click or Escape.
	useEffect(() => {
		if (!recentMenuOpen) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (recentMenuRef.current?.contains(target) || recentCaretRef.current?.contains(target)) {
				return;
			}
			setRecentMenuOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setRecentMenuOpen(false);
				recentCaretRef.current?.focus();
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [recentMenuOpen]);
	const toggleFilesCollapsed = useCallback(() => {
		setFilesCollapsed((prev) => {
			const next = !prev;
			writeFilesCollapsed(next);
			return next;
		});
	}, []);
	const visibleFiles = useMemo(
		() => (payload ? (includeTests ? payload.files : payload.files.filter((f) => !isTestFile(f.displayPath))) : []),
		[payload, includeTests],
	);
	const visibleSkippedFiles = useMemo(
		() => (payload ? (includeTests ? payload.skippedFiles : payload.skippedFiles.filter((f) => !isTestFile(f.displayPath))) : []),
		[payload, includeTests],
	);
	const hiddenTestCount = payload
		? (payload.files.length - visibleFiles.length) + (payload.skippedFiles.length - visibleSkippedFiles.length)
		: 0;
	const visibleSummary = useMemo(() => {
		if (!payload) return { files: 0, insertions: 0, deletions: 0 };
		if (includeTests) return payload.summary;
		let insertions = 0;
		let deletions = 0;
		for (const file of visibleFiles) {
			const stats = getFileDiffStats(file);
			insertions += stats.insertions;
			deletions += stats.deletions;
		}
		return { files: visibleFiles.length + visibleSkippedFiles.length, insertions, deletions };
	}, [payload, includeTests, visibleFiles, visibleSkippedFiles]);
	const fileTree = payload ? buildDiffTree(visibleFiles, visibleSkippedFiles) : [];
	const reviewExportEntries = payload
		? [
			...buildInlineReviewExportEntries(visibleFiles, inlineComments),
			...buildGithubReviewExportEntries(visibleFiles, prComments?.threads ?? [], githubExportSelection),
		].sort(compareReviewExportEntries)
		: [];
	const reviewExportXml = buildInlineReviewXml(reviewExportEntries);

	const fetchPrComments = useCallback((force: boolean) => {
		if (task.prNumber == null) {
			return;
		}
		const seq = ++prFetchSeqRef.current;
		setPrCommentsRefreshing(true);
		api.request.getTaskPrComments({ taskId: task.id, projectId: project.id, force })
			.then((result) => {
				if (prFetchSeqRef.current !== seq) return;
				setPrComments(result);
				setPrCommentsError(null);
			})
			.catch((err) => {
				if (prFetchSeqRef.current !== seq) return;
				setPrCommentsError(String(err));
			})
			.finally(() => {
				if (prFetchSeqRef.current === seq) setPrCommentsRefreshing(false);
			});
	}, [project.id, task.id, task.prNumber]);

	useEffect(() => {
		setPrComments(null);
		setPrCommentsError(null);
		setGithubExportSelection({});
		setThreadSendStates({});
		fetchPrComments(false);
	}, [fetchPrComments]);

	// GitHub threads anchor onto PR-diff line numbers, which only the branch
	// mode renders; other modes surface a "view in Branch diff" hint instead.
	const githubThreadGroups = useMemo(() => {
		if (!prComments || currentRequest.mode !== "branch") {
			return null;
		}
		return groupGithubThreadsByFile(visibleFiles, prComments.threads, { showResolved: showResolvedThreads });
	}, [prComments, currentRequest.mode, visibleFiles, showResolvedThreads]);
	const searchMatches = useMemo(
		() => (payload ? buildDiffSearchMatches(visibleFiles, searchQuery) : []),
		[payload, searchQuery, visibleFiles],
	);
	const currentSearchMatch = searchMatches[activeSearchIndex] ?? null;

	// The inline review is persisted per task (readStoredReview/writeStoredReview),
	// so leaving the viewer never discards anything — close immediately without a
	// "discard review?" prompt.
	const requestClose = useCallback(() => {
		onBack();
	}, [onBack]);

	// The review used to be treated as "unsaved until copied", gating navigation
	// behind the shared unsaved-changes modal. Persistence makes the clipboard a
	// transport rather than the store, so the diff viewer is never dirty: clear any
	// guard a previous surface left on the shared ref.
	useEffect(() => {
		if (!navigationGuardRef) {
			return;
		}
		navigationGuardRef.current = null;
		return () => {
			navigationGuardRef.current = null;
		};
	}, [navigationGuardRef]);

	// Garbage-collect expired/orphaned persisted reviews across all tasks whenever a
	// diff viewer opens, so localStorage never accumulates stale review entries for
	// tasks that are never reopened (or have been deleted).
	useEffect(() => {
		pruneExpiredReviews();
	}, []);

	const isInitialRequestSyncRef = useRef(true);

	useEffect(() => {
		setCurrentRequest(applyPreferredDiffMode(request));
		// N is per-open, never persisted: every fresh diff open starts at "last commit".
		setRecentCount(DEFAULT_RECENT_COUNT);
		if (isInitialRequestSyncRef.current) {
			isInitialRequestSyncRef.current = false;
			return;
		}
		setRequestVersion((version) => version + 1);
	}, [request]);

	useEffect(() => {
		let cancelled = false;

		api.request.getGlobalSettings()
			.then((settings) => {
				if (!cancelled) {
					setViewMode(resolveDiffViewMode(settings.defaultDiffViewMode, window.screen.availWidth));
				}
			})
			.catch(() => {
				if (!cancelled) {
					setViewMode(resolveAutoDiffViewMode(window.screen.availWidth));
				}
			});

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const isMetaFind = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f";
			if (isMetaFind) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation?.();
				setIsSearchOpen(true);
				window.requestAnimationFrame(() => {
					const input = searchInputRef.current;
					if (!input) {
						return;
					}
					input.focus();
					input.select();
				});
				return;
			}

			if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) {
				return;
			}

			if (isSearchOpen) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation?.();
				if (searchQuery.trim()) {
					setSearchQuery("");
					setActiveSearchIndex(0);
				} else {
					setIsSearchOpen(false);
				}
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation?.();
			requestClose();
		};

		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, [isSearchOpen, requestClose, searchQuery]);

	useEffect(() => () => {
		if (pendingScrollFrameRef.current !== null) {
			window.cancelAnimationFrame(pendingScrollFrameRef.current);
		}
		if (pendingCommentScrollFrameRef.current !== null) {
			window.cancelAnimationFrame(pendingCommentScrollFrameRef.current);
		}
		if (pendingSearchScrollFrameRef.current !== null) {
			window.cancelAnimationFrame(pendingSearchScrollFrameRef.current);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;

		Promise.all([
			import("@git-diff-view/react"),
			import("@git-diff-view/file"),
			import("@git-diff-view/core"),
		]).then(([reactLib, fileLib, coreLib]) => {
			if (cancelled) {
				return;
			}
			// The highlighter is a shared singleton; raise its line cap so large
			// files get syntax-highlighted instead of falling back to plain text.
			coreLib.highlighter.setMaxLineToIgnoreSyntax(SYNTAX_HIGHLIGHT_MAX_LINES);
			setDiffLib({
				DiffView: reactLib.DiffView,
				DiffFile: reactLib.DiffFile,
				DiffModeEnum: reactLib.DiffModeEnum,
				SplitSide: reactLib.SplitSide,
				generateDiffFile: fileLib.generateDiffFile,
			});
		}).catch((err) => {
			if (cancelled) {
				return;
			}
			setError(String(err));
			setLoading(false);
		});

		return () => {
			cancelled = true;
		};
	}, []);

	const isBusy = loading || !diffLib || !viewMode;

	useEffect(() => {
		if (!isBusy) {
			setShowLoadingState(false);
			return;
		}

		const timer = window.setTimeout(() => setShowLoadingState(true), 300);
		return () => window.clearTimeout(timer);
	}, [isBusy]);

	useEffect(() => {
		let cancelled = false;

		setLoading(true);
		setError(null);
		setPayload(null);

		api.request.getTaskDiff({
			taskId: task.id,
			projectId: project.id,
			mode: currentRequest.mode,
			compareRef: currentRequest.compareRef,
			compareLabel: currentRequest.compareLabel,
			count: currentRequest.mode === "recent" ? recentCount : undefined,
		}).then((result) => {
			if (cancelled) {
				return;
			}
			setPayload(sortTaskDiffResponse(result));
			setLoading(false);
		}).catch((err) => {
			if (cancelled) {
				return;
			}
			setError(String(err));
			setLoading(false);
		});

		return () => {
			cancelled = true;
		};
	}, [currentRequest.compareLabel, currentRequest.compareRef, currentRequest.mode, recentCount, project.id, requestVersion, task.id]);

	useEffect(() => {
		if (!payload) {
			setCollapsedFolders({});
			setExpandedFiles({});
			setReadFiles({});
			setActiveFileId(null);
			setInlineComments({});
			setEditingCommentId(null);
			setEditingCommentDraft("");
			return;
		}

		const storedReadState = readStoredReadState();
		const nextReadFiles: Record<string, boolean> = Object.fromEntries(
			payload.files.map((file) => [file.id, !!storedReadState[getFileReadSignature(task.id, file)]]),
		);
		for (const skipped of payload.skippedFiles) {
			nextReadFiles[skipped.id] = !!storedReadState[getSkippedFileReadSignature(task.id, skipped)];
		}
		const nextExpandedFiles = Object.fromEntries(
			payload.files.map((file) => [file.id, !nextReadFiles[file.id]]),
		);
		const focusedFile = currentRequest.focusFile ? findDiffFileByPath(payload.files, currentRequest.focusFile) : null;
		const initialActiveFileId = focusedFile?.id ?? payload.files[0]?.id ?? null;
		setCollapsedFolders({});
		setExpandedFiles(nextExpandedFiles);
		setReadFiles(nextReadFiles);
		setActiveFileId(initialActiveFileId);
		// Restore the persisted review for this task instead of wiping it — comments
		// must survive diff reloads (e.g. a refresh after the agent edits files).
		setInlineComments(readStoredReview(task.id));
		setEditingCommentId(null);
		setEditingCommentDraft("");
	}, [currentRequest.focusFile, payload, task.id]);

	// Tracks the task.id that inlineComments currently belongs to.
	// Updated in the persist effect whenever task.id changes, so we can detect
	// the intermediate render where task.id has advanced but inlineComments still
	// holds the previous task's data (e.g. the user clicked a different task card
	// in the kanban while the diff viewer was open — useTaskInlineDiffState resets
	// inlineDiffRequest to null one render later, but the persist effect fires in
	// that intermediate render and must not cross-contaminate storage).
	const inlineCommentsOwnerRef = useRef(task.id);

	// Persist the review on every change. Gated on `payload` so the transient
	// in-memory clear during a diff (re)load does not erase the stored review.
	// Also gated on the task.id matching the owner ref: if they diverge, task.id
	// has just changed and inlineComments still contains the previous task's data,
	// so we must skip the write.
	useEffect(() => {
		if (!payload || inlineCommentsOwnerRef.current !== task.id) {
			inlineCommentsOwnerRef.current = task.id;
			return;
		}
		writeStoredReview(task.id, inlineComments);
	}, [inlineComments, payload, task.id]);

	function addInlineComment({
		fileId,
		side,
		startLine,
		endLine,
		body,
	}: {
		fileId: string;
		side: InlineCommentSideKey;
		startLine: number;
		endLine: number;
		body: string;
	}) {
		const trimmedBody = body.trim();
		if (!trimmedBody) {
			return;
		}

		const lo = Math.min(startLine, endLine);
		const hi = Math.max(startLine, endLine);
		// Threads are keyed by the anchor (end) line, where the widget/composer renders.
		const anchorLine = hi;

		setInlineComments((current) => {
			const fileComments = current[fileId] ?? createEmptyInlineCommentFileData();
			const sideComments = fileComments[side];
			const existingThread = sideComments[anchorLine]?.data;
			const nextComment: InlineDiffComment = {
				id: `${fileId}:${side}:${lo === hi ? lo : `${lo}-${hi}`}:${Date.now().toString(36)}`,
				body: trimmedBody,
				createdAt: new Date().toISOString(),
				startLine: lo,
				endLine: hi,
				side,
			};
			return {
				...current,
				[fileId]: {
					...fileComments,
					[side]: {
						...sideComments,
						[anchorLine]: {
							data: {
								comments: [...(existingThread?.comments ?? []), nextComment],
							},
						},
					},
				},
			};
		});
	}

	function toggleThreadExport(threadId: string) {
		setGithubExportSelection((current) => ({ ...current, [threadId]: !current[threadId] }));
	}

	function sendThreadToAgent(thread: PRReviewThread) {
		const prompt = buildThreadFixPrompt(thread, locateThread(visibleFiles, thread));
		setThreadSendStates((current) => ({ ...current, [thread.id]: "sending" }));
		api.request.sendAgentMessageNow({ taskId: task.id, projectId: project.id, text: prompt })
			.then(() => {
				setThreadSendStates((current) => ({ ...current, [thread.id]: "sent" }));
				toast.success(t("infoPanel.prSendToAgentSuccess"));
			})
			.catch((err) => {
				setThreadSendStates((current) => ({ ...current, [thread.id]: undefined }));
				toast.error(t("infoPanel.prSendToAgentFailed", { error: String(err) }));
			});
	}

	function handleCopyReviewXml() {
		const snapshot = reviewExportXml;
		navigator.clipboard.writeText(snapshot).then(() => {
			setCopiedReviewXml(true);
			window.setTimeout(() => setCopiedReviewXml(false), 1500);
		}).catch(() => {});
	}

	function handleResetReview() {
		confirm({
			title: t("infoPanel.diffReviewResetConfirmTitle"),
			message: t("infoPanel.diffReviewResetConfirmMessage"),
			danger: true,
		})
			.then((confirmed) => {
				if (!confirmed) {
					return;
				}
				setInlineComments({});
				setEditingCommentId(null);
				setEditingCommentDraft("");
			})
			.catch(() => {});
	}

	function registerCommentRef(commentId: string, element: HTMLDivElement | null) {
		commentRefs.current[commentId] = element;
	}

	useEffect(() => {
		if (!payload || !currentRequest.focusFile) {
			return;
		}
		const targetFile = findDiffFileByPath(payload.files, currentRequest.focusFile);
		if (!targetFile) {
			return;
		}
		setExpandedFiles((current) => ({
			...current,
			[targetFile.id]: true,
		}));
		setActiveFileId(targetFile.id);
		scrollToFile(targetFile.id, { behavior: "smooth", retries: 4 });
	}, [currentRequest.focusFile, payload]);

	useEffect(() => {
		setCopiedReviewXml(false);
	}, [reviewExportXml]);

	useEffect(() => {
		if (!searchQuery.trim()) {
			setActiveSearchIndex(0);
			cancelPendingSearchScroll();
			return;
		}
		if (searchMatches.length === 0) {
			setActiveSearchIndex(0);
			cancelPendingSearchScroll();
			return;
		}
		activateSearchMatch(0);
		// Search should jump to the first match whenever the query changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchMatches, searchQuery]);

	useEffect(() => {
		const root = scrollRegionRef.current;
		clearDiffSearchDecorations(root);
		if (!root || !searchQuery.trim()) {
			return;
		}

		const currentElement = currentSearchMatch ? findSearchMatchElement(currentSearchMatch) : null;
		const containers = Array.from(root.querySelectorAll<HTMLElement>(
			".diff-line-content, .diff-line-old-content, .diff-line-new-content, .diff-line-hunk-content, [data-testid='mock-search-line-content']",
		));

		for (const container of containers) {
			const targetLine = container.closest<HTMLElement>("[data-line], tr, .diff-line");
			if (!targetLine || !lineContainsQuery(container, searchQuery)) {
				continue;
			}
			targetLine.classList.add("dev3-diff-search-match-line");
		}

		if (currentElement) {
			currentElement.classList.add("dev3-diff-search-current-line");
		}

		return () => clearDiffSearchDecorations(root);
	}, [currentSearchMatch, searchQuery, expandedFiles]);

	function getScrollOffset(fileId: string): number | null {
		const scrollRegion = scrollRegionRef.current;
		const section = sectionRefs.current[fileId];
		if (!scrollRegion || !section) {
			return null;
		}
		const scrollRegionRect = scrollRegion.getBoundingClientRect();
		const sectionRect = section.getBoundingClientRect();
		const toolbarHeight = toolbarRef.current?.getBoundingClientRect().height ?? 0;
		return sectionRect.top - scrollRegionRect.top - toolbarHeight - 8;
	}

	function cancelPendingScroll() {
		if (pendingScrollFrameRef.current !== null) {
			window.cancelAnimationFrame(pendingScrollFrameRef.current);
			pendingScrollFrameRef.current = null;
		}
	}

	function cancelPendingCommentScroll() {
		if (pendingCommentScrollFrameRef.current !== null) {
			window.cancelAnimationFrame(pendingCommentScrollFrameRef.current);
			pendingCommentScrollFrameRef.current = null;
		}
	}

	function cancelPendingSearchScroll() {
		if (pendingSearchScrollFrameRef.current !== null) {
			window.cancelAnimationFrame(pendingSearchScrollFrameRef.current);
			pendingSearchScrollFrameRef.current = null;
		}
	}

	function alignFileScroll(
		fileId: string,
		behavior: ScrollBehavior,
		retriesLeft: number,
		onSettled?: () => void,
	) {
		const scrollRegion = scrollRegionRef.current;
		const offset = getScrollOffset(fileId);
		if (!scrollRegion || offset === null) {
			pendingScrollFrameRef.current = null;
			onSettled?.();
			return;
		}

		if (Math.abs(offset) <= 4) {
			pendingScrollFrameRef.current = null;
			onSettled?.();
			return;
		}

		scrollRegion.scrollTo({
			top: Math.max(0, scrollRegion.scrollTop + offset),
			behavior,
		});

		if (retriesLeft <= 0) {
			pendingScrollFrameRef.current = null;
			onSettled?.();
			return;
		}

		pendingScrollFrameRef.current = window.requestAnimationFrame(() => {
			alignFileScroll(fileId, "auto", retriesLeft - 1, onSettled);
		});
	}

	function scrollToFile(
		fileId: string,
		options?: { expand?: boolean; behavior?: ScrollBehavior; retries?: number; onSettled?: () => void },
	) {
		cancelPendingScroll();
		if (options?.expand) {
			setExpandedFiles((current) => ({
				...current,
				[fileId]: true,
			}));
		}
		setActiveFileId(fileId);
		const behavior = options?.behavior ?? "smooth";
		const retries = options?.retries ?? 3;
		const onSettled = options?.onSettled;
		pendingScrollFrameRef.current = window.requestAnimationFrame(() => {
			alignFileScroll(fileId, behavior, retries, onSettled);
		});
	}

	function scrollToComment(commentId: string, fileId: string) {
		cancelPendingCommentScroll();
		const startCommentScroll = () => {
			let attemptsLeft = 10;
			const tryScroll = () => {
				const element = commentRefs.current[commentId];
				if (element) {
					element.scrollIntoView({
						behavior: "smooth",
						block: "start",
					});
					pendingCommentScrollFrameRef.current = null;
					return;
				}
				attemptsLeft -= 1;
				if (attemptsLeft <= 0) {
					pendingCommentScrollFrameRef.current = null;
					return;
				}
				pendingCommentScrollFrameRef.current = window.requestAnimationFrame(tryScroll);
			};
			pendingCommentScrollFrameRef.current = window.requestAnimationFrame(tryScroll);
		};
		scrollToFile(fileId, {
			expand: true,
			behavior: "smooth",
			retries: 4,
			onSettled: startCommentScroll,
		});
	}

	function findSearchMatchElement(match: DiffSearchMatch): HTMLElement | null {
		const section = sectionRefs.current[match.fileId];
		if (!section || match.kind !== "content") {
			return null;
		}

		const query = match.text.toLocaleLowerCase();
		const candidates = Array.from(section.querySelectorAll<HTMLElement>(
			".diff-line-content, .diff-line-old-content, .diff-line-new-content, .diff-line-hunk-content, [data-testid='mock-search-line-content']",
		)).filter((element) => (
			(element.textContent ?? "").toLocaleLowerCase().includes(query)
		));
		if (candidates.length === 0) {
			return null;
		}

		const lineSpecificCandidate = match.lineNumber === null
			? null
			: candidates.find((element) => {
				const lineRoot = element.closest<HTMLElement>("[data-line], tr, .diff-line");
				return (lineRoot?.textContent ?? "").includes(String(match.lineNumber));
			});
		const target = lineSpecificCandidate ?? candidates[0];
		return target.closest<HTMLElement>("[data-line], tr, .diff-line") ?? target;
	}

	function queueSearchMatchScroll(match: DiffSearchMatch) {
		cancelPendingSearchScroll();
		let attemptsLeft = 12;
		const tryScroll = () => {
			const element = findSearchMatchElement(match);
			if (element) {
				element.scrollIntoView({
					behavior: "smooth",
					block: "center",
				});
				pendingSearchScrollFrameRef.current = null;
				return;
			}
			attemptsLeft -= 1;
			if (attemptsLeft <= 0) {
				pendingSearchScrollFrameRef.current = null;
				return;
			}
			pendingSearchScrollFrameRef.current = window.requestAnimationFrame(tryScroll);
		};
		pendingSearchScrollFrameRef.current = window.requestAnimationFrame(tryScroll);
	}

	function activateSearchMatch(index: number) {
		if (searchMatches.length === 0) {
			return;
		}
		const nextIndex = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
		setActiveSearchIndex(nextIndex);
		const match = searchMatches[nextIndex];
		if (!match) {
			return;
		}
		scrollToFile(match.fileId, {
			expand: true,
			behavior: "smooth",
			retries: 4,
			onSettled: () => {
				if (match.kind === "content") {
					queueSearchMatchScroll(match);
				}
			},
		});
	}

	function stepSearchMatch(direction: -1 | 1) {
		if (searchMatches.length === 0) {
			return;
		}
		activateSearchMatch(activeSearchIndex + direction);
	}

	function startEditingComment(commentId: string, body: string) {
		setEditingCommentId(commentId);
		setEditingCommentDraft(body);
		setCopiedReviewXml(false);
	}

	function cancelEditingComment() {
		setEditingCommentId(null);
		setEditingCommentDraft("");
	}

	function updateInlineComment(commentId: string, body: string) {
		const trimmedBody = body.trim();
		if (!trimmedBody) {
			return;
		}

		setInlineComments((current) => {
			const nextState: InlineDiffCommentsState = {};
			for (const [fileId, fileComments] of Object.entries(current)) {
				nextState[fileId] = {
					oldFile: Object.fromEntries(
						Object.entries(fileComments.oldFile).map(([lineNumber, thread]) => [
							lineNumber,
							{
								data: {
									comments: thread.data.comments.map((comment) => (
										comment.id === commentId
											? { ...comment, body: trimmedBody }
											: comment
									)),
								},
							},
						]),
					),
					newFile: Object.fromEntries(
						Object.entries(fileComments.newFile).map(([lineNumber, thread]) => [
							lineNumber,
							{
								data: {
									comments: thread.data.comments.map((comment) => (
										comment.id === commentId
											? { ...comment, body: trimmedBody }
											: comment
									)),
								},
							},
						]),
					),
				};
			}
			return nextState;
		});
		cancelEditingComment();
	}

	function deleteInlineComment(commentId: string) {
		setInlineComments((current) => {
			const nextState: InlineDiffCommentsState = {};
			for (const [fileId, fileComments] of Object.entries(current)) {
				const nextFileComments = {
					oldFile: {} as InlineDiffCommentFileData["oldFile"],
					newFile: {} as InlineDiffCommentFileData["newFile"],
				};
				for (const side of ["oldFile", "newFile"] as const) {
					for (const [lineNumber, thread] of Object.entries(fileComments[side])) {
						const remainingComments = thread.data.comments.filter((comment) => comment.id !== commentId);
						if (remainingComments.length > 0) {
							nextFileComments[side][lineNumber] = {
								data: {
									comments: remainingComments,
								},
							};
						}
					}
				}
				if (Object.keys(nextFileComments.oldFile).length > 0 || Object.keys(nextFileComments.newFile).length > 0) {
					nextState[fileId] = nextFileComments;
				}
			}
			return nextState;
		});
		cancelEditingComment();
	}

	function collapseFilePreservingStickyAnchor(fileId: string) {
		const offset = getScrollOffset(fileId);
		const finishCollapse = () => {
			setExpandedFiles((current) => ({
				...current,
				[fileId]: false,
			}));
		};

		if (offset === null || offset >= -4) {
			finishCollapse();
			return;
		}

		cancelPendingScroll();
		setActiveFileId(fileId);
		pendingScrollFrameRef.current = window.requestAnimationFrame(() => {
			alignFileScroll(fileId, "auto", 3, finishCollapse);
		});
	}

	function toggleFolderCollapsed(folderKey: string) {
		setCollapsedFolders((current) => ({
			...current,
			[folderKey]: !(current[folderKey] ?? false),
		}));
	}

	function toggleFileExpanded(fileId: string) {
		const currentlyExpanded = expandedFiles[fileId] ?? true;
		if (currentlyExpanded) {
			collapseFilePreservingStickyAnchor(fileId);
			return;
		}
		setExpandedFiles((current) => ({
			...current,
			[fileId]: true,
		}));
	}

	function toggleFileRead(fileId: string) {
		if (!payload) {
			return;
		}
		const targetFile = payload.files.find((file) => file.id === fileId);
		const targetSkipped = targetFile ? null : payload.skippedFiles.find((s) => s.id === fileId);
		if (!targetFile && !targetSkipped) {
			return;
		}
		const signature = targetFile
			? getFileReadSignature(task.id, targetFile)
			: getSkippedFileReadSignature(task.id, targetSkipped!);
		const nextRead = !(readFiles[fileId] ?? false);
		const storedReadState = readStoredReadState();
		if (nextRead) {
			storedReadState[signature] = true;
		} else {
			delete storedReadState[signature];
		}
		writeStoredReadState(storedReadState);
		setReadFiles((current) => ({
			...current,
			[fileId]: nextRead,
		}));
		if (targetSkipped) {
			return;
		}
		if (nextRead) {
			collapseFilePreservingStickyAnchor(fileId);
			return;
		}
		setExpandedFiles((expanded) => ({
			...expanded,
			[fileId]: true,
		}));
	}

	function setAllFilesExpanded(nextExpanded: boolean) {
		if (!payload) {
			return;
		}
		setExpandedFiles((prev) => ({
			...prev,
			...Object.fromEntries(visibleFiles.map((file) => [file.id, nextExpanded])),
		}));
	}

	function setAllFilesRead(nextRead: boolean) {
		if (!payload) {
			return;
		}
		const storedReadState = readStoredReadState();
		for (const file of payload.files) {
			const signature = getFileReadSignature(task.id, file);
			if (nextRead) {
				storedReadState[signature] = true;
			} else {
				delete storedReadState[signature];
			}
		}
		for (const skipped of payload.skippedFiles) {
			const signature = getSkippedFileReadSignature(task.id, skipped);
			if (nextRead) {
				storedReadState[signature] = true;
			} else {
				delete storedReadState[signature];
			}
		}
		writeStoredReadState(storedReadState);
		setReadFiles((prev) => {
			const next = { ...prev };
			for (const file of payload.files) {
				next[file.id] = nextRead;
			}
			for (const skipped of payload.skippedFiles) {
				next[skipped.id] = nextRead;
			}
			return next;
		});
		setExpandedFiles((prev) => ({
			...prev,
			...Object.fromEntries(visibleFiles.map((file) => [file.id, nextRead ? false : true])),
		}));
	}

	const totalFileCount = payload ? visibleFiles.length + visibleSkippedFiles.length : 0;
	const readCount = payload
		? [...visibleFiles, ...visibleSkippedFiles].filter((f) => readFiles[f.id]).length
		: 0;
	const allFilesExpanded = payload ? visibleFiles.every((file) => expandedFiles[file.id] ?? true) : false;
	const allFilesRead = payload
		? totalFileCount > 0
			&& visibleFiles.every((file) => readFiles[file.id] ?? false)
			&& visibleSkippedFiles.every((skipped) => readFiles[skipped.id] ?? false)
		: false;
	const hasSearchQuery = searchQuery.trim().length > 0;
	const searchStatusLabel = hasSearchQuery
		? (searchMatches.length > 0 ? `${activeSearchIndex + 1} / ${searchMatches.length}` : t("infoPanel.diffSearchNoMatches"))
		: null;

	function renderFileTreeNode(node: DiffTreeNode, depth = 0, onFileClick?: () => void): ReactElement {
		if (node.type === "folder") {
			const collapsed = collapsedFolders[node.key] ?? false;
			const isCurrentPathMatch = currentSearchMatch?.kind === "path" && currentSearchMatch.filePath === node.path;
			return (
				<div key={node.key}>
					<button
						onClick={() => toggleFolderCollapsed(node.key)}
						aria-label={collapsed
							? t("infoPanel.diffExpandFolder", { folder: node.path })
							: t("infoPanel.diffCollapseFolder", { folder: node.path })}
						className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm text-fg-2 hover:bg-elevated-hover transition-colors"
						style={{ paddingLeft: `${depth * 0.55 + 0.35}rem` }}
					>
						<span className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-[1.05rem] leading-none text-fg-muted">
							{collapsed ? "\u25B8" : "\u25BE"}
						</span>
						<span className="text-[1rem] leading-none text-fg-muted" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{"\uF07B"}
						</span>
						<span className={`min-w-0 truncate font-medium${isCurrentPathMatch ? " dev3-diff-search-current-hit" : ""}`}>
							{renderHighlightedText(node.name, searchQuery, isCurrentPathMatch)}
						</span>
					</button>
					{!collapsed && (
						<div>
							{node.children.map((child) => renderFileTreeNode(child, depth + 1, onFileClick))}
						</div>
					)}
				</div>
			);
		}

		const isRead = readFiles[node.fileId] ?? false;
		const isActive = activeFileId === node.fileId;
		const isSkipped = node.skipped !== undefined;
		const isCurrentPathMatch = currentSearchMatch?.kind === "path" && currentSearchMatch.fileId === node.fileId;
		return (
			<button
				key={node.key}
				onClick={() => { scrollToFile(node.fileId, { expand: true }); onFileClick?.(); }}
				aria-label={t("infoPanel.diffOpenFile", { file: node.path })}
				className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm transition-colors ${
					isActive
						? "bg-accent/15 text-fg border border-accent/30"
						: "text-fg-2 hover:bg-elevated-hover border border-transparent"
				}`}
				style={{ paddingLeft: `${depth * 0.55 + 1.15}rem` }}
			>
				<span className={`inline-flex items-center justify-center min-w-[1.1rem] rounded border px-1 py-0.5 text-[0.6rem] font-bold ${statusClassName(node.status)}`}>
					{statusLabel(node.status)}
				</span>
				<span className={`min-w-0 truncate font-mono ${isRead ? "text-fg-muted line-through decoration-1" : ""} ${isSkipped ? "italic" : ""}${isCurrentPathMatch ? " dev3-diff-search-current-hit" : ""}`}>
					{renderHighlightedText(node.name, searchQuery, isCurrentPathMatch)}
				</span>
				{isSkipped && (
					<span
						aria-hidden="true"
						className="ml-auto shrink-0 text-[0.95rem] leading-none text-fg-muted"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						title={node.skipped === "binary"
							? t("infoPanel.diffSkippedReasonBinary")
							: t("infoPanel.diffSkippedReasonLarge")}
					>
						{"\u{F0219}"}
					</span>
				)}
			</button>
		);
	}

	function switchDiffMode(mode: TaskInlineDiffRequest["mode"]) {
		setRecentMenuOpen(false);
		if (mode === currentRequest.mode) {
			return;
		}
		writePreferredDiffMode(mode);
		// `uncommitted` and `recent` derive their comparison entirely from HEAD /
		// the working tree, so they must not carry over a stale compareRef/label.
		if (mode === "uncommitted" || mode === "recent") {
			setCurrentRequest({
				mode,
				focusFile: currentRequest.focusFile,
			});
			return;
		}
		setCurrentRequest({
			mode,
			compareRef: request.compareRef,
			compareLabel: request.compareLabel,
			focusFile: currentRequest.focusFile,
		});
	}

	// Pick a preset from the ▾ popover: set N and activate recent mode in one action.
	function selectRecentCount(count: number) {
		writePreferredDiffMode("recent");
		setRecentCount(count);
		setRecentMenuOpen(false);
		if (currentRequest.mode !== "recent") {
			setCurrentRequest({ mode: "recent", focusFile: currentRequest.focusFile });
		}
		recentCaretRef.current?.focus();
	}

	function renderToolbarButton(label: string, active: boolean, onClick: () => void, padClass = "py-0.5") {
		return (
			<button
				onClick={onClick}
				className={`px-2.5 ${padClass} rounded-md border text-[0.6875rem] font-semibold transition-colors ${
					active
						? "bg-accent text-white border-accent"
						: "bg-raised text-fg-2 border-edge hover:bg-elevated-hover"
				}`}
			>
				{label}
			</button>
		);
	}

	// ---- Toolbar pieces shared between the desktop row and the narrow layout ----

	const diffSubtitleLabel = currentRequest.mode === "uncommitted"
		? t("infoPanel.diffWorkingTreeBase")
		: currentRequest.mode === "recent"
			? (payload && payload.recentCount === 0
				? t("infoPanel.diffRecentNone")
				: t.plural("infoPanel.diffRecentLabel", payload?.recentCount ?? recentCount))
			: t("infoPanel.diffComparedTo", { ref: payload?.compareLabel || currentRequest.compareLabel || currentRequest.compareRef || "HEAD" });

	function renderRecentCombo(padClass = "py-0.5") {
		const recentActive = currentRequest.mode === "recent";
		return (
			<div className="relative inline-flex">
				<div
					className={`inline-flex items-stretch rounded-md border text-[0.6875rem] font-semibold transition-colors ${
						recentActive
							? "bg-accent text-white border-accent"
							: "bg-raised text-fg-2 border-edge hover:bg-elevated-hover"
					}`}
				>
					<button
						type="button"
						onClick={() => switchDiffMode("recent")}
						aria-pressed={recentActive}
						className={`px-2.5 ${padClass} rounded-l-md`}
						data-testid="diff-mode-recent"
					>
						{t.plural("infoPanel.diffRecentLabel", recentCount)}
					</button>
					<button
						ref={recentCaretRef}
						type="button"
						onClick={() => setRecentMenuOpen((open) => !open)}
						aria-label={t("infoPanel.diffRecentPresetsAria")}
						aria-haspopup="menu"
						aria-expanded={recentMenuOpen}
						title={t("infoPanel.diffRecentPresetsAria")}
						className={`flex items-center px-1.5 rounded-r-md border-l ${
							recentActive ? "border-white/30" : "border-edge"
						}`}
						data-testid="diff-mode-recent-caret"
					>
						<span className="text-[0.7rem] leading-none">{"▾"}</span>
					</button>
				</div>
				{recentMenuOpen && (
					<div
						ref={recentMenuRef}
						role="menu"
						aria-label={t("infoPanel.diffRecentPresetsAria")}
						className="absolute right-0 top-full z-20 mt-1 min-w-[9rem] rounded-md border border-edge bg-elevated py-1 shadow-lg"
						data-testid="diff-mode-recent-menu"
					>
						{RECENT_COUNT_PRESETS.map((preset) => {
							const selected = recentActive && preset === recentCount;
							return (
								<button
									key={preset}
									type="button"
									role="menuitemradio"
									aria-checked={selected}
									onClick={() => selectRecentCount(preset)}
									className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[0.6875rem] font-medium transition-colors ${
										selected ? "text-accent" : "text-fg-2 hover:bg-raised-hover"
									}`}
									data-testid={`diff-recent-preset-${preset}`}
								>
									<span>{t.plural("infoPanel.diffRecentLabel", preset)}</span>
									{selected && (
										<span aria-hidden="true" className="text-[0.75rem] leading-none">{"✓"}</span>
									)}
								</button>
							);
						})}
					</div>
				)}
			</div>
		);
	}

	function renderModeToggles(padClass = "py-0.5") {
		return (
			<>
				{renderToolbarButton(t("infoPanel.diffBranch"), currentRequest.mode === "branch", () => switchDiffMode("branch"), padClass)}
				{renderToolbarButton(t("infoPanel.uncommittedDiff"), currentRequest.mode === "uncommitted", () => switchDiffMode("uncommitted"), padClass)}
				{renderToolbarButton(t("infoPanel.unpushedDiff"), currentRequest.mode === "unpushed", () => switchDiffMode("unpushed"), padClass)}
				{renderRecentCombo(padClass)}
			</>
		);
	}

	function renderTestsToggle() {
		return (
			<label
				className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[0.6875rem] font-mono cursor-pointer transition-colors ${
					includeTests
						? "bg-raised text-fg-2 border-edge hover:bg-elevated-hover"
						: "bg-accent/10 text-accent border-accent/30 hover:bg-accent/20"
				}`}
				title={hiddenTestCount > 0 || includeTests
					? t("infoPanel.diffIncludeTestsTooltip")
					: t("infoPanel.diffIncludeTestsTooltipNoTests")}
				data-testid="diff-toolbar-include-tests"
			>
				<input
					type="checkbox"
					className="sr-only"
					checked={includeTests}
					onChange={(e) => setIncludeTests(e.target.checked)}
					aria-label={t("infoPanel.diffIncludeTestsAria")}
				/>
				<span>{includeTests ? t("infoPanel.diffIncludeTests") : t("infoPanel.diffExcludeTests")}</span>
				<span
					className="text-[0.85rem] leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F0668}"}
				</span>
			</label>
		);
	}

	function renderInfoChips() {
		if (!payload) return null;
		const binaryCount = visibleSkippedFiles.filter((f) => f.reason === "binary").length;
		const largeCount = visibleSkippedFiles.filter((f) => f.reason === "too-large").length;
		return (
			<>
				{totalFileCount !== payload.summary.files && (
					<span className="px-2 py-1 rounded-md bg-raised text-fg-3 border border-edge text-[0.6875rem]">
						{t("infoPanel.diffShownCount", {
							shown: String(totalFileCount),
							total: String(payload.summary.files),
						})}
					</span>
				)}
				{payload.fallbackReason === "no-upstream" && (
					<span className="px-2 py-1 rounded-md bg-warning/10 text-warning border border-warning/25 text-[0.6875rem]">
						{t("infoPanel.diffFallbackNoUpstream", { ref: payload.compareLabel })}
					</span>
				)}
				{binaryCount > 0 && (
					<span className="px-2 py-1 rounded-md bg-raised text-fg-3 border border-edge text-[0.6875rem]">
						{t.plural("infoPanel.diffBinaryCount", binaryCount)}
					</span>
				)}
				{largeCount > 0 && (
					<span className="px-2 py-1 rounded-md bg-raised text-fg-3 border border-edge text-[0.6875rem]">
						{t.plural("infoPanel.diffLargeCount", largeCount)}
					</span>
				)}
			</>
		);
	}

	function toggleSearchOpen() {
		if (isSearchOpen) {
			setIsSearchOpen(false);
			setSearchQuery("");
			setActiveSearchIndex(0);
			return;
		}
		setIsSearchOpen(true);
		window.requestAnimationFrame(() => {
			const input = searchInputRef.current;
			if (!input) {
				return;
			}
			input.focus();
			input.select();
		});
	}

	function renderSearchToggle(narrowSize: boolean) {
		return (
			<button
				type="button"
				onClick={toggleSearchOpen}
				aria-label={t("infoPanel.diffSearchOpen")}
				title={`${t("infoPanel.diffSearchOpen")} (⌘F)`}
				className={`inline-flex items-center justify-center rounded-md border text-[0.6875rem] font-semibold transition-colors ${
					narrowSize ? "h-9 w-9 shrink-0" : "px-2.5 py-0.5"
				} ${
					isSearchOpen
						? "border-accent bg-accent text-white"
						: "border-edge bg-raised text-fg-2 hover:bg-elevated-hover"
				}`}
			>
				<span
					aria-hidden="true"
					className="text-[0.8125rem] leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{""}
				</span>
			</button>
		);
	}

	function renderSearchBox(fullWidth: boolean) {
		return (
			<div
				className={`items-center gap-1.5 rounded-md border border-edge bg-raised px-2 py-1 ${
					fullWidth ? "flex w-full" : "inline-flex min-w-[18rem] max-w-[32rem]"
				}`}
			>
				<div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-edge bg-base px-2 focus-within:border-accent/60 transition-colors">
					<span
						aria-hidden="true"
						className="shrink-0 text-[0.8rem] leading-none text-fg-muted"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					>
						{""}
					</span>
					<input
						ref={searchInputRef}
						type="text"
						value={searchQuery}
						onChange={(event) => {
							setSearchQuery(event.target.value);
							setActiveSearchIndex(0);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								event.stopPropagation();
								stepSearchMatch(event.shiftKey ? -1 : 1);
								return;
							}
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								if (searchQuery.trim()) {
									setSearchQuery("");
									setActiveSearchIndex(0);
								} else {
									setIsSearchOpen(false);
								}
							}
						}}
						placeholder={t("infoPanel.diffSearchPlaceholder")}
						className="h-7 min-w-0 flex-1 bg-transparent text-xs font-medium text-fg outline-none placeholder:text-fg-muted"
					/>
				</div>
				{searchStatusLabel && (
					<span
						className={`inline-flex h-7 shrink-0 items-center rounded-md border px-2 text-[0.6875rem] font-mono ${
							searchMatches.length > 0
								? "border-edge bg-base text-fg-2"
								: "border-warning/25 bg-warning/10 text-warning"
						}`}
					>
						{searchStatusLabel}
					</span>
				)}
				<div className="inline-flex shrink-0 items-center gap-1">
					<button
						type="button"
						onClick={() => stepSearchMatch(-1)}
						disabled={searchMatches.length === 0}
						aria-label={t("infoPanel.diffSearchPrev")}
						title={t("infoPanel.diffSearchPrev")}
						className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-edge bg-base text-fg-2 transition-colors hover:bg-elevated-hover disabled:cursor-not-allowed disabled:text-fg-muted"
					>
						{"▲"}
					</button>
					<button
						type="button"
						onClick={() => stepSearchMatch(1)}
						disabled={searchMatches.length === 0}
						aria-label={t("infoPanel.diffSearchNext")}
						title={t("infoPanel.diffSearchNext")}
						className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-edge bg-base text-fg-2 transition-colors hover:bg-elevated-hover disabled:cursor-not-allowed disabled:text-fg-muted"
					>
						{"▼"}
					</button>
				</div>
				<button
					type="button"
					onClick={() => {
						setIsSearchOpen(false);
						setSearchQuery("");
						setActiveSearchIndex(0);
					}}
					aria-label={t("infoPanel.diffSearchClose")}
					title={t("infoPanel.diffSearchClose")}
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-edge bg-base text-fg-2 transition-colors hover:bg-elevated-hover"
				>
					{"✕"}
				</button>
			</div>
		);
	}

	function renderFilesSheetTrigger(narrowSize: boolean) {
		if (totalFileCount === 0) return null;
		return (
			<button
				type="button"
				onClick={() => setFilesSheetOpen(true)}
				data-testid="diff-files-sheet-trigger"
				className={`inline-flex items-center gap-1.5 rounded-md border border-edge bg-raised text-fg-2 text-[0.6875rem] font-semibold hover:bg-elevated-hover transition-colors ${
					narrowSize ? "h-9 shrink-0 px-2.5" : "px-2.5 py-1"
				}`}
			>
				<span aria-hidden="true" className="text-[0.85rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0645}"}</span>
				<span>{t("infoPanel.diffFiles")} ({totalFileCount})</span>
			</button>
		);
	}

	function renderState(message: string, extra?: string) {
		return (
			<div className="flex-1 min-h-0 flex items-center justify-center p-6">
				<div className="max-w-xl w-full bg-raised border border-edge rounded-xl p-6 space-y-2 text-center">
					<div className="text-[1.1rem] font-semibold text-fg">{message}</div>
					{extra && <p className="text-sm text-fg-3">{extra}</p>}
				</div>
			</div>
		);
	}

	return (
		<div
			className="h-full flex flex-col bg-base"
			data-inline-diff="true"
		>
			<div ref={toolbarRef} className="sticky top-0 z-20 border-b border-edge bg-base/95 backdrop-blur px-4 py-2" data-testid="inline-diff-toolbar">
				{narrow ? (
					<div className="flex flex-col gap-2">
						{/* Row 1: nav + identity + entry points. The full "Back to Terminal"
						    label and the summary chip would crush the title at phone width, so
						    back collapses to an icon, the \u00b1stats fold into the subtitle, and
						    the file count lives on the Files trigger. */}
						<div className="flex items-center gap-2 min-w-0">
							<button
								onClick={requestClose}
								aria-label={t("infoPanel.backToTerminal")}
								title={t("infoPanel.backToTerminal")}
								className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
							>
								<span className="text-[1.05rem] leading-none" aria-hidden="true">{"\u2190"}</span>
							</button>
							<div className="min-w-0 flex-1">
								<div className="text-sm font-semibold leading-tight text-fg">{t("infoPanel.diffViewer")}</div>
								<div className="truncate text-[0.6875rem] leading-tight text-fg-3" data-testid="diff-narrow-subtitle">
									<span>{diffSubtitleLabel}</span>
									{payload && (
										<>
											<span className="text-fg-muted">{" \u00b7 "}</span>
											<span className="text-success">+{visibleSummary.insertions}</span>
											{" "}
											<span className="text-danger">{"\u2212"}{visibleSummary.deletions}</span>
										</>
									)}
								</div>
							</div>
							{renderSearchToggle(true)}
							{renderFilesSheetTrigger(true)}
						</div>
						{/* Search gets its own full-width row while open. The mode/filter
						    row is NOT pinned here — it renders at the top of the scroll
						    region below, so it scrolls away and leaves the screen to the
						    diff (the pinned part stays one slim row). */}
						{isSearchOpen && (
							<div data-testid="diff-narrow-search-row">
								{renderSearchBox(true)}
							</div>
						)}
					</div>
				) : (
				<div className="flex flex-wrap items-center gap-2">
					<button
						onClick={requestClose}
						className="inline-flex items-center gap-2 px-3 py-1 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors text-sm font-semibold"
					>
						<span className="text-[0.95rem] leading-none">{"\u2190"}</span>
						<span>{t("infoPanel.backToTerminal")}</span>
					</button>
					<div className="min-w-0 flex-1 pr-2">
						<div className="text-sm font-semibold leading-tight text-fg">{t("infoPanel.diffViewer")}</div>
						<div className="text-[0.6875rem] leading-tight text-fg-3">
							{diffSubtitleLabel}
						</div>
					</div>
					{payload && (
						<>
							<span
								className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-raised text-fg-2 border border-edge text-[0.6875rem] font-mono"
								data-testid="diff-toolbar-summary"
							>
								<span>{t.plural("infoPanel.diffFileCount", visibleSummary.files)}</span>
								<span className="text-success">+{visibleSummary.insertions}</span>
								<span className="text-danger">−{visibleSummary.deletions}</span>
								{!includeTests && hiddenTestCount > 0 && (
									<span
										className="text-fg-muted text-[0.8rem] leading-none"
										style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
										title={t("infoPanel.diffTestsHidden", { count: String(hiddenTestCount) })}
									>
										{"\u{F0912}"}
									</span>
								)}
							</span>
							{renderTestsToggle()}
							{renderInfoChips()}
						</>
					)}
					{renderModeToggles()}
						<HelpSpot topicId="diff.modes" />
					<div className="ml-auto flex items-center gap-2">
						{renderSearchToggle(false)}
						{isSearchOpen && renderSearchBox(false)}
						{renderToolbarButton(t("infoPanel.diffUnified"), viewMode === "unified", () => setViewMode("unified"))}
						{renderToolbarButton(t("infoPanel.diffSplit"), viewMode === "split", () => setViewMode("split"))}
					</div>
				</div>
				)}
			</div>

			<div className="flex-1 min-h-0 flex overflow-hidden">
				{!narrow && !error && !isBusy && payload && totalFileCount > 0 && filesCollapsed && (
					<button
						type="button"
						onClick={toggleFilesCollapsed}
						aria-label={t("infoPanel.diffFilesExpand")}
						title={t("infoPanel.diffFilesExpand")}
						data-testid="diff-files-expand-strip"
						className="group flex w-7 shrink-0 flex-col items-center gap-2 border-r border-edge bg-raised/35 py-2 text-fg-3 transition-colors hover:bg-raised/60 hover:text-fg"
					>
						<span
							aria-hidden="true"
							className="text-[1rem] leading-none"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						>
							{"\u{F0645}"}
						</span>
						<span
							aria-hidden="true"
							className="text-[0.85rem] leading-none"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						>
							{"›"}
						</span>
						<span className="rotate-180 text-[0.625rem] font-semibold uppercase tracking-wider [writing-mode:vertical-rl]">
							{t("infoPanel.diffFiles")}
						</span>
					</button>
				)}
				{!narrow && !error && !isBusy && payload && totalFileCount > 0 && !filesCollapsed && (
					<aside className="w-[22rem] shrink-0 border-r border-edge bg-raised/35 flex flex-col min-h-0">
							<div className="shrink-0 px-3 pt-2 pb-2">
								<button
									type="button"
									onClick={toggleFilesCollapsed}
									aria-label={t("infoPanel.diffFilesCollapse")}
									title={t("infoPanel.diffFilesCollapse")}
									data-testid="diff-files-collapse-button"
									className="mb-2 inline-flex h-7 w-full items-center justify-center gap-2 rounded-md border border-edge bg-base/60 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-3 transition-colors hover:bg-elevated-hover hover:text-fg"
								>
									<span
										aria-hidden="true"
										className="text-[0.95rem] leading-none"
										style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
									>
										{"«"}
									</span>
									<span>{t("infoPanel.diffFilesCollapse")}</span>
								</button>
								<div className="space-y-2">
									<div className="rounded-lg border border-edge bg-base px-3 py-2 space-y-2">
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0 space-y-1">
												<div className="flex items-center gap-2">
													<span
														aria-hidden="true"
														className="text-[0.95rem] leading-none text-accent"
														style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
													>
														{"\u{F0198}"}
													</span>
													<span className="text-[0.6875rem] uppercase tracking-wider text-fg-muted font-semibold">
														{t("infoPanel.diffReviewExport")}
													</span>
													<HelpSpot topicId="diff.review" />
												</div>
												<p className="text-[0.6875rem] leading-snug text-fg-3">
													{reviewExportEntries.length > 0
														? t("infoPanel.diffReviewExportBody")
														: t("infoPanel.diffReviewExportEmpty")}
												</p>
										</div>
										<span className="inline-flex h-6 min-w-[2.25rem] items-center justify-center rounded-md border border-edge bg-raised px-2 text-[0.6875rem] font-mono text-fg-2">
											{reviewExportEntries.length}
										</span>
										</div>

										{reviewExportEntries.length > 0 ? (
											<div
												className="max-h-64 space-y-2 overflow-y-auto pr-1"
												data-testid="review-export-list"
											>
												{reviewExportEntries.map((entry, index) => {
													const isEditing = editingCommentId === entry.id;

													return (
														<div
															key={entry.id}
															role={isEditing ? undefined : "button"}
															tabIndex={isEditing ? undefined : 0}
															onClick={isEditing ? undefined : () => scrollToComment(entry.id, entry.fileId)}
															onKeyDown={isEditing ? undefined : (event) => {
																if (event.key !== "Enter" && event.key !== " ") {
																	return;
																}
																event.preventDefault();
																scrollToComment(entry.id, entry.fileId);
															}}
															aria-label={isEditing ? undefined : t("infoPanel.diffReviewCommentItem", { number: String(index + 1) })}
															className={`rounded-lg border px-3 py-2 space-y-2 ${
																isEditing
																	? "border-accent/40 bg-accent/10"
																	: "border-edge bg-raised/65 cursor-pointer transition-colors hover:border-accent/30 hover:bg-accent/5 focus:outline-none focus:ring-1 focus:ring-accent/40"
															}`}
														>
															<div className="flex items-center gap-1.5 text-xs font-semibold text-fg">
																<span>{t("infoPanel.diffReviewCommentItem", { number: String(index + 1) })}</span>
																{entry.origin === "github" && (
																	<span className="inline-flex items-center gap-1 rounded border border-edge bg-base px-1 py-px text-[0.625rem] font-semibold text-fg-3" data-testid="review-export-github-marker">
																		<span
																			aria-hidden="true"
																			className="text-[0.7rem] leading-none"
																			style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
																		>
																			{""}
																		</span>
																		<span>{entry.author ?? "GitHub"}</span>
																	</span>
																)}
															</div>

															<div className="rounded-md border border-edge bg-base/75 px-2.5 py-2 text-sm leading-snug text-fg whitespace-normal break-words">
																{getReviewCommentPreview(entry.comment)}
															</div>
														</div>
													);
												})}
											</div>
										) : (
											<div className="rounded-lg border border-dashed border-edge bg-raised/35 px-3 py-2 text-[0.6875rem] leading-snug text-fg-3">
												{t("infoPanel.diffReviewExportHint")}
											</div>
										)}
										<button
											onClick={handleCopyReviewXml}
											disabled={reviewExportEntries.length === 0}
											className={`inline-flex h-8 w-full items-center justify-center gap-2 rounded-md border px-3 text-xs font-semibold transition-colors ${
												copiedReviewXml
													? "border-success/40 bg-success/15 text-success"
													: "border-accent bg-accent text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:border-edge disabled:bg-base disabled:text-fg-muted"
											}`}
										>
											<span
												aria-hidden="true"
												className="text-[0.95rem] leading-none"
												style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
											>
												{"\u{F0198}"}
											</span>
											<span>{copiedReviewXml ? t("infoPanel.diffReviewExportCopied") : t("infoPanel.diffReviewExportCopy")}</span>
										</button>
										{reviewExportEntries.length > 0 && (
											<button
												type="button"
												onClick={handleResetReview}
												data-testid="review-reset-button"
												className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-md border border-danger/30 bg-transparent px-3 text-xs font-semibold text-danger transition-colors hover:bg-danger/10"
											>
												<span
													aria-hidden="true"
													className="text-[0.95rem] leading-none"
													style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
												>
													{""}
												</span>
												<span>{t("infoPanel.diffReviewReset")}</span>
											</button>
										)}
									</div>

									<div className="rounded-lg border border-edge bg-base px-3 py-2 space-y-1.5">
									<div className="flex items-center justify-between gap-2 px-1">
										<span className="text-[0.6875rem] uppercase tracking-wider text-fg-muted font-semibold">
											{t("infoPanel.diffFiles")}
										</span>
										<span className="text-[0.6875rem] text-fg-3 font-mono">
											{readCount}/{totalFileCount} {t("infoPanel.diffRead")}
										</span>
									</div>
									<div className="grid grid-cols-2 gap-2">
										<button
											onClick={() => setAllFilesExpanded(!allFilesExpanded)}
											className="inline-flex h-7 items-center justify-center rounded-md border border-edge bg-base px-2 text-[0.625rem] font-medium text-fg-2 transition-colors hover:bg-elevated-hover"
										>
											{allFilesExpanded ? t("infoPanel.diffCollapseAll") : t("infoPanel.diffExpandAll")}
										</button>
										<button
											onClick={() => setAllFilesRead(!allFilesRead)}
											className="inline-flex h-7 items-center justify-center rounded-md border border-edge bg-base px-2 text-[0.625rem] font-medium text-fg-2 transition-colors hover:bg-elevated-hover"
										>
											{allFilesRead ? t("infoPanel.diffMarkAllUnread") : t("infoPanel.diffMarkAllRead")}
										</button>
									</div>
								</div>
								</div>
							</div>
							<div className="flex-1 min-h-0 overflow-auto px-3 pb-2">
								<div className="space-y-1">
									{fileTree.map((node) => renderFileTreeNode(node))}
								</div>
							</div>
					</aside>
				)}

				{narrow && !error && !isBusy && payload && totalFileCount > 0 && (
					<BottomSheet
						open={filesSheetOpen}
						onClose={() => setFilesSheetOpen(false)}
						title={t("infoPanel.diffFiles")}
						testId="diff-files-sheet"
					>
						<div className="mb-2 flex items-center justify-end px-1">
							<span className="text-[0.6875rem] text-fg-3 font-mono">
								{readCount}/{totalFileCount} {t("infoPanel.diffRead")}
							</span>
						</div>
						<div className="mb-3 grid grid-cols-2 gap-2">
							<button
								onClick={() => setAllFilesExpanded(!allFilesExpanded)}
								className="inline-flex h-9 items-center justify-center rounded-md border border-edge bg-base px-2 text-xs font-medium text-fg-2 transition-colors hover:bg-elevated-hover"
							>
								{allFilesExpanded ? t("infoPanel.diffCollapseAll") : t("infoPanel.diffExpandAll")}
							</button>
							<button
								onClick={() => setAllFilesRead(!allFilesRead)}
								className="inline-flex h-9 items-center justify-center rounded-md border border-edge bg-base px-2 text-xs font-medium text-fg-2 transition-colors hover:bg-elevated-hover"
							>
								{allFilesRead ? t("infoPanel.diffMarkAllUnread") : t("infoPanel.diffMarkAllRead")}
							</button>
						</div>
						<div className="space-y-1">
							{fileTree.map((node) => renderFileTreeNode(node, 0, () => setFilesSheetOpen(false)))}
						</div>
					</BottomSheet>
				)}

				<div ref={scrollRegionRef} className="flex-1 min-w-0 overflow-auto px-4 pt-1 pb-4" data-testid="inline-diff-scroll-region">
				{narrow && (
					<div className="flex flex-wrap items-center gap-1.5 pb-2 pt-1">
						{renderModeToggles("py-1.5")}
						{payload && renderTestsToggle()}
						{renderInfoChips()}
						<HelpSpot topicId="diff.modes" />
					</div>
				)}
				{error && renderState(t("infoPanel.diffLoadFailed"), error)}

				{!error && isBusy && showLoadingState && (
					<div className="space-y-4">
						{Array.from({ length: 3 }).map((_, index) => (
							<div key={index} className="border border-edge rounded-xl bg-raised p-4 space-y-3 animate-pulse">
								<div className="h-4 w-40 rounded bg-elevated" />
								<div className="h-28 rounded bg-base" />
							</div>
						))}
					</div>
				)}

				{!error && !isBusy && payload && visibleFiles.length === 0 && visibleSkippedFiles.length === 0 && hiddenTestCount > 0 && (
					<div
						className="flex-1 min-h-0 flex items-center justify-center p-6"
						data-testid="diff-only-tests-empty-state"
					>
						<div className="max-w-xl w-full bg-raised border border-edge rounded-xl p-6 space-y-3 text-center">
							<div className="text-[1.1rem] font-semibold text-fg">
								{t("infoPanel.diffOnlyTestsTitle")}
							</div>
							<p className="text-sm text-fg-3">
								{t.plural("infoPanel.diffOnlyTestsBody", hiddenTestCount)}
							</p>
							<button
								type="button"
								onClick={() => setIncludeTests(true)}
								className="inline-flex h-8 items-center justify-center rounded-md border border-accent/30 bg-accent/10 px-3 text-xs font-semibold text-accent transition-colors hover:bg-accent/20"
								data-testid="diff-only-tests-enable-button"
							>
								{t("infoPanel.diffOnlyTestsEnable")}
							</button>
						</div>
					</div>
				)}

				{!error && !isBusy && payload && visibleFiles.length === 0 && visibleSkippedFiles.length === 0 && hiddenTestCount === 0 && renderState(
					t("infoPanel.diffNoChanges"),
					t("infoPanel.diffNoChangesBody"),
				)}

				{!error && !isBusy && payload && (
					<PrConversationBlock
						payload={prComments}
						refreshing={prCommentsRefreshing}
						error={prCommentsError}
						onRefresh={() => fetchPrComments(true)}
						showResolved={showResolvedThreads}
						onToggleShowResolved={() => setShowResolvedThreads((current) => !current)}
						unmappedThreads={githubThreadGroups?.unmapped ?? []}
						threadActions={{
							exportSelection: githubExportSelection,
							onToggleExport: toggleThreadExport,
							onSendToAgent: sendThreadToAgent,
							sendStates: threadSendStates,
							registerRef: registerCommentRef,
						}}
						diffMode={currentRequest.mode}
						onSwitchToBranchDiff={() => switchDiffMode("branch")}
					/>
				)}

				{!error && !isBusy && payload && diffLib && viewMode && visibleFiles.length > 0 && (
					<div className="space-y-5">
						{visibleFiles.map((file, index) => (
							<TaskDiffFileSection
								key={file.id}
								file={file}
								worktreePath={task.worktreePath}
								diffLib={diffLib}
								resolvedTheme={resolvedTheme}
								viewMode={viewMode}
								narrow={narrow}
								searchQuery={searchQuery}
								isCurrentPathMatch={currentSearchMatch?.kind === "path" && currentSearchMatch.fileId === file.id}
								comments={inlineComments[file.id] ?? createEmptyInlineCommentFileData()}
								eager={index < EAGER_FILE_COUNT}
								expanded={expandedFiles[file.id] ?? true}
								isRead={readFiles[file.id] ?? false}
								onAddComment={addInlineComment}
								editingCommentId={editingCommentId}
								editingCommentDraft={editingCommentDraft}
								onEditDraftChange={setEditingCommentDraft}
								onStartEditComment={startEditingComment}
								onCancelEditComment={cancelEditingComment}
								onSaveEditComment={updateInlineComment}
								onDeleteComment={deleteInlineComment}
								onToggleExpanded={() => toggleFileExpanded(file.id)}
								onToggleRead={() => toggleFileRead(file.id)}
								registerCommentRef={registerCommentRef}
								sectionRef={(element) => {
									sectionRefs.current[file.id] = element;
								}}
								githubThreads={githubThreadGroups?.byFile[file.id]}
								githubExportSelection={githubExportSelection}
								onToggleThreadExport={toggleThreadExport}
								onSendThreadToAgent={sendThreadToAgent}
								threadSendStates={threadSendStates}
							/>
						))}
					</div>
				)}

				{!error && !isBusy && payload && visibleSkippedFiles.length > 0 && (
					<div className={visibleFiles.length > 0 ? "mt-5" : ""} data-testid="diff-skipped-files">
						<div className="rounded-xl border border-edge bg-raised">
							<div className="px-3 py-2 border-b border-edge flex items-center gap-2">
								<span
									aria-hidden="true"
									className="text-[1rem] leading-none text-fg-3"
									style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
								>
									{"\u{F0219}"}
								</span>
								<span className="text-xs font-semibold text-fg">
									{t("infoPanel.diffSkippedFilesTitle")}
								</span>
								<span className="text-[0.6875rem] text-fg-3 font-mono">
									{visibleSkippedFiles.length}
								</span>
							</div>
							<ul className="divide-y divide-edge">
								{visibleSkippedFiles.map((skipped) => {
									const isRead = readFiles[skipped.id] ?? false;
									const isActive = activeFileId === skipped.id;
									return (
										<li
											key={skipped.id}
											ref={(element) => {
												sectionRefs.current[skipped.id] = element;
											}}
											className={`px-3 py-2 flex items-center gap-2 text-[0.75rem] ${
												isActive ? "bg-accent/10" : ""
											}`}
										>
											<span
												title={statusLabelLong(skipped.status, t)}
												className={`px-1.5 py-0.5 rounded-md border text-[0.625rem] font-bold ${statusClassName(skipped.status)}`}
											>
												{statusLabel(skipped.status)}
											</span>
											<span
												className={`min-w-0 flex-1 truncate font-mono text-fg-2 ${
													isRead ? "text-fg-muted line-through decoration-1" : ""
												}`}
												title={skipped.displayPath}
											>
												{(skipped.status === "renamed" || skipped.status === "copied") && skipped.oldPath && skipped.newPath
													? (
														<>
															<span className="text-fg-muted">{skipped.oldPath}</span>
															<span className="mx-1.5 text-fg-3">{"→"}</span>
															<span>{skipped.newPath}</span>
														</>
													)
													: skipped.displayPath}
											</span>
											<span className="shrink-0 font-mono text-fg-3 text-[0.6875rem] tabular-nums">
												{formatSkippedSize(skipped.oldSize)}
												<span className="mx-1.5 text-fg-muted">{"→"}</span>
												{formatSkippedSize(skipped.newSize)}
											</span>
											<span className={`shrink-0 px-1.5 py-0.5 rounded-md border text-[0.625rem] ${
												skipped.reason === "binary"
													? "bg-accent/10 text-accent border-accent/25"
													: "bg-warning/10 text-warning border-warning/25"
											}`}>
												{skipped.reason === "binary"
													? t("infoPanel.diffSkippedReasonBinary")
													: t("infoPanel.diffSkippedReasonLarge")}
											</span>
											<label className="shrink-0 inline-flex items-center gap-1.5 text-[0.625rem] text-fg-3 cursor-pointer select-none">
												<input
													type="checkbox"
													checked={isRead}
													onChange={() => toggleFileRead(skipped.id)}
													aria-label={t("infoPanel.diffReadFile", { file: skipped.displayPath })}
													className="h-3.5 w-3.5 cursor-pointer"
												/>
												<span>{t("infoPanel.diffRead")}</span>
											</label>
										</li>
									);
								})}
							</ul>
						</div>
					</div>
				)}
			</div>
			</div>
		</div>
	);
}

export default TaskDiffViewer;
