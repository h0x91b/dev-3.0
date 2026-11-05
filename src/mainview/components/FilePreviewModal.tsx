import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useT } from "../i18n";
import { api, isElectrobun } from "../rpc";
import { toast } from "../toast";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFindInElement } from "../hooks/useFindInElement";
import FindBar, { type FindBarHandle } from "./FindBar";
import { formatBytes } from "../utils/formatBytes";
import { writeClipboardText } from "../utils/clipboard-write";
import type { FilePreviewResult, Task } from "../../shared/types";
import { clipReviewExcerpt, type ReviewComment, type ReviewFileRangeAnchor, type ReviewImageRegionAnchor } from "../../shared/review";
import { ReviewAside } from "../review/ReviewAside";
import { ImageRegionOverlay, regionLabel, type Region } from "../review/ImageRegionOverlay";
import { useReviewSend } from "../review/useReviewSend";
import { useTaskReview } from "../review/useTaskReview";
import { MarkdownDocument } from "./pr-review/markdown";
import FilePreviewMedia from "./FilePreviewMedia";
import { isRenderableDocPath, toRenderableMarkdown } from "./pr-review/markdown-files";
import { useResolvedTheme } from "../hooks/useResolvedTheme";
import { useSyntaxLines, type SyntaxToken } from "./file-preview-syntax";
import { PopupBlockedError, downloadFile, errorText, openFileInNewTab, opensInBrowserTab, opensSafelyOnWindows, windowsHostOpenAvailable } from "../file-open-browser";
// Token colours for both themes — the diff viewer's own stylesheet, scoped to its wrapper class.
import "@git-diff-view/react/styles/diff-view-pure.css";

interface FilePreviewModalProps {
	path: string;
	/** 1-based line to scroll to and highlight (from a :line[:col] link suffix). */
	line?: number;
	/** Task the path was clicked in, so this modal's toasts name their origin. */
	taskId?: string;
	/** The owning project; without it a selection cannot become a review comment. */
	projectId?: string;
	/** The live task record when the host has it — its `review` marks the commented lines. */
	task?: Pick<Task, "id" | "review">;
	onClose: () => void;
}

interface PendingSelection {
	excerpt: string;
	startLine: number | null;
	endLine: number | null;
}

/** The floating button's spot: the selection's end, in coordinates of the body container. */
interface SelectionSpot extends PendingSelection { top: number; left: number }

function lineOf(node: Node | null): number | null {
	const element = node instanceof Element ? node : node?.parentElement ?? null;
	const raw = element?.closest<HTMLElement>("[data-preview-line]")?.dataset.previewLine;
	return raw ? Number(raw) : null;
}

const DIR_MAX_CHARS = 90;

function middleTruncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const half = Math.floor((max - 1) / 2);
	return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

const WRAP_KEY = "dev3-file-preview-wrap";
const EXPANDED_KEY = "dev3-file-preview-expanded";

/** Per-viewer view preference; storage can be missing or throw (private windows). */
function readFlag(key: string, fallback: boolean): boolean {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : raw === "1";
	} catch {
		return fallback;
	}
}

function writeFlag(key: string, value: boolean): void {
	try {
		localStorage.setItem(key, value ? "1" : "0");
	} catch {
		// Preference only — the toggle still works for this session.
	}
}

function usePersistedFlag(key: string, fallback: boolean): [boolean, () => void] {
	const [value, setValue] = useState(() => readFlag(key, fallback));
	const toggle = useCallback(() => setValue((current) => {
		writeFlag(key, !current);
		return !current;
	}), [key]);
	return [value, toggle];
}

/**
 * Grow-only height for the content-hugging dialog: reflowing the same file
 * (Wrap lines, Raw/Rendered, find bar) may enlarge it but never shrinks it under
 * the reader. A new file or an explicit Expand/Restore starts over (`resetKey`).
 */
