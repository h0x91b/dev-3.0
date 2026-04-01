import { startTransition, useEffect, useRef, useState, type ComponentType } from "react";
import type { Project, Task, TaskDiffFile, TaskDiffResponse } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import type { TaskInlineDiffRequest } from "./task-inline-diff";
import "@git-diff-view/react/styles/diff-view-pure.css";

const LS_DIFF_VIEW_MODE = "dev3-inline-diff-view-mode";
const LS_DIFF_SHOW_WHITESPACE = "dev3-inline-diff-show-whitespace";

type DiffViewMode = "unified" | "split";

type DiffLibrary = {
	DiffView: ComponentType<any>;
	DiffModeEnum: {
		Split: number;
		Unified: number;
	};
	generateDiffFile: (...args: any[]) => any;
};

type RenderableDiffFile = TaskDiffFile & {
	diffFile: any;
};

interface TaskDiffViewerProps {
	task: Task;
	project: Project;
	request: TaskInlineDiffRequest;
	onBack: () => void;
}

function readStoredMode(): DiffViewMode {
	try {
		return localStorage.getItem(LS_DIFF_VIEW_MODE) === "split" ? "split" : "unified";
	} catch {
		return "unified";
	}
}

function readStoredWhitespace(): boolean {
	try {
		return localStorage.getItem(LS_DIFF_SHOW_WHITESPACE) === "true";
	} catch {
		return false;
	}
}

function visualizeWhitespace(content: string): string {
	return content.replace(/\t/g, "⇥   ").replace(/ /g, "·");
}

function inferLanguage(filePath: string | null): string | undefined {
	if (!filePath) {
		return undefined;
	}

	const ext = filePath.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "ts":
		case "tsx":
			return "typescript";
		case "js":
		case "jsx":
		case "mjs":
		case "cjs":
			return "javascript";
		case "json":
			return "json";
		case "md":
			return "markdown";
		case "yml":
		case "yaml":
			return "yaml";
		case "css":
			return "css";
		case "html":
			return "html";
		case "sh":
			return "bash";
		case "py":
			return "python";
		case "go":
			return "go";
		case "rs":
			return "rust";
		case "rb":
			return "ruby";
		case "java":
			return "java";
		case "kt":
			return "kotlin";
		case "swift":
			return "swift";
		default:
			return undefined;
	}
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

