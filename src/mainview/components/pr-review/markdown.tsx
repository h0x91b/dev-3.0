import { useMemo, type ComponentProps } from "react";
import { createMermaidPlugin } from "@streamdown/mermaid";
import type { MermaidConfig } from "mermaid";
import remarkBreaks from "remark-breaks";
import {
	Streamdown,
	defaultRemarkPlugins,
	type Components,
	type MermaidErrorComponentProps,
} from "streamdown";
import { useResolvedTheme } from "../../hooks/useResolvedTheme";
import { MarkdownImage, MarkdownImageProvider } from "./markdown-images";
import { createSourceLineComponents } from "./markdown-source-lines";
import { remarkProtectRelativeUrls, safeLinkHref, unprotect } from "./markdown-urls";
import { remarkBareTaskRefs, remarkHtmlAsText } from "./markdown-task-text";
import { parseRefUri } from "../../../shared/task-refs";
import { TaskRefLink, TaskRefScopeContext } from "../TaskRefText";

const mermaidPlugin = createMermaidPlugin();
const plugins = { mermaid: mermaidPlugin };
const documentRemarkPlugins = [...Object.values(defaultRemarkPlugins), remarkProtectRelativeUrls];
const commentRemarkPlugins = [...documentRemarkPlugins, remarkBreaks];
// Plain-text authors: HTML stays literal and bare refs become links before the
// URL protector runs, so those links ride its reference token.
const taskTextRemarkPlugins = [
	...Object.values(defaultRemarkPlugins),
	remarkHtmlAsText,
	remarkBareTaskRefs,
	remarkProtectRelativeUrls,
	remarkBreaks,
];
const allowedTags = {
	details: [],
	summary: [],
	ins: [],
	input: ["type", "checked", "disabled"],
};

function tokenColor(token: string): string | undefined {
	const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
	if (!value) return undefined;

	const channels = value.split(/\s+/);
	if (channels.length === 3 && channels.every((channel) => /^\d+(?:\.\d+)?%?$/.test(channel))) {
		return `rgb(${channels.join(", ")})`;
	}
	return value;
}

function createMermaidConfig(): MermaidConfig {
	const tokens: Record<string, string> = {
		background: "--surface-base",
		primaryColor: "--surface-elevated",
		primaryTextColor: "--text-primary",
		primaryBorderColor: "--border-active",
		secondaryColor: "--surface-raised",
		secondaryTextColor: "--text-primary",
		secondaryBorderColor: "--border-default",
		tertiaryColor: "--surface-overlay",
		tertiaryTextColor: "--text-primary",
		tertiaryBorderColor: "--border-active",
		lineColor: "--text-tertiary",
		textColor: "--text-primary",
		mainBkg: "--surface-elevated",
		nodeBorder: "--border-active",
		clusterBkg: "--surface-raised",
		clusterBorder: "--border-default",
		edgeLabelBackground: "--surface-base",
		titleColor: "--text-primary",
	};
	const themeVariables = Object.fromEntries(
		Object.entries(tokens).flatMap(([name, token]) => {
			const color = tokenColor(token);
			return color ? [[name, color]] : [];
		}),
	);

	return {
		startOnLoad: false,
		securityLevel: "strict",
		suppressErrorRendering: true,
		theme: "base",
		look: "neo",
		htmlLabels: true,
		fontFamily: getComputedStyle(document.body).fontFamily || undefined,
		sequence: {
			useMaxWidth: false,
			wrap: true,
		},
		themeVariables,
	};
}

interface MarkdownRendererConfig {
	mermaid: MermaidConfig;
	theme: "dark" | "light";
}

export function useMarkdownRendererConfig(): MarkdownRendererConfig {
	const theme = useResolvedTheme();
	const mermaid = useMemo(createMermaidConfig, [theme]);
	return useMemo(() => ({ mermaid, theme }), [mermaid, theme]);
}

function MermaidSourceFallback({ chart }: MermaidErrorComponentProps) {
	return (
		<pre data-mermaid-state="error">
			<code className="language-mermaid">{chart}</code>
		</pre>
	);
}

function ExternalMarkdownLink({ children, ...props }: ComponentProps<"a">) {
	return (
		<a {...props} target="_blank" rel="noopener noreferrer">
			{children}
		</a>
	);
}

export interface MarkdownSourceLines {
	/** 1-based file line the rendered source starts on (whole documents pass 1). */
	lineOffset: number;
	/** File lines carrying a review comment, so their block is marked in place. */
	commentedLines?: ReadonlySet<number> | null;
}

interface MarkdownContentProps {
	body: string;
	document?: boolean;
	imageBaseDir?: string | null;
	imageRootDir?: string | null;
	rendererConfig: MarkdownRendererConfig;
	/** Stamps every prose block with its source line range, for selection comments. */
	sourceLines?: MarkdownSourceLines | null;
	/** Marks body rows of a table with `data-diff-kind`, one entry per row after the header. */
	tableRows?: readonly string[];
	/** Agent-written plain text (a task description): literal HTML, bare `seq:N` refs linked. */
	taskText?: boolean;
}

/** Lines the header and delimiter rows take before the first body row. */
const TABLE_HEAD_LINES = 2;