function useFitHeightFloor(ref: RefObject<HTMLElement | null>, active: boolean, resetKey: string): number | null {
	const [floor, setFloor] = useState<number | null>(null);
	useEffect(() => {
		setFloor(null);
		const element = ref.current;
		if (!active || !element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			const height = Math.round(element.getBoundingClientRect().height);
			setFloor((current) => (current === null || height > current ? height : current));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref, active, resetKey]);
	return active ? floor : null;
}

const ICON_FONT = "'JetBrainsMono Nerd Font Mono'";

const GHOST_BUTTON =
	"px-3 py-1.5 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-overlay-hover " +
	"transition-[background-color,color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]";

/**
 * In-app preview for a file path Cmd/Ctrl+Clicked in terminal output. Browser
 * sessions always use it (a host-side open would be invisible there), and its
 * footer hands the file to the viewer's own browser instead.
 */
export default function FilePreviewModal({ path, line, taskId, projectId, task, onClose }: FilePreviewModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const [preview, setPreview] = useState<FilePreviewResult | null>(null);
	const [showRaw, setShowRaw] = useState(false);
	const [wrapLines, toggleWrapLines] = usePersistedFlag(WRAP_KEY, true);
	const [expanded, toggleExpanded] = usePersistedFlag(EXPANDED_KEY, false);
	const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null);
	const [mediaUnplayable, setMediaUnplayable] = useState(false);
	const markMediaUnplayable = useCallback(() => setMediaUnplayable(true), []);
	const [canOpenOnWindows, setCanOpenOnWindows] = useState(false);
	const highlightRef = useRef<HTMLDivElement | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const findBarRef = useRef<FindBarHandle | null>(null);

	const focusFindInput = useCallback(() => findBarRef.current?.focusInput(), []);

	// Select text in the file → comment on it. Same review as the diff viewer and
	// the artifact viewer; the anchor is the path, the line range when the code
	// view supplies one, and the selected text.
	const reviewTask = useMemo<Pick<Task, "id" | "review">>(() => task ?? { id: taskId ?? "" }, [task, taskId]);
	const review = useTaskReview(reviewTask, projectId ?? "");
	const send = useReviewSend(taskId ?? "", projectId, review);
	const canComment = Boolean(projectId && taskId);
	const [selection, setSelection] = useState<SelectionSpot | null>(null);
	const [pending, setPending] = useState<PendingSelection | null>(null);
	const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
	// Text previews anchor by line range; an image preview anchors by region,
	// with the file path standing in for the shared-image id.
	const fileComments = useMemo(
		() => review.comments.filter((comment) => (
			(comment.anchor.kind === "file-range" || comment.anchor.kind === "image-region")
			&& comment.anchor.path === path
		)),
		[path, review.comments],
	);
	const [pendingRegion, setPendingRegion] = useState<Region | null>(null);
	// Region picking is a mode, exactly as in the image viewer: without it every
	// click on a previewed picture opens a comment composer.
	const [commentMode, setCommentMode] = useState(false);
	const [imageBox, setImageBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const measureImage = useCallback(() => {
		const img = imgRef.current;
		if (!img) { setImageBox(null); return; }
		setImageBox({ left: 0, top: 0, width: img.clientWidth, height: img.clientHeight });
	}, []);
	useEffect(() => {
		const img = imgRef.current;
		if (!img || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measureImage);
		observer.observe(img);
		return () => observer.disconnect();
	}, [measureImage, preview]);
	const addRegionComment = (body: string, andSend: boolean) => {
		if (!pendingRegion) return;
		const anchor: ReviewImageRegionAnchor = { kind: "image-region", imageId: path, name: fileName, path, caption: null, ...pendingRegion };
		const comment: ReviewComment = { id: crypto.randomUUID(), body, createdAt: new Date().toISOString(), anchor };
		review.add(comment);
		setPendingRegion(null);
		setActiveCommentId(comment.id);
		if (andSend) send.sendOne(comment);
	};
	const commentedLines = useMemo(() => {
		const lines = new Set<number>();
		for (const comment of fileComments) {
			if (comment.anchor.kind !== "file-range") continue;
			const anchor: ReviewFileRangeAnchor = comment.anchor;
			if (anchor.startLine === null) continue;
			for (let n = anchor.startLine; n <= (anchor.endLine ?? anchor.startLine); n++) lines.add(n);
		}
		return lines;
	}, [fileComments]);
	const readSelection = useCallback(() => {
		if (!canComment) return;
		const body = bodyRef.current;
		const active = window.getSelection();
		if (!body || !active || active.rangeCount === 0 || active.isCollapsed) { setSelection(null); return; }
		const range = active.getRangeAt(0);
		if (!body.contains(range.commonAncestorContainer)) { setSelection(null); return; }
		const excerpt = clipReviewExcerpt(active.toString());
		if (!excerpt) { setSelection(null); return; }
		const a = lineOf(range.startContainer);
		const b = lineOf(range.endContainer);
		const rect = range.getBoundingClientRect();
		const host = body.getBoundingClientRect();
		setSelection({
			excerpt,
			startLine: a === null || b === null ? a ?? b : Math.min(a, b),
			endLine: a === null || b === null ? a ?? b : Math.max(a, b),
			top: rect.bottom - host.top + body.scrollTop,
			left: Math.max(0, rect.left - host.left + body.scrollLeft),
		});
	}, [canComment]);
	const takeSelection = () => {
		if (!selection) return;
		setPending({ excerpt: selection.excerpt, startLine: selection.startLine, endLine: selection.endLine });
		setSelection(null);
		window.getSelection()?.removeAllRanges();
	};
	const addSelectionComment = (body: string, andSend: boolean) => {
		if (!pending) return;
		const anchor: ReviewFileRangeAnchor = { kind: "file-range", path, startLine: pending.startLine, endLine: pending.endLine, excerpt: pending.excerpt };
		const comment: ReviewComment = { id: crypto.randomUUID(), body, createdAt: new Date().toISOString(), anchor };
		review.add(comment);
		setPending(null);
		setActiveCommentId(comment.id);
		if (andSend) send.sendOne(comment);
	};
	const rangeLabel = (anchor: Pick<ReviewFileRangeAnchor, "startLine" | "endLine">) => anchor.startLine === null
		? ""
		: anchor.endLine === null || anchor.endLine === anchor.startLine ? `:${anchor.startLine}` : `:${anchor.startLine}–${anchor.endLine}`;
	const showAside = canComment && (pending !== null || pendingRegion !== null || fileComments.length > 0 || commentMode);
	const theme = useResolvedTheme();
	const syntaxLines = useSyntaxLines(
		preview?.kind === "text" ? preview.content : null,
		path,
		!isRenderableDocPath(path) || showRaw,
	);
	// Re-search whenever the body is replaced: the async load landing, and the
	// raw/rendered toggle, both swap the text the ranges point into.
	const find = useFindInElement(bodyRef, {
		contentKey: `${preview?.kind ?? "loading"}:${showRaw}:${wrapLines}:${syntaxLines ? "syntax" : "plain"}`,
		onOpen: focusFindInput,
	});

	// Escape is staged: the find bar, then a pending comment, then comment mode,
	// then the modal.
	useEscapeKey(() => {
		if (find.isOpen) find.close();
		else if (pending || pendingRegion) { setPending(null); setPendingRegion(null); }
		else if (commentMode) setCommentMode(false);
		else onClose();
	});

	useEffect(() => {
		if (isElectrobun) return;
		let stale = false;
		void windowsHostOpenAvailable().then((available) => {
			if (!stale) setCanOpenOnWindows(available);
		});
		return () => {
			stale = true;
		};
	}, []);

	useEffect(() => {
		let stale = false;
		setPreview(null);
		setShowRaw(false);
		setImageDims(null);
		setMediaUnplayable(false);
		api.request
			.readFilePreview({ path })
			.then((result) => {
				if (!stale) setPreview(result);
			})
			.catch(() => {
				if (!stale) setPreview({ kind: "not-found" });
			});
		return () => {
			stale = true;
		};
	}, [path]);

	// Jump to the :line the link carried once the text is on screen.
	useEffect(() => {
		if (preview?.kind === "text") {
			highlightRef.current?.scrollIntoView({ block: "center" });
		}
	}, [preview]);

	const isRenderable = isRenderableDocPath(path);
	const textContent = preview?.kind === "text" ? preview.content : null;
	const slash = path.lastIndexOf("/");
	const fileName = slash >= 0 ? path.slice(slash + 1) : path;
	const dirName = slash > 0 ? path.slice(0, slash) : "";
	const showsCode = textContent !== null && (!isRenderable || showRaw);

	function renderTokens(tokens: SyntaxToken[]) {
		return tokens.map((token, i) => (token.className ? <span key={i} className={token.className}>{token.text}</span> : token.text));
	}

	function renderCode(content: string) {
		const lines = content.split("\n");
		// The span is border-box, so its `pr-3` has to be added on top of the digits.
		const gutterWidth = `calc(${String(lines.length).length}ch + 0.75rem)`;
		return (
			<div
				className={`font-mono text-xs leading-relaxed${syntaxLines ? " diff-tailwindcss-wrapper" : ""}`}
				data-testid="file-preview-code"
				data-wrap={wrapLines ? "true" : "false"}
				data-syntax={syntaxLines ? "true" : "false"}
				data-theme={syntaxLines ? theme : undefined}
			>
				{lines.map((text, i) => {
					const isTarget = line !== undefined && i + 1 === line;
					const commented = commentedLines.has(i + 1);
					return (
						<div
							key={i}
							ref={isTarget ? highlightRef : undefined}
							data-preview-line={i + 1}
							data-commented={commented ? "true" : undefined}
							className={`flex ${isTarget ? "bg-accent/10" : ""} ${commented ? "border-l-2 border-accent bg-accent/5 -ml-0.5" : ""}`}
						>
							<span
								className="shrink-0 pr-3 text-right tabular-nums text-fg-muted select-none"
								style={{ minWidth: gutterWidth }}
							>
								{i + 1}
							</span>
							<span className={`${wrapLines ? "min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"} text-fg${syntaxLines ? " diff-line-syntax-raw" : ""}`}>
								{syntaxLines?.has(i + 1) ? renderTokens(syntaxLines.get(i + 1)!) : text}
							</span>
						</div>
					);
				})}
			</div>
		);
	}

	function renderBody() {
		if (!preview) {
			return <p className="text-fg-3 text-sm p-6">{t("terminal.filePreviewLoading")}</p>;
		}
		switch (preview.kind) {
			case "text":
				return (
					<div ref={bodyRef} className="relative min-h-0 flex-1 overflow-auto p-4" onMouseUp={readSelection} onKeyUp={readSelection}>
						{selection && !pending && (
							<button
								type="button"
								data-testid="file-preview-comment-selection"
								style={{ top: selection.top + 6, left: selection.left }}
								onMouseDown={(event) => event.preventDefault()}
								onClick={takeSelection}
								className="absolute z-10 inline-flex h-8 items-center gap-1.5 rounded-md border border-accent bg-accent-fill px-3 text-xs font-semibold text-white shadow-lg transition-colors hover:bg-accent-fill-hover"
							>
								<span aria-hidden="true" className="text-sm-plus leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uf075"}</span>
								<span>{t("terminal.filePreviewCommentSelection")}</span>
							</button>
						)}
						{isRenderable && !showRaw ? (
							<MarkdownDocument
								body={toRenderableMarkdown(preview.content, path)}
								className="dev3-file-preview-md"
								imageBaseDir={dirName || null}
							/>
						) : (
							renderCode(preview.content)
						)}
						{preview.truncated && (
							<p className="mt-4 text-fg-muted text-xs">{t("terminal.filePreviewTruncated")}</p>
						)}
					</div>
				);
			case "image":
				return (
					<div className="min-h-0 flex-1 overflow-auto p-4 flex flex-col items-center justify-center gap-2">
						<div className="relative max-w-full max-h-full">
							<img
								ref={imgRef}
								src={preview.dataUrl}
								alt={fileName}
								onLoad={(e) => {
									setImageDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
									measureImage();
								}}
								className="max-w-full max-h-full object-contain rounded bg-base ring-1 ring-fg/10"
							/>
							{canComment && imageBox && (commentMode || fileComments.length > 0) && (
								<ImageRegionOverlay
									testId="file-image-review"
									box={imageBox}
									picking={commentMode}
									comments={fileComments}
									activeCommentId={activeCommentId}
									onActivate={setActiveCommentId}
									pendingRegion={pendingRegion}
									onPick={setPendingRegion}
								/>
							)}
						</div>
						<p className="text-fg-muted text-xs tabular-nums">
							{imageDims ? `${imageDims.w}×${imageDims.h} · ` : ""}
							{formatBytes(preview.size)}
						</p>
					</div>
				);
			case "media":
				return (
					<FilePreviewMedia
						key={path}
						path={path}
						fileName={fileName}
						media={preview.media}
						mime={preview.mime}
						size={preview.size}
						expanded={expanded}
						onUnplayable={markMediaUnplayable}
					/>
				);
			case "binary":
				return (
					<p className="text-fg-3 text-sm p-6">
						{t("terminal.filePreviewBinary", { size: formatBytes(preview.size) })}
					</p>
				);
			case "too-large":
				return (
					<p className="text-fg-3 text-sm p-6">
						{t("terminal.filePreviewTooLarge", { size: formatBytes(preview.size) })}
					</p>
				);
			case "directory":
				return <p className="text-fg-3 text-sm p-6">{t("terminal.filePreviewDirectory")}</p>;
			case "not-found":
				return <p className="text-fg-3 text-sm p-6">{t("terminal.filePreviewNotFound")}</p>;
		}
	}

	async function handleCopyPath() {
		const method = await writeClipboardText(path);
		if (method !== "failed") toast.success(t("terminal.filePreviewCopied"), { taskId, source: "terminal" });
	}

	async function handleCopyContent() {
		if (textContent === null) return;
		const method = await writeClipboardText(textContent);
		if (method !== "failed") toast.success(t("terminal.filePreviewContentCopied"), { taskId, source: "terminal" });
	}

	async function handleOpen(mode: "system" | "reveal") {
		try {
			await api.request.openTerminalPath({ path, mode });
		} catch (err) {
			toast.error(t("terminal.pathLinkOpenFailed", { error: String(err) }), { taskId, source: "terminal" });
		}
	}

	async function handleBrowserAction(action: () => Promise<void>) {
		try {
			await action();
		} catch (err) {
			const message = err instanceof PopupBlockedError ? t("imageViewer.popupBlocked") : t("terminal.filePreviewLinkFailed", { error: errorText(err) });
			toast.error(message, { taskId, source: "terminal" });
		}
	}

	const handleOpenOnWindows = () => handleBrowserAction(async () => {
		await api.request.openFileOnWindowsHost({ path });
		toast.success(t("terminal.filePreviewOpenedOnWindows"), { taskId, source: "terminal" });
	});

	const fileMissing = preview?.kind === "not-found";
	const isFile = !!preview && preview.kind !== "not-found" && preview.kind !== "directory";
	// A one-line notice (binary, missing, too large) — or an audio player — stays a
	// small dialog. Content hugs its own height up to the screen, or fills the screen
	// once expanded — the size changes only when the user asks, never while they read.
	const showsContent = !preview || preview.kind === "text" || preview.kind === "image" || (preview.kind === "media" && preview.media === "video" && !mediaUnplayable);
	const size = !showsContent ? "notice" : expanded ? "expanded" : "fit";
	const fitHeight = useFitHeightFloor(trapRef, size === "fit", `${path}:${size}`);
	const sizeClass = {
		notice: "w-[calc(100vw-2rem)] sm:w-[calc(100vw-4rem)] max-w-xl",
		fit: `${showAside ? "w-[min(calc(100vw-2rem),80rem)] sm:w-[min(calc(100vw-4rem),80rem)]" : "w-[min(calc(100vw-2rem),60rem)] sm:w-[min(calc(100vw-4rem),60rem)]"} max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]`,
		expanded: "w-[calc(100vw-2rem)] sm:w-[calc(100vw-4rem)] h-[calc(100dvh-2rem)] sm:h-[calc(100dvh-4rem)]",
	}[size];

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="file-preview-title"
				tabIndex={-1}
				data-size={size}
				// `min-height` outranks `max-height`, so the floor is capped to the screen itself.
				style={fitHeight ? { minHeight: `min(${fitHeight}px, calc(100dvh - 4rem))` } : undefined}
				className={`bg-overlay border border-edge rounded-2xl shadow-2xl ${sizeClass} flex flex-col outline-none`}
			>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 border-b border-edge">
					<div className="min-w-0 flex-1">
						<h2 id="file-preview-title" className="text-fg text-sm font-semibold truncate" title={path}>
							{fileName}
						</h2>
						{dirName && (
							<p className="text-fg-muted text-xs font-mono truncate" title={dirName}>
								{middleTruncate(dirName, DIR_MAX_CHARS)}
							</p>
						)}
					</div>
					{/* View controls: inline on wide screens, their own row under the title on
					    narrow ones so the close button never wraps away from the file name. */}
					<div className="order-last flex w-full flex-wrap items-center gap-2 empty:hidden sm:order-none sm:w-auto">
					{isRenderable && textContent !== null && (
						<div className="shrink-0 flex rounded-lg border border-edge overflow-hidden text-xs">
							{([false, true] as const).map((raw) => (
								<button
									key={String(raw)}
									type="button"
									onClick={() => setShowRaw(raw)}
									aria-pressed={showRaw === raw}
									className={`px-2.5 py-1 transition-[background-color,color,transform] duration-150 ease-out motion-safe:active:scale-[0.96] ${
										showRaw === raw
											? "bg-accent/10 text-accent"
											: "bg-raised text-fg-3 hover:text-fg"
									}`}
								>
									{raw ? t("terminal.filePreviewRaw") : t("terminal.filePreviewRendered")}
								</button>
							))}
						</div>
					)}
					{showsCode && (
						<button
							type="button"
							data-testid="file-preview-wrap"
							onClick={toggleWrapLines}
							aria-pressed={wrapLines}
							title={t("terminal.filePreviewWrapHint")}
							className={`shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1 text-xs transition-[background-color,color,transform] duration-150 ease-out motion-safe:active:scale-[0.96] ${
								wrapLines ? "bg-accent/10 text-accent" : "bg-raised text-fg-3 hover:text-fg"
							}`}
						>
							<span aria-hidden="true" className="text-sm leading-none" style={{ fontFamily: ICON_FONT }}>{"\u{f05b6}"}</span>
							<span>{t("terminal.filePreviewWrap")}</span>
						</button>
					)}
					{canComment && preview?.kind === "image" && (
						<button
							type="button"
							data-testid="file-preview-comment-mode"
							onClick={() => { setCommentMode((on) => !on); setPendingRegion(null); }}
							title={t("imageViewer.commentMode")}
							aria-label={t("imageViewer.commentMode")}
							aria-pressed={commentMode}
							className={`shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-[background-color,color,transform] duration-150 ease-out motion-safe:active:scale-[0.96] ${
								commentMode ? "bg-accent/10 text-accent" : "text-fg-3 hover:text-fg hover:bg-fg/8"
							}`}
						>
							<span aria-hidden="true" className="text-base leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uf075"}</span>
						</button>
					)}
					</div>
					{showsContent && (
						<button
							type="button"
							data-testid="file-preview-expand"
							onClick={toggleExpanded}
							aria-pressed={expanded}
							aria-label={expanded ? t("terminal.filePreviewRestore") : t("terminal.filePreviewExpand")}
							title={expanded ? t("terminal.filePreviewRestore") : t("terminal.filePreviewExpand")}
							className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-fg-3 hover:text-fg hover:bg-fg/8 transition-[background-color,color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
						>
							<svg key={String(expanded)} className="w-4 h-4 motion-safe:animate-[dev3-icon-swap_150ms_cubic-bezier(0.2,0,0,1)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
								<path strokeLinecap="round" strokeLinejoin="round" d={expanded
									? "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"
									: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"} />
							</svg>
						</button>
					)}
					<button
						type="button"
						onClick={onClose}
						aria-label={t("common.close")}
						className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-fg-3 hover:text-fg hover:bg-fg/8 transition-[background-color,color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
					>
						<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>
				<div className="flex min-h-0 flex-1">
				<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
					{find.isOpen && textContent !== null && (
						<FindBar
							ref={findBarRef}
							placeholder={t("terminal.filePreviewSearch")}
							query={find.query}
							onQueryChange={find.setQuery}
							matches={find.matches}
							activeIndex={find.activeIndex}
							onStep={find.step}
							onClose={find.close}
						/>
					)}
					{renderBody()}
				</div>
				{showAside && (
					<ReviewAside
						testId="file-review"
						comments={fileComments}
						review={review}
						send={send}
						activeCommentId={activeCommentId}
						onActivate={setActiveCommentId}
						labelFor={(comment, i) => comment.anchor.kind === "image-region"
							? `${i + 1} · ${regionLabel(comment.anchor)}`
							: `${i + 1} · ${fileName}${rangeLabel(comment.anchor as ReviewFileRangeAnchor)}`}
						pendingLabel={pendingRegion
							? `${fileName} · ${regionLabel(pendingRegion)}`
							: pending ? `${fileName}${rangeLabel(pending)} · ${pending.excerpt.split("\n")[0]}` : null}
						onSubmitPick={pendingRegion ? addRegionComment : addSelectionComment}
						onCancelPick={() => { setPending(null); setPendingRegion(null); }}
						hint={preview?.kind === "image" ? t("imageViewer.commentModeHint") : t("terminal.filePreviewReviewHint")}
						empty={t("terminal.filePreviewReviewEmpty")}
					/>
				)}
				</div>
				{/* Right-aligned row: the variable action (Copy content) sits leftmost so
				    its appearance never shifts the stable buttons under the cursor. */}
				<div className="flex items-center flex-wrap justify-end gap-2 px-4 py-3 border-t border-edge">
					{textContent !== null && (
						<button type="button" onClick={handleCopyContent} className={GHOST_BUTTON}>
							{t("terminal.filePreviewCopyContent")}
						</button>
					)}
					<button type="button" onClick={handleCopyPath} className={GHOST_BUTTON}>
						{t("terminal.filePreviewCopyPath")}
					</button>
					{isElectrobun && !fileMissing && (
						<>
							<button type="button" onClick={() => handleOpen("reveal")} className={GHOST_BUTTON}>
								{t("terminal.filePreviewOpenFolder")}
							</button>
							<button type="button" onClick={() => handleOpen("system")} className={GHOST_BUTTON}>
								{t("terminal.filePreviewOpenSystem")}
							</button>
						</>
					)}
					{!isElectrobun && isFile && (
						<>
							{opensInBrowserTab(path, preview) && (
								<button type="button" onClick={() => handleBrowserAction(() => openFileInNewTab(path))} className={GHOST_BUTTON}>
									{t("terminal.filePreviewOpenInTab")}
								</button>
							)}
							<button type="button" onClick={() => handleBrowserAction(() => downloadFile(path))} className={GHOST_BUTTON}>
								{t("terminal.filePreviewDownload")}
							</button>
							{canOpenOnWindows && opensSafelyOnWindows(path) && (
								<button type="button" onClick={handleOpenOnWindows} className={GHOST_BUTTON}>
									{t("terminal.filePreviewOpenOnWindows")}
								</button>
							)}
						</>
					)}
					<button type="button" onClick={onClose} className={GHOST_BUTTON}>
						{t("common.close")}
					</button>
				</div>
			</div>
		</div>
	);
}
