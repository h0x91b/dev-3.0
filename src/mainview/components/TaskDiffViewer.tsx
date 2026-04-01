import { useEffect, useRef, useState, type ComponentType } from "react";
import type { Project, Task, TaskDiffFile, TaskDiffResponse } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import { useResolvedTheme } from "../hooks/useResolvedTheme";
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
}

interface InlineDiffCommentThread {
	comments: InlineDiffComment[];
}

interface InlineDiffCommentFileData {
	oldFile: Record<string, { data: InlineDiffCommentThread }>;
	newFile: Record<string, { data: InlineDiffCommentThread }>;
}

type InlineDiffCommentsState = Record<string, InlineDiffCommentFileData>;

interface TaskDiffViewerProps {
	task: Task;
	project: Project;
	request: TaskInlineDiffRequest;
	onBack: () => void;
}

interface TaskDiffFileSectionProps {
	file: TaskDiffFile;
	diffLib: DiffLibrary;
	resolvedTheme: "dark" | "light";
	viewMode: DiffViewMode;
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
	onToggleExpanded: () => void;
	onToggleRead: () => void;
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
	status: TaskDiffFile["status"];
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

function InlineCommentThreadView({
	thread,
	side,
	lineNumber,
}: {
	thread: InlineDiffCommentThread;
	side: InlineCommentSideKey;
	lineNumber: number;
}) {
	const t = useT();

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
					className="dev3-inline-comment__bubble rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-fg whitespace-pre-wrap break-words"
				>
					{comment.body}
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
	const payload = file.hunks?.join("\n")
		?? `${file.oldContent}\u0000${file.newContent}`;
	return `${taskId}:${file.oldPath ?? ""}:${file.newPath ?? ""}:${hashText(payload)}`;
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

function statusClassName(status: TaskDiffFile["status"]): string {
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

function statusLabel(status: TaskDiffFile["status"]): string {
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

function buildDiffTree(files: TaskDiffFile[]): DiffTreeNode[] {
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

	for (const file of files) {
		const fullPath = file.newPath ?? file.oldPath ?? file.displayPath;
		const segments = fullPath.split("/").filter(Boolean);
		if (segments.length === 0) {
			continue;
		}

		let currentChildren = root;
		let currentPath = "";
		for (let index = 0; index < segments.length - 1; index++) {
			const segment = segments[index];
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			currentChildren = findOrCreateFolder(currentChildren, segment, currentPath).children;
		}

		const fileName = segments[segments.length - 1];
		currentChildren.push({
			type: "file",
			key: `file:${file.id}`,
			name: fileName,
			path: fullPath,
			fileId: file.id,
			status: file.status,
		});
	}

	return sortNodes(root);
}

function TaskDiffFileSection({
	file,
	diffLib,
	resolvedTheme,
	viewMode,
	comments,
	eager,
	expanded,
	isRead,
	onAddComment,
	onToggleExpanded,
	onToggleRead,
	sectionRef,
}: TaskDiffFileSectionProps) {
	const t = useT();
	const fileStats = getFileDiffStats(file);
	const [activated, setActivated] = useState(eager);
	const [diffFile, setDiffFile] = useState<DiffInstance | null>(null);
	const [buildError, setBuildError] = useState<string | null>(null);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const diffInstanceRef = useRef<DiffInstance | null>(null);
	const builtModesRef = useRef<Set<DiffViewMode>>(new Set());
	const isFirstExpandedEffectRef = useRef(true);

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
					nextDiffFile = file.hunks
						? new diffLib.DiffFile(oldPath, file.oldContent, newPath, file.newContent, file.hunks, undefined, undefined, file.id)
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
				<button
					onClick={onToggleExpanded}
					aria-expanded={expanded}
					className="min-w-0 flex-1 flex items-center gap-2 text-left hover:text-fg transition-colors"
				>
					<span className={`inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded-md border text-[0.6875rem] font-bold ${statusClassName(file.status)}`}>
						{statusLabel(file.status)}
					</span>
					<span className={`font-mono text-sm break-all min-w-0 ${isRead ? "text-fg-muted line-through decoration-1" : "text-fg"}`}>
						{file.displayPath}
					</span>
					{(fileStats.insertions > 0 || fileStats.deletions > 0) && (
						<span className="ml-1 inline-flex items-center gap-1.5 rounded-md border border-edge bg-base/80 px-2 py-0.5 text-[0.6875rem] font-mono">
							{fileStats.insertions > 0 && <span className="text-success">+{fileStats.insertions}</span>}
							{fileStats.deletions > 0 && <span className="text-danger">−{fileStats.deletions}</span>}
						</span>
					)}
				</button>

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
					<div className="overflow-x-auto">
						<DiffView
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
								/>
							)}
							className="diff-tailwindcss-wrapper"
						/>
					</div>
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

function TaskDiffViewer({ task, project, request, onBack }: TaskDiffViewerProps) {
	const t = useT();
	const resolvedTheme = useResolvedTheme();
	const toolbarRef = useRef<HTMLDivElement | null>(null);
	const scrollRegionRef = useRef<HTMLDivElement | null>(null);
	const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
	const pendingScrollFrameRef = useRef<number | null>(null);
	const [diffLib, setDiffLib] = useState<DiffLibrary | null>(null);
	const [payload, setPayload] = useState<TaskDiffResponse | null>(null);
	const [currentRequest, setCurrentRequest] = useState<TaskInlineDiffRequest>(request);
	const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
	const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
	const [readFiles, setReadFiles] = useState<Record<string, boolean>>({});
	const [activeFileId, setActiveFileId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [showLoadingState, setShowLoadingState] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [viewMode, setViewMode] = useState<DiffViewMode | null>(null);
	const [inlineComments, setInlineComments] = useState<InlineDiffCommentsState>({});
	const fileTree = payload ? buildDiffTree(payload.files) : [];

	useEffect(() => {
		setCurrentRequest(request);
	}, [request.compareLabel, request.compareRef, request.focusFile, request.mode]);

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
			if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation?.();
			onBack();
		};

		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, [onBack]);

	useEffect(() => () => {
		if (pendingScrollFrameRef.current !== null) {
			window.cancelAnimationFrame(pendingScrollFrameRef.current);
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
	}, [currentRequest.compareLabel, currentRequest.compareRef, currentRequest.mode, project.id, task.id]);

	useEffect(() => {
		if (!payload) {
			setCollapsedFolders({});
			setExpandedFiles({});
			setReadFiles({});
			setActiveFileId(null);
			setInlineComments({});
			return;
		}

		const storedReadState = readStoredReadState();
		const nextReadFiles = Object.fromEntries(
			payload.files.map((file) => [file.id, !!storedReadState[getFileReadSignature(task.id, file)]]),
		);
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
		options?: { expand?: boolean; behavior?: ScrollBehavior; retries?: number },
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
		pendingScrollFrameRef.current = window.requestAnimationFrame(() => {
			alignFileScroll(fileId, behavior, retries);
		});
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
		if (!targetFile) {
			return;
		}
		const signature = getFileReadSignature(task.id, targetFile);
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
		writeStoredReadState(storedReadState);
		setReadFiles(
			Object.fromEntries(payload.files.map((file) => [file.id, nextRead])),
		);
		setExpandedFiles(
			Object.fromEntries(payload.files.map((file) => [file.id, nextRead ? false : true])),
		);
	}

	const readCount = payload ? Object.values(readFiles).filter(Boolean).length : 0;
	const allFilesExpanded = payload ? payload.files.every((file) => expandedFiles[file.id] ?? true) : false;
	const allFilesRead = payload ? payload.files.length > 0 && payload.files.every((file) => readFiles[file.id] ?? false) : false;

	function renderFileTreeNode(node: DiffTreeNode, depth = 0): JSX.Element {
		if (node.type === "folder") {
			const collapsed = collapsedFolders[node.key] ?? false;
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
						<span className="min-w-0 truncate font-medium">{node.name}</span>
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
				<span className={`min-w-0 truncate font-mono ${isRead ? "text-fg-muted line-through decoration-1" : ""}`}>
					{node.name}
				</span>
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
						onClick={onBack}
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
							{payload.files.length !== payload.summary.files && (
								<span className="px-2 py-1 rounded-md bg-raised text-fg-3 border border-edge text-[0.6875rem]">
									{t("infoPanel.diffShownCount", {
										shown: String(payload.files.length),
										total: String(payload.summary.files),
									})}
								</span>
							)}
							{payload.fallbackReason === "no-upstream" && (
								<span className="px-2 py-1 rounded-md bg-warning/10 text-warning border border-warning/25 text-[0.6875rem]">
									{t("infoPanel.diffFallbackNoUpstream", { ref: payload.compareLabel })}
								</span>
							)}
							{payload.skippedBinaryFiles.length > 0 && (
								<span className="px-2 py-1 rounded-md bg-raised text-fg-3 border border-edge text-[0.6875rem]">
									{t("infoPanel.diffBinarySkipped", { count: String(payload.skippedBinaryFiles.length) })}
								</span>
							)}
							{payload.skippedLargeFiles.length > 0 && (
								<span className="px-2 py-1 rounded-md bg-raised text-fg-3 border border-edge text-[0.6875rem]">
									{t("infoPanel.diffLargeSkipped", { count: String(payload.skippedLargeFiles.length) })}
								</span>
							)}
						</>
					)}
					{renderToolbarButton(t("infoPanel.diffBranch"), currentRequest.mode === "branch", () => switchDiffMode("branch"))}
					{renderToolbarButton(t("infoPanel.uncommittedDiff"), currentRequest.mode === "uncommitted", () => switchDiffMode("uncommitted"))}
					{renderToolbarButton(t("infoPanel.unpushedDiff"), currentRequest.mode === "unpushed", () => switchDiffMode("unpushed"))}
					<div className="ml-auto flex items-center gap-2">
						{renderToolbarButton(t("infoPanel.diffUnified"), viewMode === "unified", () => setViewMode("unified"))}
						{renderToolbarButton(t("infoPanel.diffSplit"), viewMode === "split", () => setViewMode("split"))}
					</div>
				</div>
			</div>

			<div className="flex-1 min-h-0 flex overflow-hidden">
				{!error && !isBusy && payload && payload.files.length > 0 && (
					<aside className="w-[22rem] shrink-0 border-r border-edge bg-raised/35">
						<div className="h-full overflow-auto px-3 py-2">
							<div className="sticky top-0 z-10 bg-raised/35 pb-2">
								<div className="rounded-lg border border-edge bg-base px-3 py-2 space-y-1.5">
									<div className="flex items-center justify-between gap-2 px-1">
										<span className="text-[0.6875rem] uppercase tracking-wider text-fg-muted font-semibold">
											{t("infoPanel.diffFiles")}
										</span>
										<span className="text-[0.6875rem] text-fg-3 font-mono">
											{readCount}/{payload.files.length} {t("infoPanel.diffRead")}
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

				{!error && !isBusy && payload && payload.files.length === 0 && payload.summary.files === 0 && renderState(
					t("infoPanel.diffNoChanges"),
					t("infoPanel.diffNoChangesBody"),
				)}

				{!error && !isBusy && payload && payload.files.length === 0 && payload.summary.files > 0 && renderState(
					t("infoPanel.diffNoRenderableFiles"),
					t("infoPanel.diffNoRenderableFilesBody"),
				)}

				{!error && !isBusy && payload && diffLib && viewMode && payload.files.length > 0 && (
					<div className="space-y-5">
						{payload.files.map((file, index) => (
							<TaskDiffFileSection
								key={file.id}
								file={file}
								diffLib={diffLib}
								resolvedTheme={resolvedTheme}
								viewMode={viewMode}
								comments={inlineComments[file.id] ?? createEmptyInlineCommentFileData()}
								eager={index < EAGER_FILE_COUNT}
								expanded={expandedFiles[file.id] ?? true}
								isRead={readFiles[file.id] ?? false}
								onAddComment={addInlineComment}
								onToggleExpanded={() => toggleFileExpanded(file.id)}
								onToggleRead={() => toggleFileRead(file.id)}
								sectionRef={(element) => {
									sectionRefs.current[file.id] = element;
								}}
							/>
						))}
					</div>
				)}
			</div>
			</div>
		</div>
	);
}

export default TaskDiffViewer;