export function MarkdownContent({
	body,
	document: isDocument = false,
	imageBaseDir,
	imageRootDir,
	rendererConfig,
	sourceLines,
	tableRows,
	taskText = false,
}: MarkdownContentProps) {
	const lineOffset = sourceLines?.lineOffset ?? null;
	const commentedLines = sourceLines?.commentedLines ?? null;
	const rowSignature = tableRows?.join(",") ?? "";
	const components = useMemo<Components>(() => ({
		...(lineOffset === null ? {} : createSourceLineComponents(lineOffset, commentedLines)),
		...(tableRows && {
			tr: ({ node, className, ...props }) => {
				const line = node?.position?.start.line;
				const kind = line === undefined ? undefined : tableRows[line - TABLE_HEAD_LINES - 1];
				return <tr {...props} className={`border-border ${className ?? ""}`} data-streamdown="table-row" data-diff-kind={kind} />;
			},
		}),
		a: ({ node: _node, href, children, ...props }) => {
			const target = unprotect(href);
			const taskRef = target ? parseRefUri(target) : null;
			if (taskRef) return <TaskRefLink taskRef={taskRef}>{children}</TaskRefLink>;
			return <ExternalMarkdownLink {...props} href={safeLinkHref(target)}>{children}</ExternalMarkdownLink>;
		},
		img: ({ node: _node, src, ...props }) => (
			<MarkdownImage
				{...props}
				src={unprotect(src)}
				imageBaseDir={imageBaseDir}
				imageRootDir={imageRootDir}
			/>
		),
		input: ({ node: _node, ...props }) => <input {...props} disabled />,
		strong: ({ node: _node, ...props }) => <strong {...props} />,
	}), [imageBaseDir, imageRootDir, lineOffset, commentedLines, rowSignature]);

	// Streamdown's memo comparator ignores `components`, so a changed set of
	// commented lines or table row kinds only repaints through the key.
	const commentedSignature = commentedLines?.size
		? [...commentedLines].sort((a, b) => a - b).join(",")
		: "";

	return (
		<Streamdown
			key={`${rendererConfig.theme}:${isDocument}:${taskText}:${imageBaseDir ?? ""}:${imageRootDir ?? ""}:${lineOffset ?? ""}:${commentedSignature}:${rowSignature}`}
			mode="static"
			dir="auto"
			// `space-y-0` zeroes `margin-top` on every block but the first, and it
			// outranks the stylesheet — a document needs its own top margins to put
			// more air above a heading than below it, so it opts out.
			// A task description keeps Streamdown's default block rhythm (`space-y-4`).
			className={isDocument ? "dev3-md-doc" : taskText ? undefined : "space-y-0"}
			components={components}
			controls={false}
			lineNumbers={false}
			// Link safety off: it interposes a confirmation modal on every external
			// link. Streamdown's URL hardener still runs; on top of it `unprotect`
			// and `safeLinkHref` in `markdown-urls.ts` decide what may reach `href`.
			linkSafety={{ enabled: false }}
			allowedTags={allowedTags}
			plugins={plugins}
			mermaid={{ config: rendererConfig.mermaid, errorComponent: MermaidSourceFallback }}
			remarkPlugins={taskText ? taskTextRemarkPlugins : isDocument ? documentRemarkPlugins : commentRemarkPlugins}
		>
			{body}
		</Streamdown>
	);
}

export function MarkdownDocument({ body, className, imageBaseDir, imageRootDir, sourceLines }: {
	body: string;
	className?: string;
	/** Directory of the document, so repo-relative images can be read off disk. */
	imageBaseDir?: string | null;
	/** Checkout root, for root-relative image paths (`/docs/shot.png`). */
	imageRootDir?: string | null;
	/** Set to make prose blocks addressable by source line (selection comments). */
	sourceLines?: MarkdownSourceLines | null;
}) {
	const rendererConfig = useMarkdownRendererConfig();
	return (
		<div
			className={`dev3-pr-md min-w-0 text-sm leading-relaxed text-fg${className ? ` ${className}` : ""}`}
			data-testid="markdown-document"
		>
			<MarkdownImageProvider resetKey={body}>
				<MarkdownContent
					body={body}
					document
					imageBaseDir={imageBaseDir}
					imageRootDir={imageRootDir}
					rendererConfig={rendererConfig}
					sourceLines={sourceLines}
				/>
			</MarkdownImageProvider>
		</div>
	);
}

export function CommentMarkdown({ body }: { body: string }) {
	const rendererConfig = useMarkdownRendererConfig();
	return (
		<div
			className="dev3-pr-md min-w-0 text-sm leading-relaxed text-fg"
			data-testid="pr-comment-markdown"
		>
			<MarkdownContent body={body} rendererConfig={rendererConfig} />
		</div>
	);
}

/**
 * A task description as Markdown: comment-sized type, line breaks kept as typed,
 * raw HTML shown literally, and every `seq:N` / `pr:N` a reference chip scoped
 * to the task's own project.
 */
export function TaskDescriptionMarkdown({ body, projectId, taskId }: { body: string; projectId: string; taskId: string }) {
	const rendererConfig = useMarkdownRendererConfig();
	const scope = useMemo(() => ({ projectId, taskId }), [projectId, taskId]);
	return (
		<TaskRefScopeContext.Provider value={scope}>
			<div
				className="dev3-pr-md dev3-task-desc-md min-w-0 text-sm leading-relaxed text-fg-2"
				data-testid="task-description-markdown"
			>
				<MarkdownContent body={body} rendererConfig={rendererConfig} taskText />
			</div>
		</TaskRefScopeContext.Provider>
	);
}
