import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type MutableRefObject, type ReactNode } from "react";
import type { NavigationGuard } from "../navigation-guard";
import type {
	Project,
	Task,
	TaskDiffFile,
	TaskDiffFileStatus,
	TaskDiffResponse,
	TaskDiffSkippedFile,
} from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import { useResolvedTheme } from "../hooks/useResolvedTheme";
import { formatBytes } from "../utils/formatBytes";
import type { TaskInlineDiffRequest } from "./task-inline-diff";
import "@git-diff-view/react/styles/diff-view-pure.css";
import "./TaskDiffViewer.css";

const LS_DIFF_READ_STATE = "dev3-inline-diff-read-state-v1";
const EAGER_FILE_COUNT = 2;

type DiffViewMode = "unified" | "split";

type DiffInstance = {
	initTheme: (theme?: "light" | "dark") => void;
	initRaw: () => void;
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

type InlineCommentSideKey = "oldFile" | "newFile";

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
	searchQuery: string;
	isCurrentPathMatch: boolean;
	comments: InlineDiffCommentFileData;
	eager: boolean;
	expanded: boolean;
	isRead: boolean;
	onAddComment: (params: {
		fileId: string;
		side: InlineCommentSideKey;
		lineNumber: number;
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

function getReviewFilePath(file: TaskDiffFile): string {
	return file.newPath ?? file.oldPath ?? file.displayPath;
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

function parseDiffHunkLines(hunk: string): Array<{
	kind: "+" | "-" | " ";
	text: string;
	content: string;
	oldLine: number | null;
	newLine: number | null;
}> {
	const lines = hunk.split("\n");
	const parsed: Array<{
		kind: "+" | "-" | " ";
		text: string;
		content: string;
		oldLine: number | null;
		newLine: number | null;
	}> = [];
	let oldLine = 0;
	let newLine = 0;
	let inBody = false;

	for (const line of lines) {
		const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (header) {
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
			inBody = true;
			continue;
		}
		if (!inBody || line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\")) {
			continue;
		}

		const prefix = line[0];
		if (prefix !== "+" && prefix !== "-" && prefix !== " ") {
			continue;
		}

		const entry = {
			kind: prefix,
			text: line,
			content: line.slice(1),
			oldLine: prefix === "+" ? null : oldLine,
			newLine: prefix === "-" ? null : newLine,
		} as const;
		parsed.push(entry);

		if (prefix !== "+") {
			oldLine += 1;
		}
		if (prefix !== "-") {
			newLine += 1;
		}
	}

	return parsed;
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

function extractReviewSnippet(
	file: TaskDiffFile,
	side: InlineCommentSideKey,
	startLine: number,
	endLine: number,
): { before: string | null; after: string | null } {
	const lineKey = side === "oldFile" ? "oldLine" : "newLine";
	for (const hunk of file.hunks ?? []) {
		const lines = parseDiffHunkLines(hunk);
		if (lines.length === 0) {
			continue;
		}

		const targetIndexes = lines
			.map((line, index) => ({ line, index }))
			.filter(({ line }) => {
				const lineNumber = line[lineKey];
				return lineNumber !== null && lineNumber >= startLine && lineNumber <= endLine;
			})
			.map(({ index }) => index);

		if (targetIndexes.length === 0) {
			continue;
		}

		let from = targetIndexes[0];
		let to = targetIndexes[targetIndexes.length - 1];
		while (from > 0 && lines[from - 1]?.kind !== " ") {
			from -= 1;
		}
		while (to < lines.length - 1 && lines[to + 1]?.kind !== " ") {
			to += 1;
		}

		const block = lines.slice(from, to + 1).map((line, relativeIndex) => ({
			...line,
			relativeIndex,
		}));
		const targetRelativeIndex = targetIndexes[0] - from;
		const targetLine = block[targetRelativeIndex];

		if (!targetLine) {
			continue;
		}

		if (targetLine.kind === " ") {
			return {
				before: targetLine.content,
				after: targetLine.content,
			};
		}

		const removedLines = block.filter((line) => line.kind === "-");
		const addedLines = block.filter((line) => line.kind === "+");

		if (targetLine.kind === "-") {
			const removedIndex = removedLines.findIndex((line) => line.relativeIndex === targetRelativeIndex);
			return {
				before: targetLine.content,
				after: removedIndex >= 0 && removedIndex < addedLines.length
					? addedLines[removedIndex]?.content ?? null
					: null,
			};
		}

		const addedIndex = addedLines.findIndex((line) => line.relativeIndex === targetRelativeIndex);
		return {
			before: addedIndex >= 0 && addedIndex < removedLines.length
				? removedLines[addedIndex]?.content ?? null
				: null,
			after: targetLine.content,
		};
	}

	const fallbackLines = (side === "oldFile" ? file.oldContent : file.newContent).split("\n");
	const selected = fallbackLines
		.slice(Math.max(0, startLine - 1), endLine)
		.find((line) => line.length > 0) ?? null;
	return side === "oldFile"
		? { before: selected, after: null }
		: { before: null, after: selected };
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
					});
				}
			}
		}
	}

	return result.sort((left, right) => (
		left.fileOrder - right.fileOrder
		|| left.startLine - right.startLine
		|| left.createdAt.localeCompare(right.createdAt)
	));
}

