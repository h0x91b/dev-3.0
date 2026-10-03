import { describe, expect, it } from "vitest";
import { textArtifactHtml } from "../text-artifact";

function render(markdown: string): string {
	const html = textArtifactHtml(markdown, ".md", "t");
	return html.slice(html.indexOf('<main class="dev3-text">'));
}

describe("textArtifactHtml — Markdown extras", () => {
	it("numbers footnotes by first reference, links both ways and leaves unknown labels as text", () => {
		const html = render(["Claim[^a], again[^a], other[^b], missing[^zz].", "", "[^b]: Second", "    continued.", "[^a]: First **note**."].join("\n"));

		expect(html).toContain('<a href="#fn-1" id="fnref-1"');
		expect(html).toContain('<a href="#fn-1" id="fnref-1-2"');
		expect(html).toContain('<a href="#fn-2" id="fnref-2"');
		expect(html).toContain("missing[^zz].");
		expect(html).toContain('<li id="fn-1">First <strong>note</strong>. <a class="dev3-fnback" href="#fnref-1"');
		expect(html).toContain('<li id="fn-2">Second continued.');
		expect(html).not.toContain("[^b]:");
	});

	it("starts footnote numbering afresh on every render", () => {
		render("One[^x]\n\n[^x]: note");
		expect(render("Two[^y]\n\n[^y]: note")).toContain('href="#fn-1"');
	});

	it("rebuilds <details>/<summary> without any attribute and keeps everything else inert", () => {
		const html = render([
			'<details open onclick="evil()">',
			"<summary onmouseover=x>Click **me** <img src=x onerror=alert(1)></summary>",
			"",
			"Body",
			"",
			"</details>",
			"",
			'<details data-open="1"><summary>closed</summary>inline <script>bad()</script></details>',
		].join("\n"));

		expect(html).toContain("<details open>\n<summary>Click <strong>me</strong> &lt;img src=x onerror=alert(1)&gt;</summary>");
		expect(html).toContain("<details><summary>closed</summary>inline &lt;script&gt;bad()&lt;/script&gt;</details>");
		expect(html).not.toMatch(/onclick|onmouseover|data-open|<img|<script/);
	});

	it("turns GitHub alert quotes into callouts and leaves ordinary quotes alone", () => {
		const html = render("> [!WARNING]\n> Careful **now**\n\n> [!NOTE] same line\n\n> plain");

		expect(html).toContain('<div class="dev3-alert dev3-alert-warning" role="note"><p class="dev3-alert-title">Warning</p>\n<p>Careful <strong>now</strong></p>');
		expect(html).toContain("<blockquote>\n<p>[!NOTE] same line</p>");
		expect(html).toContain("<blockquote>\n<p>plain</p>");
	});

	it("resolves reference links with their title", () => {
		expect(render('See [docs][d].\n\n[d]: https://dev3.h0x91b.com "The docs"')).toContain(
			'<a href="https://dev3.h0x91b.com" title="The docs" target="_blank" rel="noopener">docs</a>',
		);
	});

	it("wraps code line by line, keeping a leading tab for copy, but leaves a box-drawing diagram unwrapped", () => {
		const html = render("```ts\n\tconst a = 1;\n\nb\n```\n\n```\n├─ tree\n```");

		expect(html).toContain('<span class="dev3-line" style="--in:4ch"><span class="dev3-indent">\t</span>const a = 1;\n</span><span class="dev3-line">\n</span><span class="dev3-line">b\n</span>');
		expect(html).toContain('<pre class="dev3-wide dev3-nowrap" tabindex="0"><code><span class="dev3-line">├─ tree\n</span></code></pre>');
	});
});
