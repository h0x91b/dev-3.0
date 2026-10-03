import { Marked, Renderer } from "marked";

/** Source formats `dev3 show-artifact` converts to HTML on the host instead of asking the agent to. */
export const TEXT_ARTIFACT_EXTS = new Set([".md", ".markdown", ".txt"]);

const SAFE_LINK = /^(?:https?:|mailto:|#)/i;
const SAFE_IMAGE = /^(?:https?:|data:image\/)/i;
const defaultRenderer = new Renderer();

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const headingIds = new Map<string, number>();

/** GitHub-style heading slug, so a `[Section](#section)` link in the report lands on its heading. */
function headingId(html: string): string {
	const text = html.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#39);/g, "");
	const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-") || "section";
	const seen = headingIds.get(base) ?? 0;
	headingIds.set(base, seen + 1);
	return seen ? `${base}-${seen}` : base;
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
		heading({ tokens, depth }) {
			const inner = this.parser.parseInline(tokens);
			return `<h${depth} id="${escapeHtml(headingId(inner))}">${inner}</h${depth}>\n`;
		},
		link({ href, tokens }) {
			const label = this.parser.parseInline(tokens);
			if (!SAFE_LINK.test(href)) return label;
			const target = href.startsWith("#") ? "" : ' target="_blank" rel="noopener"';
			return `<a href="${escapeHtml(href)}"${target}>${label}</a>`;
		},
		image({ href, text }) {
			return SAFE_IMAGE.test(href) ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy">` : escapeHtml(text);
		},
		table(token) {
			const table = defaultRenderer.table.call(this, token);
			return `<div class="dev3-wide dev3-table" role="region" aria-label="Table" tabindex="0">${table}</div>\n`;
		},
		code(token) {
			return defaultRenderer.code.call(this, token)
				.replace(/^<pre>/, '<pre class="dev3-wide" tabindex="0">')
				.replace(/\n<\/code><\/pre>/, "</code></pre>");
		},
	},
});