function buildInlineReviewXml(entries: InlineReviewExportEntry[]): string {
	const lines = ["<reviews>"];

	for (const entry of entries) {
		const lineAttr = entry.startLine === entry.endLine
			? String(entry.startLine)
			: `"${entry.startLine}-${entry.endLine}"`;
		lines.push("<review>");
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
	lines.push("Above my comments about code changes, read them carefully and process all of them.");
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
				{t("infoPanel.diffCommentLine", {
					side: t(getInlineCommentSideLabel(side)),
					line: String(lineNumber),
				})}
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
	lineNumber,
	onCancel,
	onSubmit,
}: {
	filePath: string;
	side: InlineCommentSideKey;
	lineNumber: number;
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
					{filePath} · {t("infoPanel.diffCommentLine", {
						side: t(getInlineCommentSideLabel(side)),
						line: String(lineNumber),
					})}
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
	if (file.hunks && file.hunks.length > 0) {
		let insertions = 0;
		let deletions = 0;
		for (const hunk of file.hunks) {
			for (const line of hunk.split("\n")) {
				if (line.startsWith("+++ ") || line.startsWith("--- ")) {
					continue;
				}
				if (line.startsWith("+")) {
					insertions += 1;
				} else if (line.startsWith("-")) {
					deletions += 1;
				}
			}
		}
		return { insertions, deletions };
	}

	const oldLines = file.oldContent ? file.oldContent.split("\n") : [];
	const newLines = file.newContent ? file.newContent.split("\n") : [];
	return {
		insertions: Math.max(0, newLines.length - oldLines.length),
		deletions: Math.max(0, oldLines.length - newLines.length),
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
}: TaskDiffFileSectionProps) {
	const t = useT();
	const fileStats = getFileDiffStats(file);
	const [activated, setActivated] = useState(eager);
	const [diffFile, setDiffFile] = useState<DiffInstance | null>(null);
	const [buildError, setBuildError] = useState<string | null>(null);
	const [copiedPath, setCopiedPath] = useState(false);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const diffInstanceRef = useRef<DiffInstance | null>(null);
	const builtModesRef = useRef<Set<DiffViewMode>>(new Set());
	const isFirstExpandedEffectRef = useRef(true);
	const copiedPathResetRef = useRef<number | null>(null);

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
					>
						<span className={`font-mono text-sm break-all min-w-0 ${isRead ? "text-fg-muted line-through decoration-1" : "text-fg"}${isCurrentPathMatch ? " dev3-diff-search-current-hit" : ""}`}>
							{renderHighlightedText(file.displayPath, searchQuery, isCurrentPathMatch)}
						</span>
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
					<DiffView
						key={diffRenderKey}
						diffFile={diffFile}
						diffViewTheme={resolvedTheme}
						diffViewMode={diffMode}
						diffViewWrap={false}
						diffViewHighlight={false}
						diffViewAddWidget
						extendData={comments}
						renderWidgetLine={({ lineNumber, side, onClose }: { lineNumber: number; side: number; onClose: () => void }) => (
							<InlineCommentComposer
								filePath={file.displayPath}
								side={getInlineCommentSideKey(side, diffLib.SplitSide)}
								lineNumber={lineNumber}
								onCancel={onClose}
								onSubmit={(body) => {
									onAddComment({
										fileId: file.id,
										side: getInlineCommentSideKey(side, diffLib.SplitSide),
										lineNumber,
										body,
									});
									onClose();
								}}
							/>
						)}
						renderExtendLine={({ data, lineNumber, side }: { data: InlineDiffCommentThread; lineNumber: number; side: number }) => (
							<InlineCommentThreadView
								thread={data}
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
						className="diff-tailwindcss-wrapper"
					/>
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
	const [currentRequest, setCurrentRequest] = useState<TaskInlineDiffRequest>(request);
	const [requestVersion, setRequestVersion] = useState(0);
	const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
	const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
	const [readFiles, setReadFiles] = useState<Record<string, boolean>>({});
	const [activeFileId, setActiveFileId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [showLoadingState, setShowLoadingState] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [viewMode, setViewMode] = useState<DiffViewMode | null>(null);
	const [inlineComments, setInlineComments] = useState<InlineDiffCommentsState>({});
	const [copiedReviewXml, setCopiedReviewXml] = useState(false);
	const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
	const [editingCommentDraft, setEditingCommentDraft] = useState("");
	const [isSearchOpen, setIsSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [activeSearchIndex, setActiveSearchIndex] = useState(0);
	const fileTree = payload ? buildDiffTree(payload.files, payload.skippedFiles) : [];
	const reviewExportEntries = payload ? buildInlineReviewExportEntries(payload.files, inlineComments) : [];
	const reviewExportXml = buildInlineReviewXml(reviewExportEntries);
	const searchMatches = useMemo(
		() => (payload ? buildDiffSearchMatches(payload.files, searchQuery) : []),
		[payload, searchQuery],
	);
	const currentSearchMatch = searchMatches[activeSearchIndex] ?? null;

	const hasUnsavedReviewRef = useRef(false);
	useEffect(() => {
		hasUnsavedReviewRef.current = hasAnyInlineComments(inlineComments);
	}, [inlineComments]);

	const requestClose = useCallback(() => {
		if (!hasUnsavedReviewRef.current) {
			onBack();
			return;
		}
		api.request.showConfirm({
			title: t("infoPanel.diffDiscardReviewTitle"),
			message: t("infoPanel.diffDiscardReviewMessage"),
		})
			.then((confirmed) => {
				if (confirmed) {
					onBack();
				}
			})
			.catch(() => {});
	}, [onBack, t]);

	const reviewExportXmlRef = useRef("");
	useEffect(() => {
		reviewExportXmlRef.current = reviewExportXml;
	}, [reviewExportXml]);

	useEffect(() => {
		if (!navigationGuardRef) {
			return;
		}
		navigationGuardRef.current = {
			isDirty: () => hasUnsavedReviewRef.current,
			onSave: async () => {
				const xml = reviewExportXmlRef.current;
				if (!xml) return;
				try {
					await navigator.clipboard.writeText(xml);
				} catch {
					/* clipboard not available — leaving navigation flow intact */
				}
			},
		};
		return () => {
			navigationGuardRef.current = null;
		};
	}, [navigationGuardRef]);

	const isInitialRequestSyncRef = useRef(true);

	useEffect(() => {
		setCurrentRequest(request);
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
					setViewMode(settings.defaultDiffViewMode === "unified" ? "unified" : "split");
				}
			})
			.catch(() => {
				if (!cancelled) {
					setViewMode("split");
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
		]).then(([reactLib, fileLib]) => {
			if (cancelled) {
				return;
			}
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
		}).then((result) => {
			if (cancelled) {
				return;
			}
			setPayload(result);
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
	}, [currentRequest.compareLabel, currentRequest.compareRef, currentRequest.mode, project.id, requestVersion, task.id]);

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
		setInlineComments({});
		setEditingCommentId(null);
		setEditingCommentDraft("");
	}, [currentRequest.focusFile, payload, task.id]);

	function addInlineComment({
		fileId,
		side,
		lineNumber,
		body,
	}: {
		fileId: string;
		side: InlineCommentSideKey;
		lineNumber: number;
		body: string;
	}) {
		const trimmedBody = body.trim();
		if (!trimmedBody) {
			return;
		}

		setInlineComments((current) => {
			const fileComments = current[fileId] ?? createEmptyInlineCommentFileData();
			const sideComments = fileComments[side];
			const existingThread = sideComments[lineNumber]?.data;
			const nextComment: InlineDiffComment = {
				id: `${fileId}:${side}:${lineNumber}:${Date.now().toString(36)}`,
				body: trimmedBody,
				createdAt: new Date().toISOString(),
				startLine: lineNumber,
				endLine: lineNumber,
				side,
			};
			return {
				...current,
				[fileId]: {
					...fileComments,
					[side]: {
						...sideComments,
						[lineNumber]: {
							data: {
								comments: [...(existingThread?.comments ?? []), nextComment],
							},
						},
					},
				},
			};
		});
	}

	function handleCopyReviewXml() {
		navigator.clipboard.writeText(reviewExportXml).then(() => {
			setCopiedReviewXml(true);
			window.setTimeout(() => setCopiedReviewXml(false), 1500);
		}).catch(() => {});
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
		setExpandedFiles(
			Object.fromEntries(payload.files.map((file) => [file.id, nextExpanded])),
		);
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
		const nextReadEntries: Record<string, boolean> = Object.fromEntries(
			payload.files.map((file) => [file.id, nextRead]),
		);
		for (const skipped of payload.skippedFiles) {
			nextReadEntries[skipped.id] = nextRead;
		}
		setReadFiles(nextReadEntries);
		setExpandedFiles(
			Object.fromEntries(payload.files.map((file) => [file.id, nextRead ? false : true])),
		);
	}

	const totalFileCount = payload ? payload.files.length + payload.skippedFiles.length : 0;
	const readCount = payload ? Object.values(readFiles).filter(Boolean).length : 0;
	const allFilesExpanded = payload ? payload.files.every((file) => expandedFiles[file.id] ?? true) : false;
	const allFilesRead = payload
		? totalFileCount > 0
			&& payload.files.every((file) => readFiles[file.id] ?? false)
			&& payload.skippedFiles.every((skipped) => readFiles[skipped.id] ?? false)
		: false;
	const hasSearchQuery = searchQuery.trim().length > 0;
	const searchStatusLabel = hasSearchQuery
		? (searchMatches.length > 0 ? `${activeSearchIndex + 1} / ${searchMatches.length}` : t("infoPanel.diffSearchNoMatches"))
		: null;

	function renderFileTreeNode(node: DiffTreeNode, depth = 0): JSX.Element {
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
							{node.children.map((child) => renderFileTreeNode(child, depth + 1))}
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
				onClick={() => scrollToFile(node.fileId, { expand: true })}
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
		if (mode === currentRequest.mode) {
			return;
		}
		if (mode === "uncommitted") {
			setCurrentRequest({
				mode: "uncommitted",
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

	function renderToolbarButton(label: string, active: boolean, onClick: () => void) {
		return (
			<button
				onClick={onClick}
				className={`px-2.5 py-0.5 rounded-md border text-[0.6875rem] font-semibold transition-colors ${
					active
						? "bg-accent text-white border-accent"
						: "bg-raised text-fg-2 border-edge hover:bg-elevated-hover"
				}`}
			>
				{label}
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
			<div ref={toolbarRef} className="sticky top-0 z-10 border-b border-edge bg-base/95 backdrop-blur px-4 py-2" data-testid="inline-diff-toolbar">
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
							{currentRequest.mode === "uncommitted"
								? t("infoPanel.diffWorkingTreeBase")
								: t("infoPanel.diffComparedTo", { ref: payload?.compareLabel || currentRequest.compareLabel || currentRequest.compareRef || "HEAD" })}
						</div>
					</div>
					{payload && (
						<>
							<span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-raised text-fg-2 border border-edge text-[0.6875rem] font-mono">
								<span>{t.plural("infoPanel.diffFileCount", payload.summary.files)}</span>
								<span className="text-success">+{payload.summary.insertions}</span>
								<span className="text-danger">−{payload.summary.deletions}</span>
							</span>
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
							{(() => {
								const binaryCount = payload.skippedFiles.filter((f) => f.reason === "binary").length;
								const largeCount = payload.skippedFiles.filter((f) => f.reason === "too-large").length;
								return (
									<>
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
							})()}
						</>
					)}
					{renderToolbarButton(t("infoPanel.diffBranch"), currentRequest.mode === "branch", () => switchDiffMode("branch"))}
					{renderToolbarButton(t("infoPanel.uncommittedDiff"), currentRequest.mode === "uncommitted", () => switchDiffMode("uncommitted"))}
					{renderToolbarButton(t("infoPanel.unpushedDiff"), currentRequest.mode === "unpushed", () => switchDiffMode("unpushed"))}
					<div className="ml-auto flex items-center gap-2">
						<button
							type="button"
							onClick={() => {
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
							}}
							aria-label={t("infoPanel.diffSearchOpen")}
							title={`${t("infoPanel.diffSearchOpen")} (⌘F)`}
							className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
								isSearchOpen
									? "border-accent bg-accent text-white"
									: "border-edge bg-raised text-fg-2 hover:bg-elevated-hover"
							}`}
						>
							<span
								aria-hidden="true"
								className="text-[0.95rem] leading-none"
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{"\uF002"}
							</span>
						</button>
						{isSearchOpen && (
							<div className="inline-flex min-w-[18rem] max-w-[32rem] items-center gap-1.5 rounded-md border border-edge bg-raised px-2 py-1">
								<div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-edge bg-base px-2 focus-within:border-accent/60 transition-colors">
									<span
										aria-hidden="true"
										className="shrink-0 text-[0.8rem] leading-none text-fg-muted"
										style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
									>
										{"\uF002"}
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
										{"\u25B2"}
									</button>
									<button
										type="button"
										onClick={() => stepSearchMatch(1)}
										disabled={searchMatches.length === 0}
										aria-label={t("infoPanel.diffSearchNext")}
										title={t("infoPanel.diffSearchNext")}
										className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-edge bg-base text-fg-2 transition-colors hover:bg-elevated-hover disabled:cursor-not-allowed disabled:text-fg-muted"
									>
										{"\u25BC"}
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
									{"\u2715"}
								</button>
							</div>
						)}
						{renderToolbarButton(t("infoPanel.diffUnified"), viewMode === "unified", () => setViewMode("unified"))}
						{renderToolbarButton(t("infoPanel.diffSplit"), viewMode === "split", () => setViewMode("split"))}
					</div>
				</div>
			</div>

			<div className="flex-1 min-h-0 flex overflow-hidden">
				{!error && !isBusy && payload && totalFileCount > 0 && (
					<aside className="w-[22rem] shrink-0 border-r border-edge bg-raised/35">
						<div className="h-full overflow-auto px-3 py-2">
							<div className="sticky top-0 z-10 bg-raised/35 pb-2">
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
															<div className="text-xs font-semibold text-fg">
																{t("infoPanel.diffReviewCommentItem", { number: String(index + 1) })}
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
							<div className="space-y-1">
								{fileTree.map((node) => renderFileTreeNode(node))}
							</div>
						</div>
					</aside>
				)}

				<div ref={scrollRegionRef} className="flex-1 min-w-0 overflow-auto px-4 pt-1 pb-4" data-testid="inline-diff-scroll-region">
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

				{!error && !isBusy && payload && payload.files.length === 0 && payload.skippedFiles.length === 0 && renderState(
					t("infoPanel.diffNoChanges"),
					t("infoPanel.diffNoChangesBody"),
				)}

				{!error && !isBusy && payload && diffLib && viewMode && payload.files.length > 0 && (
					<div className="space-y-5">
						{payload.files.map((file, index) => (
							<TaskDiffFileSection
								key={file.id}
								file={file}
								worktreePath={task.worktreePath}
								diffLib={diffLib}
								resolvedTheme={resolvedTheme}
								viewMode={viewMode}
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
							/>
						))}
					</div>
				)}

				{!error && !isBusy && payload && payload.skippedFiles.length > 0 && (
					<div className={payload.files.length > 0 ? "mt-5" : ""} data-testid="diff-skipped-files">
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
									{payload.skippedFiles.length}
								</span>
							</div>
							<ul className="divide-y divide-edge">
								{payload.skippedFiles.map((skipped) => {
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