function TaskDiffViewer({ task, project, request, onBack }: TaskDiffViewerProps) {
	const t = useT();
	const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
	const [diffLib, setDiffLib] = useState<DiffLibrary | null>(null);
	const [payload, setPayload] = useState<TaskDiffResponse | null>(null);
	const [renderedFiles, setRenderedFiles] = useState<RenderableDiffFile[]>([]);
	const [loading, setLoading] = useState(true);
	const [showLoadingState, setShowLoadingState] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [viewMode, setViewMode] = useState<DiffViewMode>(readStoredMode);
	const [showWhitespace, setShowWhitespace] = useState(readStoredWhitespace);

	useEffect(() => {
		try {
			localStorage.setItem(LS_DIFF_VIEW_MODE, viewMode);
		} catch {}
	}, [viewMode]);

	useEffect(() => {
		try {
			localStorage.setItem(LS_DIFF_SHOW_WHITESPACE, String(showWhitespace));
		} catch {}
	}, [showWhitespace]);

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
				DiffModeEnum: reactLib.DiffModeEnum,
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

	const isRenderingDiffFiles = !!payload && payload.files.length > 0 && renderedFiles.length !== payload.files.length;
	const isBusy = loading || !diffLib || isRenderingDiffFiles;

	useEffect(() => {
		if (!isBusy) {
			setShowLoadingState(false);
			return;
		}

		const timer = setTimeout(() => setShowLoadingState(true), 300);
		return () => clearTimeout(timer);
	}, [isBusy]);

	useEffect(() => {
		let cancelled = false;

		setLoading(true);
		setError(null);
		setPayload(null);
		setRenderedFiles([]);

		api.request.getTaskDiff({
			taskId: task.id,
			projectId: project.id,
			mode: request.mode,
			compareRef: request.compareRef,
			compareLabel: request.compareLabel,
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
	}, [project.id, request.compareLabel, request.compareRef, request.mode, task.id]);

	useEffect(() => {
		if (!diffLib || !payload) {
			return;
		}

		let cancelled = false;
		const nextFiles = payload.files.map((file) => {
			const oldContent = showWhitespace ? visualizeWhitespace(file.oldContent) : file.oldContent;
			const newContent = showWhitespace ? visualizeWhitespace(file.newContent) : file.newContent;
			const oldPath = file.oldPath ?? file.newPath ?? "/dev/null";
			const newPath = file.newPath ?? file.oldPath ?? "/dev/null";
			const fileLang = inferLanguage(file.newPath ?? file.oldPath);
			const diffFile = diffLib.generateDiffFile(
				oldPath,
				oldContent,
				newPath,
				newContent,
				fileLang,
				fileLang,
			);
			diffFile.initTheme("dark");
			diffFile.init();
			diffFile.buildUnifiedDiffLines();
			diffFile.buildSplitDiffLines();
			return { ...file, diffFile };
		});

		startTransition(() => {
			if (!cancelled) {
				setRenderedFiles(nextFiles);
			}
		});

		return () => {
			cancelled = true;
		};
	}, [diffLib, payload, showWhitespace]);

	const DiffView = diffLib?.DiffView;
	const diffMode = diffLib?.DiffModeEnum ? (
		viewMode === "split" ? diffLib.DiffModeEnum.Split : diffLib.DiffModeEnum.Unified
	) : undefined;

	function scrollToFile(fileId: string) {
		sectionRefs.current[fileId]?.scrollIntoView({
			block: "start",
			behavior: "smooth",
		});
	}

	function renderToolbarButton(label: string, active: boolean, onClick: () => void) {
		return (
			<button
				onClick={onClick}
				className={`px-2.5 py-1 rounded-md border text-xs font-semibold transition-colors ${
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
			<div className="sticky top-0 z-10 border-b border-edge bg-base/95 backdrop-blur px-4 py-3">
				<div className="flex flex-wrap items-center gap-2">
					<button
						onClick={onBack}
						className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors text-sm font-semibold"
					>
						<span className="text-base leading-none">{"\u2190"}</span>
						<span>{t("infoPanel.backToTerminal")}</span>
					</button>
					<div className="min-w-0 flex-1">
						<div className="text-sm font-semibold text-fg">{t("infoPanel.diffViewer")}</div>
						<div className="text-xs text-fg-3">
							{request.mode === "uncommitted"
								? t("infoPanel.diffWorkingTreeBase")
								: t("infoPanel.diffComparedTo", { ref: payload?.compareLabel || request.compareLabel || request.compareRef || "HEAD" })}
						</div>
					</div>
					{renderToolbarButton(t("infoPanel.diffUnified"), viewMode === "unified", () => setViewMode("unified"))}
					{renderToolbarButton(t("infoPanel.diffSplit"), viewMode === "split", () => setViewMode("split"))}
					{renderToolbarButton(t("infoPanel.diffWhitespace"), showWhitespace, () => setShowWhitespace((value) => !value))}
				</div>

				{payload && (
					<div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
						<span className="px-2 py-1 rounded-md bg-raised text-fg-2 border border-edge">
							{t("infoPanel.diffSummary", {
								files: String(payload.summary.files),
								insertions: String(payload.summary.insertions),
								deletions: String(payload.summary.deletions),
							})}
						</span>
						{payload.files.length !== payload.summary.files && (
							<span className="px-2 py-1 rounded-md bg-raised text-fg-3 border border-edge">
								{t("infoPanel.diffShownCount", {
									shown: String(payload.files.length),
									total: String(payload.summary.files),
								})}
							</span>
						)}
						{payload.fallbackReason === "no-upstream" && (
							<span className="px-2 py-1 rounded-md bg-warning/10 text-warning border border-warning/25">
								{t("infoPanel.diffFallbackNoUpstream", { ref: payload.compareLabel })}
							</span>
						)}
						{payload.skippedBinaryFiles.length > 0 && (
							<span className="px-2 py-1 rounded-md bg-raised text-fg-3 border border-edge">
								{t("infoPanel.diffBinarySkipped", { count: String(payload.skippedBinaryFiles.length) })}
							</span>
						)}
						{payload.skippedLargeFiles.length > 0 && (
							<span className="px-2 py-1 rounded-md bg-raised text-fg-3 border border-edge">
								{t("infoPanel.diffLargeSkipped", { count: String(payload.skippedLargeFiles.length) })}
							</span>
						)}
					</div>
				)}

				{renderedFiles.length > 1 && (
					<div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">
						<span className="text-[0.6875rem] uppercase tracking-wider text-fg-muted font-semibold flex-shrink-0">
							{t("infoPanel.diffFiles")}
						</span>
						{renderedFiles.map((file) => (
							<button
								key={file.id}
								onClick={() => scrollToFile(file.id)}
								className="flex-shrink-0 px-2 py-1 rounded-md bg-raised text-fg-2 hover:bg-elevated-hover border border-edge text-xs font-mono"
							>
								{file.newPath ?? file.oldPath ?? file.displayPath}
							</button>
						))}
					</div>
				)}
			</div>

			<div className="flex-1 min-h-0 overflow-auto px-4 py-4">
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

				{!error && !isBusy && payload && renderedFiles.length === 0 && payload.summary.files === 0 && renderState(
					t("infoPanel.diffNoChanges"),
					t("infoPanel.diffNoChangesBody"),
				)}

				{!error && !isBusy && payload && renderedFiles.length === 0 && payload.summary.files > 0 && renderState(
					t("infoPanel.diffNoRenderableFiles"),
					t("infoPanel.diffNoRenderableFilesBody"),
				)}

				{!error && !isBusy && payload && DiffView && renderedFiles.length > 0 && (
					<div className="space-y-5">
						{renderedFiles.map((file) => (
							<div
								key={file.id}
								ref={(element) => { sectionRefs.current[file.id] = element; }}
								className="border border-edge rounded-xl overflow-hidden bg-raised"
							>
								<div className="px-4 py-3 border-b border-edge flex flex-wrap items-center gap-2 bg-raised">
									<span className={`inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded-md border text-[0.6875rem] font-bold ${statusClassName(file.status)}`}>
										{statusLabel(file.status)}
									</span>
									<span className="font-mono text-sm text-fg break-all">{file.displayPath}</span>
								</div>
								<div className="overflow-x-auto">
									<DiffView
										diffFile={file.diffFile}
										diffViewTheme="dark"
										diffViewMode={diffMode}
										diffViewWrap={false}
										diffViewHighlight
										className="diff-tailwindcss-wrapper"
									/>
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

export default TaskDiffViewer;
