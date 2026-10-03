import { Marked, Renderer } from "marked";

/** Source formats `dev3 show-artifact` converts to HTML on the host instead of asking the agent to. */
export const TEXT_ARTIFACT_EXTS = new Set([".md", ".markdown", ".txt"]);

const SAFE_LINK = /^(?:https?:|mailto:|#)/i;
const SAFE_IMAGE = /^(?:https?:|data:image\/)/i;
const defaultRenderer = new Renderer();

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// A text artifact is text: raw HTML in the Markdown shows as written instead of
// running, and a link or image that could execute or point at a local file drops
// to its label. Tables and code blocks scroll on their own, so they take focus
// for keyboard scrolling.
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
			return SAFE_IMAGE.test(href) ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy">` : escapeHtml(text);
		},
		table(token) {
			const table = defaultRenderer.table.call(this, token);
			return `<div class="dev3-wide dev3-table" role="region" aria-label="Table" tabindex="0">${table}</div>\n`;
		},
		code(token) {
			return defaultRenderer.code.call(this, token).replace(/^<pre>/, '<pre class="dev3-wide" tabindex="0">');
		},
	},
});

// Prose sits in a ~70-character column; tables and code blocks may grow past it
// up to the page width, staying centred on that column, and scroll beyond that.
const TEXT_ARTIFACT_STYLE = `<style data-dev3-text-artifact>
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{padding:48px 24px 72px}
.dev3-text{--measure:40rem;display:grid;grid-template-columns:[wide-start] minmax(0,1fr) [content-start] minmax(0,var(--measure)) [content-end] minmax(0,1fr) [wide-end];max-width:72rem;margin:0 auto;font-size:1rem;line-height:1.65;overflow-wrap:break-word}
.dev3-text>*{grid-column:content;min-width:0;margin:0 0 1em}
.dev3-text>.dev3-wide{grid-column:wide;width:max-content;min-width:min(100%,var(--measure));max-width:100%;margin-inline:auto;margin-bottom:1.25em}
.dev3-text>:last-child{margin-bottom:0}
.dev3-text h1,.dev3-text h2,.dev3-text h3,.dev3-text h4,.dev3-text h5,.dev3-text h6{text-wrap:balance;font-weight:650;line-height:1.25;margin:1.9em 0 .55em}
.dev3-text h1{font-size:2rem;font-weight:700;line-height:1.15;letter-spacing:-.025em;margin:0 0 .6em}
.dev3-text h2{font-size:1.4375rem;letter-spacing:-.015em;padding-bottom:.35em;border-bottom:1px solid rgb(var(--dev3-border))}
.dev3-text h3{font-size:1.1875rem}
.dev3-text h4{font-size:1rem}
.dev3-text h5,.dev3-text h6{font-size:.8125rem;letter-spacing:.04em;text-transform:uppercase;color:rgb(var(--dev3-text-secondary))}
.dev3-text>:first-child{margin-top:0}
.dev3-text :is(h1,h2,h3,h4,hr)+*{margin-top:0}
.dev3-text strong{font-weight:650}
.dev3-text a{color:rgb(var(--dev3-accent));color:color-mix(in oklab,rgb(var(--dev3-accent)) 75%,rgb(var(--dev3-text-primary)));text-decoration-line:underline;text-decoration-color:rgb(var(--dev3-accent) / .45);text-decoration-thickness:from-font;text-underline-offset:.18em;overflow-wrap:anywhere}
.dev3-text a:hover{text-decoration-color:currentColor}
.dev3-text a:focus-visible,.dev3-text .dev3-wide:focus-visible{outline:2px solid rgb(var(--dev3-accent));outline-offset:2px;border-radius:4px}
.dev3-text code,.dev3-text pre,.dev3-text kbd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dev3-text :not(pre)>code{font-size:.875em;padding:.12em .38em;border-radius:5px;background:rgb(var(--dev3-text-primary) / .08)}
.dev3-text pre{box-sizing:border-box;padding:14px 18px;font-size:.8125rem;line-height:1.6;tab-size:4;overflow-x:auto;background:rgb(var(--dev3-surface-raised));border:1px solid rgb(var(--dev3-border));border-radius:10px}
.dev3-text pre code{font-size:inherit;padding:0;background:none;white-space:pre}
.dev3-text ul,.dev3-text ol{padding-left:1.5em}
.dev3-text li{margin:.3em 0}
.dev3-text li>ul,.dev3-text li>ol{margin:.3em 0}
.dev3-text li>p{margin:.4em 0}
.dev3-text li::marker{color:rgb(var(--dev3-text-muted))}
.dev3-text ol>li::marker{color:rgb(var(--dev3-text-secondary));font-variant-numeric:tabular-nums}
.dev3-text li:has(>input[type=checkbox]){list-style:none}
.dev3-text li>input[type=checkbox]{margin:0 .5em 0 -1.4em;vertical-align:-.1em;accent-color:rgb(var(--dev3-accent))}
.dev3-text blockquote{padding:.75em 1.1em;color:rgb(var(--dev3-text-secondary));background:rgb(var(--dev3-accent) / .06);border-left:3px solid rgb(var(--dev3-accent) / .55);border-radius:0 8px 8px 0}
.dev3-text blockquote>:first-child{margin-top:0}
.dev3-text blockquote>:last-child{margin-bottom:0}
.dev3-text blockquote p{margin:.5em 0}
.dev3-text hr{height:0;margin:2.5em 0;border:0;border-top:1px solid rgb(var(--dev3-border))}
.dev3-text img{max-width:100%;height:auto;border-radius:8px}
.dev3-text .dev3-table{box-sizing:border-box;overflow-x:auto;border:1px solid rgb(var(--dev3-border));border-radius:10px}
.dev3-text table{width:100%;border-collapse:collapse;font-size:.875rem;line-height:1.5;font-variant-numeric:tabular-nums}
.dev3-text th,.dev3-text td{padding:9px 14px;vertical-align:top;border-top:1px solid rgb(var(--dev3-border))}
.dev3-text :is(th,td):not([align]){text-align:start}
.dev3-text :is(th,td)+:is(th,td){border-left:1px solid rgb(var(--dev3-border) / .55)}
.dev3-text thead th{border-top:0;font-weight:600;color:rgb(var(--dev3-text-secondary));background:rgb(var(--dev3-surface-raised));vertical-align:bottom}
.dev3-text tbody tr:nth-child(even){background:rgb(var(--dev3-text-primary) / .035)}
.dev3-text td code{overflow-wrap:anywhere}
.dev3-text .dev3-plain{margin:0;padding:0;background:none;border:0;white-space:pre-wrap;font-size:.875rem;line-height:1.6}
@media (max-width:640px){body{padding:28px 16px 48px}.dev3-text{line-height:1.6}.dev3-text h1{font-size:1.625rem}.dev3-text h2{font-size:1.25rem}.dev3-text pre{padding:12px 14px}.dev3-text th,.dev3-text td{padding:8px 10px}}
</style>`;

/** A Markdown or plain-text source rendered as a standalone HTML page the artifact viewer shows unchanged. */
export function textArtifactHtml(source: string, ext: string, title: string): string {
	const body = ext.toLowerCase() === ".txt"
		? `<pre class="dev3-plain">${escapeHtml(source)}</pre>`
		: markdown.parse(source, { async: false }) as string;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>${TEXT_ARTIFACT_STYLE}</head><body><main class="dev3-text">${body}</main></body></html>`;
}
