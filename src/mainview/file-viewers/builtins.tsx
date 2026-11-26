import type { Context, Fiber } from "cordis";
import { useT } from "../i18n";
import type { BuiltinPlugin } from "../plugins/runtime";
import { formatBytes } from "../utils/formatBytes";
import type { SyntaxToken } from "../components/file-preview-syntax";
import FilePreviewMedia from "../components/FilePreviewMedia";
import { MarkdownDocument } from "../components/pr-review/markdown";
import { isRenderableDocPath, toRenderableMarkdown } from "../components/pr-review/markdown-files";
// Defines the slot before the plugin injects it.
import "./registry";
import type { FileViewerItem, FileViewerProps } from "./registry";

function renderTokens(tokens: SyntaxToken[]) {
	return tokens.map((token, i) => (token.className ? <span key={i} className={token.className}>{token.text}</span> : token.text));
}

function MarkdownViewer({ preview, path, dirName }: FileViewerProps) {
	if (preview.kind !== "text") return null;
	return <MarkdownDocument body={toRenderableMarkdown(preview.content, path)} className="dev3-file-preview-md" imageBaseDir={dirName || null} />;
}

/** Numbered source lines; `data-preview-line` is what a selection's line range is read from. */
function CodeViewer({ preview, line, targetLineRef, wrapLines, syntaxLines, theme, commentedLines }: FileViewerProps) {
	if (preview.kind !== "text") return null;
	const lines = preview.content.split("\n");
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
						ref={isTarget ? targetLineRef : undefined}
						data-preview-line={i + 1}
						data-commented={commented ? "true" : undefined}
						className={`flex ${isTarget ? "bg-accent/10" : ""} ${commented ? "border-l-2 border-accent bg-accent/5 -ml-0.5" : ""}`}
					>
						<span className="shrink-0 pr-3 text-right tabular-nums text-fg-muted select-none" style={{ minWidth: gutterWidth }}>
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

function ImageViewer({ preview, fileName, imageRef, onImageLoad }: FileViewerProps) {
	if (preview.kind !== "image") return null;
	return (
		<img
			ref={imageRef}
			src={preview.dataUrl}
			alt={fileName}
			onLoad={(e) => onImageLoad(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
			className="max-w-full max-h-full object-contain rounded bg-base ring-1 ring-fg/10"
		/>
	);
}

function MediaViewer({ preview, path, fileName, expanded, onMediaUnplayable }: FileViewerProps) {
	if (preview.kind !== "media") return null;
	return (
		<FilePreviewMedia
			key={path}
			path={path}
			fileName={fileName}
			media={preview.media}
			mime={preview.mime}
			size={preview.size}
			expanded={expanded}
			onUnplayable={onMediaUnplayable}
		/>
	);
}

/** One line in place of content: the file cannot be shown, and says why. */
function NoticeViewer({ preview }: FileViewerProps) {
	const t = useT();
	const size = "size" in preview ? formatBytes(preview.size) : "";
	const text = {
		binary: () => t("terminal.filePreviewBinary", { size }),
		"too-large": () => t("terminal.filePreviewTooLarge", { size }),
		directory: () => t("terminal.filePreviewDirectory"),
		"not-found": () => t("terminal.filePreviewNotFound"),
		"outside-allowed": () => t("terminal.filePreviewOutsideAllowed"),
	}[preview.kind as "binary" | "too-large" | "directory" | "not-found" | "outside-allowed"];
	return text ? <p className="text-fg-3 text-sm p-6">{text()}</p> : null;
}

const NOTICE_KINDS = new Set(["binary", "too-large", "directory", "not-found", "outside-allowed"]);

export const BUILTIN_FILE_VIEWERS: FileViewerItem[] = [
	{ id: "builtin:markdown", order: 10, matches: ({ preview, path, showRaw }) => preview.kind === "text" && isRenderableDocPath(path) && !showRaw, component: MarkdownViewer },
	{ id: "builtin:code", order: 20, matches: ({ preview }) => preview.kind === "text", component: CodeViewer },
	{ id: "builtin:image", order: 30, matches: ({ preview }) => preview.kind === "image", component: ImageViewer },
	{ id: "builtin:media", order: 40, matches: ({ preview }) => preview.kind === "media", component: MediaViewer },
	{ id: "builtin:notice", order: 50, matches: ({ preview }) => NOTICE_KINDS.has(preview.kind), component: NoticeViewer },
];

const FILE_VIEWERS_BUILTIN_ID = "builtin:file-viewers";

/** Required: every preview kind needs a body, and a crashed extension viewer falls back to these. */
export const BUILTIN_FILE_VIEWERS_PLUGIN: BuiltinPlugin = {
	id: FILE_VIEWERS_BUILTIN_ID,
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: FILE_VIEWERS_BUILTIN_ID,
			inject: ["fileViewers"],
			apply(pluginCtx: Context) {
				for (const viewer of BUILTIN_FILE_VIEWERS) pluginCtx.fileViewers.register(viewer);
			},
		});
	},
};
