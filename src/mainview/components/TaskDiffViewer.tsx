import { useEffect, useRef, useState, type ComponentType } from "react";
import type { Project, Task, TaskDiffFile, TaskDiffResponse } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import type { TaskInlineDiffRequest } from "./task-inline-diff";
import "@git-diff-view/react/styles/diff-view-pure.css";

const LS_DIFF_VIEW_MODE = "dev3-inline-diff-view-mode";
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
	generateDiffFile: (...args: any[]) => DiffInstance;
};

interface TaskDiffViewerProps {
	task: Task;
	project: Project;
	request: TaskInlineDiffRequest;
	onBack: () => void;
}

interface TaskDiffFileSectionProps {
	file: TaskDiffFile;
	diffLib: DiffLibrary;
	viewMode: DiffViewMode;
	eager: boolean;
	expanded: boolean;
	isRead: boolean;
	onToggleExpanded: () => void;
	onToggleRead: () => void;
	sectionRef: (element: HTMLDivElement | null) => void;
}

function readStoredMode(): DiffViewMode {
	try {
		return localStorage.getItem(LS_DIFF_VIEW_MODE) === "unified" ? "unified" : "split";
	} catch {
		return "split";
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

function TaskDiffFileSection({
	file,
	diffLib,
	viewMode,
	eager,
	expanded,
	isRead,
	onToggleExpanded,
	onToggleRead,
	sectionRef,
}: TaskDiffFileSectionProps) {
	const t = useT();
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
					nextDiffFile.initTheme("dark");
					nextDiffFile.initRaw();
					diffInstanceRef.current = nextDiffFile;
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
	}, [activated, diffLib, file.hunks, file.id, file.newContent, file.newPath, file.oldContent, file.oldPath, viewMode]);

	const DiffView = diffLib.DiffView;
	const diffMode = viewMode === "split" ? diffLib.DiffModeEnum.Split : diffLib.DiffModeEnum.Unified;

	return (
		<div
			ref={(element) => {
				hostRef.current = element;
				sectionRef(element);
			}}
			className={`border border-edge rounded-xl overflow-hidden ${isRead ? "bg-elevated" : "bg-raised"}`}
		>
			<div className={`px-4 py-3 border-b border-edge flex flex-wrap items-center gap-3 ${isRead ? "bg-elevated/80" : "bg-raised"}`}>
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
							diffViewTheme="dark"
							diffViewMode={diffMode}
							diffViewWrap={false}
							diffViewHighlight={false}
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
	const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
	const [diffLib, setDiffLib] = useState<DiffLibrary | null>(null);
	const [payload, setPayload] = useState<TaskDiffResponse | null>(null);
	const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
	const [readFiles, setReadFiles] = useState<Record<string, boolean>>({});
	const [loading, setLoading] = useState(true);
	const [showLoadingState, setShowLoadingState] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [viewMode, setViewMode] = useState<DiffViewMode>(readStoredMode);

	useEffect(() => {
		try {
			localStorage.setItem(LS_DIFF_VIEW_MODE, viewMode);
		} catch {}
	}, [viewMode]);

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
				DiffFile: reactLib.DiffFile,
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

	const isBusy = loading || !diffLib;

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
		if (!payload) {
			setExpandedFiles({});
			setReadFiles({});
			return;
		}

		const nextExpandedFiles = Object.fromEntries(
			payload.files.map((file) => [file.id, true]),
		);
		setExpandedFiles(nextExpandedFiles);
		setReadFiles({});
	}, [payload]);

	function scrollToFile(fileId: string) {
		sectionRefs.current[fileId]?.scrollIntoView({
			block: "start",
			behavior: "smooth",
		});
	}

	function toggleFileExpanded(fileId: string) {
		setExpandedFiles((current) => ({
			...current,
			[fileId]: !(current[fileId] ?? true),
		}));
	}

	function toggleFileRead(fileId: string) {
		setReadFiles((current) => {
			const nextRead = !(current[fileId] ?? false);
			setExpandedFiles((expanded) => ({
				...expanded,
				[fileId]: nextRead ? false : true,
			}));
			return {
				...current,
				[fileId]: nextRead,
			};
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

				{payload && payload.files.length > 1 && (
					<div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">
						<span className="text-[0.6875rem] uppercase tracking-wider text-fg-muted font-semibold flex-shrink-0">
							{t("infoPanel.diffFiles")}
						</span>
						{payload.files.map((file) => (
							<button
								key={file.id}
								onClick={() => scrollToFile(file.id)}
								className={`flex-shrink-0 px-2 py-1 rounded-md border text-xs font-mono transition-colors ${readFiles[file.id]
									? "bg-elevated text-fg-muted border-edge line-through decoration-1"
									: "bg-raised text-fg-2 border-edge hover:bg-elevated-hover"
								}`}
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

				{!error && !isBusy && payload && payload.files.length === 0 && payload.summary.files === 0 && renderState(
					t("infoPanel.diffNoChanges"),
					t("infoPanel.diffNoChangesBody"),
				)}

				{!error && !isBusy && payload && payload.files.length === 0 && payload.summary.files > 0 && renderState(
					t("infoPanel.diffNoRenderableFiles"),
					t("infoPanel.diffNoRenderableFilesBody"),
				)}

				{!error && !isBusy && payload && diffLib && payload.files.length > 0 && (
					<div className="space-y-5">
						{payload.files.map((file, index) => (
							<TaskDiffFileSection
								key={file.id}
								file={file}
								diffLib={diffLib}
								viewMode={viewMode}
								eager={index < EAGER_FILE_COUNT}
								expanded={expandedFiles[file.id] ?? true}
								isRead={readFiles[file.id] ?? false}
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
	);
}

export default TaskDiffViewer;
