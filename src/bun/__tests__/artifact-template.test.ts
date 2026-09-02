import {
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SHARED_ARTIFACT_HTML_BYTES, type Project, type Task } from "../../shared/types";
import { ARTIFACT_TEMPLATE_FILES, ARTIFACT_TEMPLATE_VERSION } from "../../shared/artifact-template";
import {
	artifactTemplateDir,
	ensureArtifactTemplate,
	ensureArtifactTemplateEnv,
} from "../artifact-template";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function project(path: string, kind?: "git" | "virtual"): Project {
	return { id: "project-1", name: "Example", path, kind } as Project;
}

function task(): Task {
	return { id: "12345678-1234-1234-1234-123456789abc", title: "Example" } as Task;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("artifact template provisioning", () => {
	it("copies the bundled starter into a versioned task-local sibling of the worktree", () => {
		const root = tempDir("dev3-artifact-template-");
		const sourceDir = join(root, "bundle");
		const taskContainerDir = join(root, "task-container");
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(join(sourceDir, "index.html"), "<html>starter</html>");
		writeFileSync(join(sourceDir, "report.js"), "report");
		writeFileSync(join(sourceDir, "app.css"), "css");
		writeFileSync(join(sourceDir, "app.js"), "js");
		writeFileSync(join(sourceDir, "AUTHORING.md"), "Authoring guide");
		writeFileSync(join(sourceDir, "REFERENCE.md"), "Reference");
		writeFileSync(join(sourceDir, "dev3-icon.png"), "png");

		const result = ensureArtifactTemplate(project("/repo"), task(), {
			sourceDir,
			taskContainerDir,
		});

		expect(result).toBe(join(taskContainerDir, `artifact-template-v${ARTIFACT_TEMPLATE_VERSION}`));
		expect(readFileSync(join(result, "index.html"), "utf8")).toBe("<html>starter</html>");
		expect(readFileSync(join(result, "report.js"), "utf8")).toBe("report");
		expect(readFileSync(join(result, "app.css"), "utf8")).toBe("css");
		expect(readFileSync(join(result, "app.js"), "utf8")).toBe("js");
		expect(readFileSync(join(result, "AUTHORING.md"), "utf8")).toBe("Authoring guide");
		expect(readFileSync(join(result, "dev3-icon.png"), "utf8")).toBe("png");
	});

	it("restores managed files without deleting unrelated task-local files", () => {
		const root = tempDir("dev3-artifact-refresh-");
		const sourceDir = join(root, "bundle");
		const taskContainerDir = join(root, "task-container");
		mkdirSync(sourceDir, { recursive: true });
		for (const [name, body] of [
			["index.html", "fresh"],
			["report.js", "report"],
			["app.css", "css"],
			["app.js", "js"],
			["AUTHORING.md", "guide"],
			["REFERENCE.md", "reference"],
			["dev3-icon.png", "png"],
		]) {
			writeFileSync(join(sourceDir, name), body);
		}
		const target = ensureArtifactTemplate(project("/repo"), task(), { sourceDir, taskContainerDir });
		writeFileSync(join(target, "index.html"), "damaged");
		writeFileSync(join(target, "keep-me.txt"), "user file");

		ensureArtifactTemplate(project("/repo"), task(), { sourceDir, taskContainerDir });

		expect(readFileSync(join(target, "index.html"), "utf8")).toBe("fresh");
		expect(readFileSync(join(target, "keep-me.txt"), "utf8")).toBe("user file");
	});

	it("uses the dev3-owned operation task container for virtual projects", () => {
		const virtualProject = project("/tmp/dev3/ops/release-ops", "virtual");
		expect(artifactTemplateDir(virtualProject, task())).toBe(
			"/tmp/dev3/ops/release-ops/12345678/artifact-template-v1",
		);
	});

	it("exports the task-local starter path for launched agents", () => {
		const root = tempDir("dev3-artifact-env-");
		const worktreePath = join(root, "task-container", "worktree");

		const env = ensureArtifactTemplateEnv(project("/repo"), task(), worktreePath);

		expect(env).toEqual({
			DEV3_ARTIFACT_TEMPLATE_DIR: join(root, "task-container", `artifact-template-v${ARTIFACT_TEMPLATE_VERSION}`),
		});
		expect(readFileSync(join(env.DEV3_ARTIFACT_TEMPLATE_DIR, "AUTHORING.md"), "utf8")).toContain(
			"DEV3_ARTIFACT_TEMPLATE_DIR",
		);
	});

	it("ensureArtifactTemplateEnv degrades to an empty env instead of throwing when provisioning fails", () => {
		// A missing/broken artifact starter must never block launching a task — the
		// starter is only needed when the agent builds a dev3 HTML artifact. Force a
		// provisioning failure (worktree nested under a regular file → mkdir ENOTDIR)
		// and assert the launch env comes back empty rather than throwing. Regression
		// for the "Bundled dev3 artifact template not found" launch blocker on brew.
		const root = tempDir("dev3-artifact-degrade-");
		const filePath = join(root, "not-a-dir");
		writeFileSync(filePath, "i am a file");
		const worktreePath = join(filePath, "container", "worktree");

		expect(() => ensureArtifactTemplateEnv(project("/repo"), task(), worktreePath)).not.toThrow();
		expect(ensureArtifactTemplateEnv(project("/repo"), task(), worktreePath)).toEqual({});
	});

	it("fails loudly when the bundled starter is incomplete", () => {
		const root = tempDir("dev3-artifact-missing-");
		const sourceDir = join(root, "bundle");
		const taskContainerDir = join(root, "task-container");
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(join(sourceDir, "index.html"), "<html>starter</html>");
		writeFileSync(join(sourceDir, "report.js"), "report");
		writeFileSync(join(sourceDir, "app.css"), "css");
		writeFileSync(join(sourceDir, "app.js"), "js");
		writeFileSync(join(sourceDir, "AUTHORING.md"), "Authoring guide");
		writeFileSync(join(sourceDir, "REFERENCE.md"), "Reference");

		expect(() => ensureArtifactTemplate(project("/repo"), task(), { sourceDir, taskContainerDir })).toThrow(
			/Bundled dev3 artifact template is missing dev3-icon\.png/,
		);
	});
});

describe("bundled artifact starter contract", () => {
	const sourceDir = resolve(import.meta.dirname, "../../assets/artifact-template");
	const htmlPath = join(sourceDir, "index.html");
	const cssPath = join(sourceDir, "app.css");
	const appPath = join(sourceDir, "app.js");
	const reportPath = join(sourceDir, "report.js");
	const guide = readFileSync(join(sourceDir, "AUTHORING.md"), "utf8");
	const reference = readFileSync(join(sourceDir, "REFERENCE.md"), "utf8");
	// The card plus the depth behind it: what an author can reach without opening the shell.
	const docs = guide + reference;

	it("keeps the provisioned file inventory and model-facing guide synchronized", () => {
		expect(readdirSync(sourceDir).sort()).toEqual([...ARTIFACT_TEMPLATE_FILES].sort());
		for (const file of ARTIFACT_TEMPLATE_FILES) expect(guide).toContain(`\`${file}\``);
		expect(guide).toContain('cp -R "$DEV3_ARTIFACT_TEMPLATE_DIR" ./dev3-artifact-report');
		expect(guide).toContain("do not list or explore the directory before starting");
		expect(guide).toContain("For most reports, edit only `index.html` and `report.js`");
		expect(guide).toContain("Do not read or edit `app.css` or `app.js`");
		expect(guide).toContain("--assets");
		expect(docs).not.toContain("--images");
	});

	// The agent reads the card before writing a single line of report, so the card
	// is the token budget: everything the depth needs lives in REFERENCE.md, and
	// the card only points at its sections.
	it("keeps the card small and points at the reference for depth", () => {
		expect(statSync(join(sourceDir, "AUTHORING.md")).size).toBeLessThan(8_000);
		expect(guide).toContain('dev3 show-artifact ./dev3-artifact-report --title "Report title"');
		expect(guide).toContain("## When the report needs more — `REFERENCE.md`");
		for (const section of [
			"## Panels, spacing, and width",
			"## Color tokens",
			"## Text size",
			"## Publishing and assets",
			"## Network access and external libraries",
			"## Charts (Apache ECharts from cdnjs)",
			"## Navigation and form controls",
			"## Menus, dropdowns, and anything that opens over the report",
			"## Tables",
			"### Dense evidence tables",
			"## Print and PDF",
			"## Asking the user something (`window.dev3.sendToAgent`)",
			"## Contracts to preserve",
		]) {
			expect(reference).toContain(section);
		}
	});

	it("keeps report authoring separate from the stable visual shell", () => {
		const html = readFileSync(htmlPath, "utf8");
		const css = readFileSync(cssPath, "utf8");
		const app = readFileSync(appPath, "utf8");
		const report = readFileSync(reportPath, "utf8");

		expect(html).toContain('<link rel="stylesheet" href="app.css"');
		expect(html).toContain('<script src="app.js" data-dev3-artifact-shell></script>');
		expect(html).toContain('<script src="report.js"></script>');
		expect(html.indexOf('src="app.js"')).toBeLessThan(html.indexOf('src="report.js"'));
		expect(css).toContain("--dev3-surface-base");
		expect(app).toContain("function dev3Chart");
		expect(app).toContain("window.dev3Artifact");
		expect(app).not.toContain("trendChart");
		expect(report).toContain("const report =");
		expect(report).toContain('document.getElementById("trendChart")');
		// A written report deletes most of the starter; what it deletes is the budget.
		expect(statSync(htmlPath).size).toBeLessThan(9_000);
		expect(statSync(reportPath).size).toBeLessThan(2_000);
	});

	// The starter is the skeleton of a written report — the shape 80% of real
	// artifacts take — not a dashboard the author has to gut. It keeps exactly one
	// chart so the chart contract stays live.
	it("ships a document-first starter with the branding, controls and one chart", () => {
		const html = readFileSync(htmlPath, "utf8");
		const css = readFileSync(cssPath, "utf8");
		const app = readFileSync(appPath, "utf8");
		const report = readFileSync(reportPath, "utf8");

		expect(html).toContain('data-dev3-artifact-template="v1"');
		expect(html).toContain('<main class="app doc">');
		expect(html).toContain("DEV3 ARTIFACT · REPORT");
		expect(html).toContain("Built with dev3 Artifacts");
		expect(html).toContain('src="dev3-icon.png"');
		expect(html).toContain("◐ Auto");
		expect(app).toContain("☀ Light");
		expect(app).toContain("☾ Dark");
		expect(html).toContain('class="section-nav print-hidden"');
		expect(html).toContain('href="#findings"');
		expect(app).toContain("function initializeNavigation");
		expect(app).toContain('setAttribute("aria-current", "location")');
		expect(css).toContain("prefers-color-scheme");
		expect(app).toContain("dev3-artifact-theme");
		expect(css).toContain("@media (max-width: 560px)");
		// Every document primitive the cheat sheet promises appears once in the skeleton.
		for (const snippet of [
			'<p class="prose">',
			'<div class="callout good">',
			'<span class="callout-title">',
			'<ol class="steps">',
			"<pre><code>",
			"<kbd>",
			"<mark>",
			"<details><summary>",
			"<table data-sortable>",
			'<th data-sort tabindex="0">',
			'class="num"',
			'<span class="pill danger">',
			'class="chart-host" id="trendChart"',
			'figure class="shot"',
			'class="pair"',
		]) {
			expect(html).toContain(snippet);
		}
		// No form controls in the skeleton, so no Choices / noUiSlider tags to load for nothing;
		// the shell still enhances them and the reference carries the tags to paste.
		expect(html).not.toContain("data-ui-select");
		expect(html).not.toContain("choices.js");
		expect(app).toContain("function enhanceControls");
		expect(app).toContain("window.Choices");
		expect(app).toContain("window.noUiSlider");
		expect(reference).toContain('data-dev3-vendor="choices.js@11.2.3"');
		expect(reference).toContain('data-dev3-vendor="nouislider@15.8.1"');
		expect(report).toContain('type: "bar"');
		expect(docs).toContain("DEV3_ARTIFACT_TEMPLATE_DIR");
		expect(docs).toContain("dev3 show-artifact");
		expect(docs).toContain("Print and PDF");
		expect(docs).toContain("Apache ECharts");
		expect(docs).toContain("window.dev3Artifact.asset()");
		expect(docs).toContain("`.chart()`");
		expect(docs).toContain("Dense evidence tables");
		expect(docs).toContain("`evidence-data.js`");
		expect(css).toContain(".evidence-table-scroll");
		expect(css).toContain(".evidence-table .sig");
		expect(css).toContain(".evidence-table tr.regime td");
	});

	// Plain HTML a written report is made of, each styled by the shell so an author
	// never opens a <style> block: 59 of 306 real reports had one, inventing
	// .shot, .callout, .steps, .legend, .progress over and over.
	it("styles the document primitives a written report is made of", () => {
		const css = readFileSync(cssPath, "utf8");
		for (const selector of [
			"code, kbd {",
			"pre {",
			"pre code {",
			"blockquote {",
			"details {",
			"summary {",
			"mark {",
			"h3 {",
			"h4 {",
			"ul, ol {",
			".callout {",
			".callout.good {",
			".callout.warn {",
			".callout.bad {",
			".callout-title {",
			".steps {",
			".steps > li::before {",
			"figure.shot img, figure.shot video {",
			"figure.shot figcaption {",
			".pair {",
			".legend {",
			".swatch {",
			".progress {",
			".progress > span {",
			".pill.danger {",
			".pill.muted {",
			"th.num, td.num {",
		]) {
			expect(css).toContain(selector);
		}
		// Text is the default in every table; numbers opt in. The old ledger default
		// right-aligned prose and cost one report 31 `.wrap` classes.
		expect(css).toContain(".evidence-table th, .evidence-table td { padding: 6px 9px; text-align: left;");
		expect(css).toContain(".evidence-table .num { text-align: right; }");
		expect(css).not.toContain("text-align: right; font-size: .65625rem");
		// A code block wraps; a scroller would be the pattern the table rules forbid.
		expect(css).toMatch(/pre \{[^}]*white-space: pre-wrap/);
		// A document takes a page width and drops it for a dashboard.
		expect(css).toContain(".app.doc { width: min(100%, 960px); }");
		expect(guide).toContain('<div class="callout good">');
		expect(guide).toContain('<ol class="steps">');
		expect(guide).toContain("`.prose`");
	});

	it("sorts a data-sortable table's rows in the shell so a static report needs no JavaScript", () => {
		const app = readFileSync(appPath, "utf8");
		expect(app).toContain("function sortRowsInPlace");
		expect(app).toContain('table?.hasAttribute("data-sortable")');
		expect(app).toContain("cell.dataset.sort ?? cell.textContent.trim()");
		expect(docs).toContain("`<table data-sortable>`");
	});

	// Each of these was described in prose and cost an author a debug loop, because
	// the wrong form fails without an error: an unwrapped token renders nothing, an
	// id string throws from minified ECharts, a runtime src resolves to nothing in
	// the sandbox. Prose is not enough — the docs have to show the call.
	it("shows the exact call for every form that fails silently when written wrong", () => {
		const app = readFileSync(appPath, "utf8");

		expect(docs).toContain("background: rgb(var(--dev3-surface-raised));");
		expect(docs).toContain("rgb(var(--dev3-accent) / .18)");
		expect(docs).toContain("box-shadow: 0 8px 24px rgb(var(--dev3-shadow) / .35);");
		expect(docs).toContain('dev3Artifact.chart(document.getElementById("velocityChart"), () => ({');
		expect(docs).toContain("velocity.update();");
		expect(docs).toContain("velocity.remount();");
		expect(docs).toContain('dev3Artifact.asset("shots/run-42.png")');
		// The card itself carries the two traps every chart hits.
		expect(guide).toContain("Pass the **element**, never its id");
		expect(guide).toContain("take **no arguments**");

		// The shell has to back every form the docs promise.
		expect(app).toContain("asset: assetUrl");
		expect(app).toContain("needs an element, not an id");
		expect(app).toContain("takes no arguments");
	});

	it("scales the whole report from one root text size, including chart labels", () => {
		const html = readFileSync(htmlPath, "utf8");
		const css = readFileSync(cssPath, "utf8");
		const app = readFileSync(appPath, "utf8");

		expect(html).toContain('class="segmented text-size"');
		expect(html).toContain('data-font-step="-1"');
		expect(html).toContain('id="fontScaleValue"');
		expect(html).toContain('data-font-step="1"');
		expect(css).toContain("--dev3-font-scale: var(--dev3-font-scale-user, 1)");
		expect(css).toContain("font-size: calc(100% * var(--dev3-font-scale))");
		// Choices sizes its own chips and search field from these variables.
		expect(css).toContain("--choices-font-size-md: .875rem");
		// A px font size anywhere in the shell would be a block that refuses to scale.
		expect(css.match(/font(-size)?: *[0-9.]+px/g)).toBeNull();
		expect(app).toContain("FONT_SCALE_STEPS");
		expect(app).toContain("function scaleOptionFonts");
		expect(app).toContain("dev3-artifact-font-scale");
		expect(reference).toContain("## Text size");
		expect(reference).toContain("dev3Artifact.scaleFont(px)");
	});

	it("loads versioned cdnjs primitives without brittle integrity hashes", () => {
		const html = readFileSync(htmlPath, "utf8");
		const app = readFileSync(appPath, "utf8");

		expect(html).toContain('data-dev3-vendor="echarts@6.1.0"');
		expect(html).toContain('src="https://cdnjs.cloudflare.com/ajax/libs/echarts/6.1.0/echarts.min.js"');
		expect(app).toContain("function dev3Chart");
		expect(app).toContain('renderer: "svg"');
		expect(app).toContain('registerTheme("dev3"');
		expect(app).toContain("aria: { enabled: true");
		expect(app).toContain("prefers-reduced-motion");
		// Offline degradation: charts show a notice instead of throwing.
		expect(app).toContain("chart-unavailable");

		// The control libraries moved to the reference as paste-in tags, pinned the same way.
		expect(reference).toContain('href="https://cdnjs.cloudflare.com/ajax/libs/choices.js/11.2.3/choices.min.css"');
		expect(reference).toContain('src="https://cdnjs.cloudflare.com/ajax/libs/choices.js/11.2.3/choices.min.js"');
		expect(reference).toContain('href="https://cdnjs.cloudflare.com/ajax/libs/noUiSlider/15.8.1/nouislider.min.css"');
		expect(reference).toContain('src="https://cdnjs.cloudflare.com/ajax/libs/noUiSlider/15.8.1/nouislider.min.js"');
		expect(html).not.toContain("integrity=");
		expect(html).not.toContain("crossorigin=");
		expect(reference).not.toContain("integrity=");
	});

	it("uses the full width of a wide monitor while prose keeps a measure", () => {
		const css = readFileSync(cssPath, "utf8");

		expect(css).toContain("width: min(100%, clamp(1180px, 88vw, 1840px))");
		expect(css).toContain(".prose { max-width: 72ch; }");
		expect(css).toContain(".kpis { grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }");
		expect(css).toContain("@media (min-width: 1500px)");
		expect(docs).toContain("`.prose`");
	});

	it("gives an unsized dashboard panel the whole row instead of a 1/12 sliver", () => {
		const css = readFileSync(cssPath, "utf8");

		// span 12 would overflow the narrow and print grids, which have fewer columns.
		expect(css).toContain(".dashboard-grid > * { min-width: 0; grid-column: 1 / -1; }");
		expect(css).not.toContain(".dashboard-grid > * { min-width: 0; grid-column: span 12; }");
		// The opt-in widths only exist where the 12 columns do.
		const spanBlock = css.match(/@media \(min-width: 901px\) \{([\s\S]*?)\n {4}\}/)?.[1] || "";
		for (const span of [3, 4, 5, 6, 7, 8, 9]) {
			expect(spanBlock).toContain(`.dashboard-grid > .span-${span} { grid-column: span ${span}; }`);
		}
		expect(reference).toContain("`.dashboard-grid` is a 12-column grid");
		expect(reference).toContain("`span-3` … `span-9`");
	});

	it("gives every table zebra rows, row hover, column rules, and a pinned header", () => {
		const css = readFileSync(cssPath, "utf8");
		const app = readFileSync(appPath, "utf8");

		expect(css).toContain("th:not(:last-child), td:not(:last-child) { border-inline-end:");
		expect(css).toContain("tbody tr:nth-child(even) { --dev3-row-tint:");
		expect(css).toContain("tbody tr:hover { --dev3-row-tint:");
		expect(css).toContain("top: var(--dev3-table-head-top, 0px)");
		// hidden would turn the card into a scrollport and unpin the header.
		expect(css).toContain(".table-card { padding: 0; overflow: clip; }");
		expect(css).toContain('th[aria-sort="descending"]::after');
		expect(app).toContain("function trackStickyOffset");
		expect(app).toContain("--dev3-table-head-top");
		expect(app).toContain("function initializeSortIndicators");
		expect(app).toContain('setAttribute("aria-sort", next)');
		expect(reference).toContain("## Tables");
	});

	it("stacks a table into labelled lines instead of scrolling it sideways", () => {
		const css = readFileSync(cssPath, "utf8");
		const app = readFileSync(appPath, "utf8");
		const stackedBlock = css.slice(css.indexOf("@container dev3-table"));
		const printBlock = css.slice(css.indexOf("@media print"));

		// No table may reintroduce a horizontal scroller or an unwrappable cell.
		// `.section-nav` is the one sanctioned inline scroller and is not a table.
		const scrollers = css.match(/[^\n]*overflow-x:\s*auto[^\n]*/g) || [];
		expect(scrollers).toHaveLength(1);
		expect(css.slice(0, css.indexOf("overflow-x: auto"))).toMatch(/\.section-nav\s*\{[^}]*$/);
		expect(css).not.toMatch(/width:\s*max-content/);
		// A cell must be able to wrap, or the table grows past its container.
		const evidenceCells = css.match(/\.evidence-table th, \.evidence-table td \{([^}]*)\}/)?.[1] || "";
		expect(evidenceCells).not.toContain("nowrap");
		expect(css).toContain("overflow-wrap: break-word");
		// The table measures its own box, so one in a narrow panel stacks too — and
		// the box is whatever holds the table, or a plain <table> in a plain card
		// has no container at all and the query below silently never matches.
		expect(css).toContain(
			":not(html, body):has(> table), .table-card, .evidence-table-scroll { container: dev3-table / inline-size; }",
		);
		expect(stackedBlock).toContain("thead { display: none; }");
		expect(stackedBlock).toContain("content: attr(data-dev3-label)");
		// Paper is narrow enough to match the query, so print drops the container.
		expect(printBlock).toContain(
			":not(html, body):has(> table), .table-card, .evidence-table-scroll { container: normal; }",
		);
		// Labels come from the shell, so a plain <table> needs no new markup.
		expect(app).toContain("function labelTableCells");
		expect(app).toContain('cell.setAttribute("data-dev3-label", label)');
		// A report writes the whole table into a host div in one go, so the target
		// of that mutation is the div — the added subtree has to be inspected too.
		expect(app).toContain("function recordTouchesTable");
		expect(app).toContain('node.matches("table") || node.querySelector("table")');
		expect(reference).toContain("No table scrolls sideways");
	});

	it("keeps dense-table significance markers typographic", () => {
		const css = readFileSync(cssPath, "utf8");
		const significanceRule = css.match(/\.evidence-table \.sig\s*\{([^}]*)\}/)?.[1] || "";

		expect(significanceRule).toContain("font-weight: 700");
		expect(significanceRule).not.toContain("background:");
		expect(significanceRule).not.toContain("box-shadow:");
	});

	it("uses native chart drawing motion and safe dropdown state precedence", () => {
		const app = readFileSync(appPath, "utf8");
		const css = readFileSync(cssPath, "utf8");

		expect(app).not.toContain("function revealChart");
		expect(app).not.toContain("is-revealing");
		expect(css).not.toContain("chart-curtain");
		expect(reference).toContain("calls `remount()` on the chart");
		expect(css).toContain(".choices__item--choice.is-selected");
		expect(css).toContain(".choices__item--selectable.is-highlighted");
	});

	it("opens every menu and dropdown in the browser top layer instead of stacking guesses", () => {
		const css = readFileSync(cssPath, "utf8");
		const app = readFileSync(appPath, "utf8");
		const printBlock = css.slice(css.indexOf("@media print"));

		// A hand-rolled absolute panel is clipped by the card around it, so the
		// shell promotes overlays instead of ordering them.
		expect(app).toContain("showPopover");
		expect(app).toContain("hidePopover");
		expect(app).toContain('setAttribute("popover", "manual")');
		expect(app).toContain("function placeOverlay");
		expect(app).toContain("function initializePopovers");
		// The Choices list is anchored to its field, so it needs the same lift.
		expect(app).toContain('select.addEventListener("showDropdown"');
		expect(app).toContain('select.addEventListener("hideDropdown"');
		// Placement, dismissal, and focus belong to the shell, not to report code.
		expect(app).toContain('dataset.placement = flip ? "top" : "bottom"');
		expect(app).toContain('if (event.key !== "Escape") return');
		expect(app).toContain("scheduleReposition");
		expect(app).toContain("popover: popoverApi");

		// Anything that competes across panels goes through the scale; the single
		// digits left are a table ordering its own pinned cells.
		for (const token of ["--dev3-z-nav", "--dev3-z-overlay", "--dev3-z-toast"]) expect(css).toContain(token);
		expect(css).toContain("z-index: var(--dev3-z-nav)");
		expect(css).toContain("z-index: var(--dev3-z-overlay)");
		expect(css).toContain("z-index: var(--dev3-z-toast)");
		expect(css).not.toMatch(/z-index:\s*\d{2}/);
		expect(css).toContain(".popover:not([data-open]) { display: none; }");
		expect(printBlock).toContain(".popover, [popover] { display: none !important; }");

		// The reference shows the pattern where it used to break: a menu inside a card.
		expect(reference).toContain('data-popover-trigger="runsMenu"');
		expect(reference).toContain('<div class="popover" id="runsMenu">');
		expect(docs).toContain("Never hand-roll `position: absolute` + `z-index`");
		expect(reference).toContain("dev3Artifact.popover(panel, triggerElement)");
	});

	it("keeps the selected theme and report structure in print output", () => {
		const css = readFileSync(cssPath, "utf8");
		const app = readFileSync(appPath, "utf8");

		expect(css).toContain("@media print");
		expect(css).toContain("-webkit-print-color-adjust: exact");
		expect(css).toContain("print-color-adjust: exact");
		expect(css).toContain("background: rgb(var(--dev3-surface-base)) !important");
		expect(css).toContain(".scenario-panel, .table-tools, .toast, .print-hidden { display: none !important; }");
		expect(css).toContain("break-inside: avoid");
		expect(css).toContain("thead { display: table-header-group; }");
		expect(css).toContain(".dashboard-grid > * { min-width: 0; grid-column: 1 / -1; }");
		expect(css).toContain("var(--dev3-print-chart-height, 9.6875rem)");
		expect(app).toContain('document.querySelectorAll("details:not([open])")');
		expect(app).toContain("element.getBoundingClientRect()");
	});

	it("defines the complete dev3 semantic token contract and stays lean beyond the pinned CDN primitives", () => {
		const html = readFileSync(htmlPath, "utf8");
		const css = readFileSync(cssPath, "utf8");
		// The viewer allows network access, but every STARTER remote reference
		// must be one of the pinned cdnjs shell primitives.
		const withoutVendorTags = html
			.replace(/<script data-dev3-vendor=[^>]*><\/script>/g, "")
			.replace(/<link data-dev3-vendor=[^>]*>/g, "");
		expect(withoutVendorTags.length).toBeLessThan(html.length);
		for (const token of [
			"--dev3-surface-base",
			"--dev3-surface-raised",
			"--dev3-surface-elevated",
			"--dev3-text-primary",
			"--dev3-text-secondary",
			"--dev3-text-muted",
			"--dev3-border",
			"--dev3-accent",
			"--dev3-success",
			"--dev3-warning",
			"--dev3-danger",
			"--dev3-on-accent",
			"--dev3-shadow",
		]) {
			expect(css).toContain(token);
		}
		expect(withoutVendorTags).not.toMatch(/https?:\/\/(?!cdnjs\.cloudflare\.com)/);
		// mentions of the CDN host outside the tag (comments) are fine; loads are not
		expect(withoutVendorTags).not.toMatch(/\b(?:href|src)\s*=\s*["']https?:/);
	});

	it("keeps each starter file small enough for targeted agent reads", () => {
		// Guards against re-inlining the chart library: a ~1 MB single-line blob
		// makes artifact HTML unreadable for agents (the reason we load from CDN).
		expect(statSync(htmlPath).size).toBeLessThan(120_000);
		expect(statSync(htmlPath).size).toBeLessThan(MAX_SHARED_ARTIFACT_HTML_BYTES);
		// The shell stylesheet and script are not part of the authoring surface, so
		// their budgets only have to stay far below an inlined library — these are
		// ~20x under one. The CSS cap moved for the document primitives (code,
		// callouts, steps, figures) that replaced the <style> blocks authors wrote.
		expect(statSync(cssPath).size).toBeLessThan(50_000);
		expect(statSync(appPath).size).toBeLessThan(34_000);
		expect(statSync(reportPath).size).toBeLessThan(2_000);
	});
});
