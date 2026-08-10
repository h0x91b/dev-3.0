import { useMemo } from "react";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { useDiskMarkdownImages } from "./markdown-images";

// PR comments are arbitrary third-party content, so the pipeline must be
// XSS-safe by construction: marked renders GFM to HTML, sanitize-html strips
// everything outside this allowlist. sanitize-html is parser-based (htmlparser2),
// so it behaves identically in the app webview and in the happy-dom test
// environment — DOMPurify was rejected because it silently fails to sanitize
// under happy-dom (see decisions/2026/07/19/pr-comment-markdown-sanitizer.md).
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "details", "summary", "ins", "del", "sup", "sub", "input"],
	allowedAttributes: {
		a: ["href", "name", "target", "rel"],
		img: ["src", "alt", "title", "width", "height"],
		// GFM task lists render as checkbox inputs; keep them visual-only.
		input: ["type", "checked", "disabled"],
		// A rich-diff fragment can start mid-list, so numbering must survive.
		ol: ["start"],
		td: ["align"],
		th: ["align"],
	},
	allowedSchemes: ["http", "https", "mailto"],
	disallowedTagsMode: "discard",
	transformTags: {
		// Every PR comment link opens externally and never navigates the app webview.
		a: (tagName, attribs) => ({
			tagName,
			attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" },
		}),
		input: (tagName, attribs) => ({
			tagName,
			attribs: { ...attribs, disabled: "disabled" },
		}),
	},
};

/** Render GitHub-flavored markdown from an arbitrary PR comment into safe HTML. */
export function renderCommentMarkdown(body: string): string {
	const html = marked.parse(body, { gfm: true, breaks: true, async: false });
	return sanitizeHtml(html, SANITIZE_OPTIONS);
}

/** Render a markdown *document* (e.g. a .md file) into safe HTML. Same sanitize
 * allowlist as comments, but `breaks: false` — in documents a single newline is
 * a soft wrap, not a <br> (GitHub renders files vs comments the same way). */
export function renderMarkdownDocument(body: string): string {
	const html = marked.parse(body, { gfm: true, breaks: false, async: false });
	return sanitizeHtml(html, SANITIZE_OPTIONS);
}

export function MarkdownDocument({ body, className, imageBaseDir, imageRootDir }: {
	body: string;
	className?: string;
	/** Directory of the document, so repo-relative images can be read off disk. */
	imageBaseDir?: string | null;
	/** Checkout root, for root-relative image paths (`/docs/shot.png`). */
	imageRootDir?: string | null;
}) {
	const rendered = useMemo(() => renderMarkdownDocument(body), [body]);
	const html = useDiskMarkdownImages(rendered, imageBaseDir, imageRootDir);
	return (
		<div
			className={`dev3-pr-md dev3-md-doc min-w-0 text-sm leading-relaxed text-fg${className ? ` ${className}` : ""}`}
			data-testid="markdown-document"
			// eslint-disable-next-line react/no-danger -- sanitized above via sanitize-html
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

export function CommentMarkdown({ body }: { body: string }) {
	const html = useMemo(() => renderCommentMarkdown(body), [body]);
	return (
		<div
			className="dev3-pr-md min-w-0 text-sm leading-relaxed text-fg"
			data-testid="pr-comment-markdown"
			// eslint-disable-next-line react/no-danger -- sanitized above via sanitize-html
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