// Prose sits in a ~70-character column; tables and code blocks may grow past it
// up to the page width, staying centred on that column, and scroll beyond that.
const TEXT_ARTIFACT_STYLE = `<style data-dev3-text-artifact>
:root,[data-theme="dark"]{--md-outline:oklch(1 0 0 / .1);--md-row-alt:rgb(var(--dev3-text-primary) / .045);--md-edge:rgb(var(--dev3-text-primary) / .09);--md-row-hover:rgb(var(--dev3-accent) / .12);--md-head:rgb(var(--dev3-surface-elevated));--md-lift:0 1px 2px rgb(0 0 0 / .3),0 6px 18px -8px rgb(0 0 0 / .5)}
[data-theme="light"]{--md-outline:oklch(0 0 0 / .1);--md-edge:rgb(var(--dev3-shadow) / .22);--md-row-alt:rgb(var(--dev3-surface-base) / .55);--md-row-hover:rgb(var(--dev3-accent) / .09);--md-head:rgb(var(--dev3-surface-elevated));--md-lift:0 1px 2px rgb(var(--dev3-shadow) / .05),0 6px 18px -8px rgb(var(--dev3-shadow) / .14)}
@media(prefers-color-scheme:light){:root:not([data-theme]){--md-outline:oklch(0 0 0 / .1);--md-edge:rgb(var(--dev3-shadow) / .22);--md-row-alt:rgb(var(--dev3-surface-base) / .55);--md-row-hover:rgb(var(--dev3-accent) / .09);--md-lift:0 1px 2px rgb(var(--dev3-shadow) / .05),0 6px 18px -8px rgb(var(--dev3-shadow) / .14)}}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;-webkit-text-size-adjust:100%}
body{padding:48px 24px 72px}
::selection{background:rgb(var(--dev3-accent) / .3)}
.dev3-text{--measure:40rem;--ring:0 0 0 1px rgb(var(--dev3-border));--scroll-hint:linear-gradient(to right,rgb(var(--dev3-surface-raised)) 40%,rgb(var(--dev3-surface-raised) / 0)) left center/32px 100% no-repeat local,linear-gradient(to left,rgb(var(--dev3-surface-raised)) 40%,rgb(var(--dev3-surface-raised) / 0)) right center/32px 100% no-repeat local,radial-gradient(farthest-side at 0 50%,var(--md-edge),transparent) left center/16px 100% no-repeat scroll,radial-gradient(farthest-side at 100% 50%,var(--md-edge),transparent) right center/16px 100% no-repeat scroll,rgb(var(--dev3-surface-raised));display:grid;grid-template-columns:[wide-start] minmax(0,1fr) [content-start] minmax(0,var(--measure)) [content-end] minmax(0,1fr) [wide-end];max-width:72rem;margin:0 auto;font-size:1rem;line-height:1.65;overflow-wrap:break-word}
.dev3-text>*{grid-column:content;min-width:0;margin:0 0 1em}
.dev3-text>.dev3-wide{grid-column:wide;width:max-content;min-width:min(100%,var(--measure));max-width:100%;margin-inline:auto;margin-bottom:1.25em}
.dev3-text>:last-child{margin-bottom:0}
.dev3-text h1,.dev3-text h2,.dev3-text h3,.dev3-text h4,.dev3-text h5,.dev3-text h6{scroll-margin-top:24px;text-wrap:balance;font-weight:650;line-height:1.25;margin:1.9em 0 .55em}
.dev3-text h1{font-size:2rem;font-weight:700;line-height:1.15;letter-spacing:-.025em;margin:0 0 .6em}
.dev3-text h2{font-size:1.4375rem;letter-spacing:-.015em;padding-bottom:.35em;border-bottom:1px solid rgb(var(--dev3-border))}
.dev3-text h3{font-size:1.1875rem}
.dev3-text h4{font-size:1rem}
.dev3-text h5,.dev3-text h6{font-size:.8125rem;letter-spacing:.04em;text-transform:uppercase;color:rgb(var(--dev3-text-secondary))}
.dev3-text>:first-child{margin-top:0}
.dev3-text :is(h1,h2,h3,h4,hr)+*{margin-top:0}
.dev3-text strong{font-weight:650}
.dev3-text a{color:rgb(var(--dev3-accent));color:color-mix(in oklab,rgb(var(--dev3-accent)) 75%,rgb(var(--dev3-text-primary)));text-decoration-line:underline;text-decoration-color:color-mix(in oklab,currentColor 40%,transparent);text-decoration-thickness:from-font;text-underline-offset:.18em;text-decoration-skip-ink:auto;overflow-wrap:anywhere;border-radius:3px;transition-property:color,text-decoration-color,background-color;transition-duration:.15s;transition-timing-function:ease-out}
.dev3-text a:hover{text-decoration-color:currentColor;background:rgb(var(--dev3-accent) / .08)}
.dev3-text a:active{background:rgb(var(--dev3-accent) / .16)}
.dev3-text a:focus-visible{outline:2px solid rgb(var(--dev3-accent));outline-offset:2px}
.dev3-text .dev3-wide:focus-visible{outline:2px solid rgb(var(--dev3-accent));outline-offset:3px}
.dev3-text code,.dev3-text pre,.dev3-text kbd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dev3-text :not(pre)>code{font-size:.875em;padding:.12em .38em;border-radius:5px;background:rgb(var(--dev3-text-primary) / .07);box-shadow:inset 0 0 0 1px rgb(var(--dev3-text-primary) / .06)}
.dev3-text a code{color:inherit}
.dev3-text pre{box-sizing:border-box;padding:14px 18px;font-size:.8125rem;line-height:1.6;tab-size:4;overflow-x:auto;background:var(--scroll-hint);border-radius:10px;box-shadow:var(--ring),var(--md-lift);scrollbar-width:thin;scrollbar-color:rgb(var(--dev3-text-secondary) / .35) transparent}
.dev3-text pre code{font-size:inherit;padding:0;background:none;box-shadow:none;white-space:pre}
.dev3-text ul,.dev3-text ol{padding-left:1.5em}
.dev3-text li{margin:.3em 0;padding-left:.15em}
.dev3-text li>ul,.dev3-text li>ol{margin:.3em 0}
.dev3-text li>p{margin:.4em 0}
.dev3-text li::marker{color:rgb(var(--dev3-text-secondary) / .8)}
.dev3-text ol>li::marker{color:rgb(var(--dev3-text-secondary));font-variant-numeric:tabular-nums}
.dev3-text li:has(>input[type=checkbox]){list-style:none}
.dev3-text li>input[type=checkbox]{appearance:none;display:inline-grid;place-content:center;box-sizing:border-box;width:1.05em;height:1.05em;margin:0 .55em 0 -1.5em;vertical-align:-.15em;border-radius:4px;background:rgb(var(--dev3-surface-raised));box-shadow:inset 0 0 0 1.5px rgb(var(--dev3-text-secondary) / .8);opacity:1}
.dev3-text li>input[type=checkbox]:checked{background:rgb(var(--dev3-accent));box-shadow:none}
.dev3-text li>input[type=checkbox]:checked::before{content:"";width:.62em;height:.62em;background:rgb(var(--dev3-on-accent));mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.2l2.3 2.3 4.7-5' fill='none' stroke='%23000' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat}
.dev3-text li:has(>input[type=checkbox]:checked){color:rgb(var(--dev3-text-secondary))}
.dev3-text blockquote{padding:.75em 1.1em;color:rgb(var(--dev3-text-secondary));background:rgb(var(--dev3-accent) / .06);border-left:3px solid rgb(var(--dev3-accent) / .55);border-radius:0 8px 8px 0}
.dev3-text blockquote>:first-child{margin-top:0}
.dev3-text blockquote>:last-child{margin-bottom:0}
.dev3-text blockquote p{margin:.5em 0}
.dev3-text blockquote strong{color:rgb(var(--dev3-text-primary))}
.dev3-text hr{height:0;margin:2em 0;border:0;border-top:1px solid rgb(var(--dev3-border))}
.dev3-text img{max-width:100%;height:auto;border-radius:8px;outline:1px solid var(--md-outline);outline-offset:-1px}
.dev3-text .dev3-table{box-sizing:border-box;overflow-x:auto;background:var(--scroll-hint);border-radius:10px;box-shadow:var(--ring),var(--md-lift);scrollbar-width:thin;scrollbar-color:rgb(var(--dev3-text-secondary) / .35) transparent}
.dev3-text table{width:100%;border-collapse:collapse;font-size:.875rem;line-height:1.5;font-variant-numeric:tabular-nums}
.dev3-text th,.dev3-text td{padding:9px 14px;vertical-align:top;border-top:1px solid rgb(var(--dev3-border) / .7)}
.dev3-text :is(th,td):not([align]){text-align:start}
.dev3-text :is(th,td)+:is(th,td){border-left:1px solid rgb(var(--dev3-border) / .45)}
.dev3-text thead th{border-top:0;font-size:.8125rem;font-weight:600;color:rgb(var(--dev3-text-secondary));background:var(--md-head);vertical-align:bottom;box-shadow:inset 0 -1px 0 rgb(var(--dev3-border))}
.dev3-text tbody tr{transition:background-color .12s ease-out}
.dev3-text tbody tr:nth-child(even){background:var(--md-row-alt)}
@media (hover:hover){.dev3-text tbody tr:hover{background:var(--md-row-hover)}}
.dev3-text td code{overflow-wrap:anywhere}
.dev3-text .dev3-plain{margin:0;padding:0;background:none;box-shadow:none;border-radius:0;white-space:pre-wrap;font-size:.875rem;line-height:1.6}
@media (max-width:640px){body{padding:28px 16px 48px}.dev3-text{line-height:1.6}.dev3-text h1{font-size:1.625rem}.dev3-text h2{font-size:1.25rem}.dev3-text pre{padding:12px 14px}.dev3-text th,.dev3-text td{padding:8px 10px}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media (forced-colors:active){.dev3-text .dev3-table,.dev3-text pre{border:1px solid CanvasText}.dev3-text li>input[type=checkbox]{appearance:auto}}
</style>`;

/** A Markdown or plain-text source rendered as a standalone HTML page the artifact viewer shows unchanged. */
export function textArtifactHtml(source: string, ext: string, title: string): string {
	headingIds.clear();
	const body = ext.toLowerCase() === ".txt"
		? `<pre class="dev3-plain">${escapeHtml(source)}</pre>`
		: markdown.parse(source, { async: false }) as string;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>${TEXT_ARTIFACT_STYLE}</head><body><main class="dev3-text">${body}</main></body></html>`;
}
