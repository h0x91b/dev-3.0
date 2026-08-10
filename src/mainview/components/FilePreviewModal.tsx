import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { api, isElectrobun } from "../rpc";
import { toast } from "../toast";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { formatBytes } from "../utils/formatBytes";
import { writeClipboardText } from "../utils/clipboard-write";
import type { FilePreviewResult } from "../../shared/types";
import { MarkdownDocument } from "./pr-review/markdown";

interface FilePreviewModalProps {
	path: string;
	/** 1-based line to scroll to and highlight (from a :line[:col] link suffix). */
	line?: number;
	/** Task the path was clicked in, so this modal's toasts name their origin. */
	taskId?: string;
	onClose: () => void;
}

const DIR_MAX_CHARS = 90;

function middleTruncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const half = Math.floor((max - 1) / 2);
	return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

const GHOST_BUTTON =
	"px-3 py-1.5 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated " +
	"transition-[background-color,color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]";

/**
 * In-app preview for a file path Cmd/Ctrl+Clicked in terminal output — the
 * "Preview in dev3" mode of the File path click action setting, and the only
 * mode in browser/remote sessions (host-side open would be invisible there).
 */
export default function FilePreviewModal({ path, line, taskId, onClose }: FilePreviewModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	useEscapeKey(onClose);
	const [preview, setPreview] = useState<FilePreviewResult | null>(null);
	const [showRaw, setShowRaw] = useState(false);
	const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null);
	const highlightRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		let stale = false;
		setPreview(null);
		setShowRaw(false);
		setImageDims(null);
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

	const isMarkdown = /\.(md|markdown)$/i.test(path);
	const textContent = preview?.kind === "text" ? preview.content : null;
	const slash = path.lastIndexOf("/");
	const fileName = slash >= 0 ? path.slice(slash + 1) : path;
	const dirName = slash > 0 ? path.slice(0, slash) : "";

	function renderCode(content: string) {
		const lines = content.split("\n");
		const gutterWidth = `${String(lines.length).length}ch`;
		return (
			<div className="font-mono text-xs leading-relaxed">
				{lines.map((text, i) => {
					const isTarget = line !== undefined && i + 1 === line;
					return (
						<div
							key={i}
							ref={isTarget ? highlightRef : undefined}
							className={`flex ${isTarget ? "bg-accent/10" : ""}`}
						>
							<span
								className="shrink-0 pr-3 text-right tabular-nums text-fg-muted select-none"
								style={{ minWidth: gutterWidth }}
							>
								{i + 1}
							</span>
							<span className="whitespace-pre text-fg">{text}</span>
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
					<div className="min-h-0 flex-1 overflow-auto p-4">
						{isMarkdown && !showRaw ? (
							<MarkdownDocument
								body={preview.content}
								className="max-w-[70ch] mx-auto"
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
						<img
							src={preview.dataUrl}
							alt={fileName}
							onLoad={(e) =>
								setImageDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
							}
							className="max-w-full max-h-full object-contain rounded bg-base ring-1 ring-fg/10"
						/>
						<p className="text-fg-muted text-xs tabular-nums">
							{imageDims ? `${imageDims.w}×${imageDims.h} · ` : ""}
							{formatBytes(preview.size)}
						</p>
					</div>
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

	const fileMissing = preview?.kind === "not-found";

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
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[min(56rem,92vw)] max-h-[85vh] flex flex-col outline-none"
			>
				<div className="flex items-center gap-3 px-4 py-3 border-b border-edge">
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
					{isMarkdown && textContent !== null && (
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
				{renderBody()}
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
					<button type="button" onClick={onClose} className={GHOST_BUTTON}>
						{t("common.close")}
					</button>
				</div>
			</div>
		</div>
	);
}
