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

const mermaidPlugin = createMermaidPlugin();
const plugins = { mermaid: mermaidPlugin };
const documentRemarkPlugins = [...Object.values(defaultRemarkPlugins), remarkProtectRelativeUrls];
const commentRemarkPlugins = [...documentRemarkPlugins, remarkBreaks];
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
}

export function MarkdownContent({
	body,
	document: isDocument = false,
	imageBaseDir,
	imageRootDir,
	rendererConfig,
	sourceLines,
}: MarkdownContentProps) {
	const lineOffset = sourceLines?.lineOffset ?? null;
	const commentedLines = sourceLines?.commentedLines ?? null;
	const components = useMemo<Components>(() => ({
		...(lineOffset === null ? {} : createSourceLineComponents(lineOffset, commentedLines)),
		a: ({ node: _node, href, ...props }) => (
			<ExternalMarkdownLink {...props} href={safeLinkHref(unprotect(href))} />
		),
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
	}), [imageBaseDir, imageRootDir, lineOffset, commentedLines]);

	// Streamdown's memo comparator ignores `components`, so a changed set of
	// commented lines only repaints through the key.
	const commentedSignature = commentedLines?.size
		? [...commentedLines].sort((a, b) => a - b).join(",")
		: "";

	return (
		<Streamdown
			key={`${rendererConfig.theme}:${isDocument}:${imageBaseDir ?? ""}:${imageRootDir ?? ""}:${lineOffset ?? ""}:${commentedSignature}`}
			mode="static"
			dir="auto"
			className={`space-y-0${isDocument ? " dev3-md-doc" : ""}`}
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
			remarkPlugins={isDocument ? documentRemarkPlugins : commentRemarkPlugins}
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
