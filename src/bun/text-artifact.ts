import { Marked } from "marked";

/** Source formats `dev3 show-artifact` converts to HTML on the host instead of asking the agent to. */
export const TEXT_ARTIFACT_EXTS = new Set([".md", ".markdown", ".txt"]);

const SAFE_LINK = /^(?:https?:|mailto:|#)/i;
const SAFE_IMAGE = /^(?:https?:|data:image\/)/i;

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// A text artifact is text: raw HTML in the Markdown shows as written instead of
// running, and a link or image that could execute or point at a local file drops
// to its label.
const markdown = new Marked({
	gfm: true,
	renderer: {
		html({ text, block }) {
			return block ? `<p>${escapeHtml(text)}</p>` : escapeHtml(text);
		},
		link({ href, tokens }) {
			const label = this.parser.parseInline(tokens);
			return SAFE_LINK.test(href) ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${label}</a>` : label;
		},
		image({ href, text }) {
			return SAFE_IMAGE.test(href) ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}">` : escapeHtml(text);
		},
	},
});

const TEXT_ARTIFACT_STYLE = `<style data-dev3-text-artifact>
body{padding:32px 24px}
.dev3-text{max-width:72ch;margin:0 auto;font-size:15px;line-height:1.6;overflow-wrap:anywhere}
.dev3-text h1,.dev3-text h2,.dev3-text h3{line-height:1.25;margin:1.6em 0 .6em}
.dev3-text h1:first-child,.dev3-text h2:first-child{margin-top:0}
.dev3-text a{color:rgb(var(--dev3-accent))}
.dev3-text code,.dev3-text pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:rgb(var(--dev3-text-primary) / .07);border-radius:6px}
.dev3-text code{padding:.1em .35em}
.dev3-text pre{padding:12px 14px;overflow-x:auto}
.dev3-text pre code{padding:0;background:none}
.dev3-text blockquote{margin:1em 0;padding-left:1em;border-left:3px solid rgb(var(--dev3-border));color:rgb(var(--dev3-text-secondary))}
.dev3-text table{border-collapse:collapse;display:block;overflow-x:auto}
.dev3-text th,.dev3-text td{border:1px solid rgb(var(--dev3-border));padding:6px 10px;text-align:left}
.dev3-text hr{border:0;border-top:1px solid rgb(var(--dev3-border))}
.dev3-text img{max-width:100%}
.dev3-text .dev3-plain{margin:0;padding:0;background:none;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
</style>`;

/** A Markdown or plain-text source rendered as a standalone HTML page the artifact viewer shows unchanged. */
export function textArtifactHtml(source: string, ext: string, title: string): string {
	const body = ext.toLowerCase() === ".txt"
		? `<pre class="dev3-plain">${escapeHtml(source)}</pre>`
		: markdown.parse(source, { async: false }) as string;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>${TEXT_ARTIFACT_STYLE}</head><body><main class="dev3-text">${body}</main></body></html>`;
}
