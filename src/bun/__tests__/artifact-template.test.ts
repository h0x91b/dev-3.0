import {
	existsSync,
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
import {
	ARTIFACT_TEMPLATE_FILES,
	ARTIFACT_TEMPLATE_VERSION,
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

	it("keeps the provisioned file inventory and model-facing guide synchronized", () => {
		const guide = readFileSync(join(sourceDir, "AUTHORING.md"), "utf8");
		expect(readdirSync(sourceDir).sort()).toEqual([...ARTIFACT_TEMPLATE_FILES].sort());
		for (const file of ARTIFACT_TEMPLATE_FILES) expect(guide).toContain(`\`${file}\``);
		expect(guide).toContain('cp -R "$DEV3_ARTIFACT_TEMPLATE_DIR" ./dev3-artifact-report');
		expect(guide).toContain("do not list or explore the directory before starting");
		expect(guide).toContain("For most reports, edit only `index.html` and `report.js`");
		expect(guide).toContain("Do not read or edit `app.css` or `app.js`");
		expect(guide).toContain("--assets");
		expect(guide).not.toContain("--images");
	});

	it("keeps report authoring separate from the stable visual shell", () => {
		const html = readFileSync(htmlPath, "utf8");
		const css = readFileSync(cssPath, "utf8");
		const app = readFileSync(appPath, "utf8");
		const report = readFileSync(reportPath, "utf8");
		const guide = readFileSync(join(sourceDir, "AUTHORING.md"), "utf8");

		expect(html).toContain('<link rel="stylesheet" href="app.css"');
		expect(html).toContain('<script src="app.js" data-dev3-artifact-shell></script>');
		expect(html).toContain('<script src="report.js"></script>');
		expect(html.indexOf('src="app.js"')).toBeLessThan(html.indexOf('src="report.js"'));
		expect(css).toContain("--dev3-surface-base");
		expect(app).toContain("function dev3Chart");
		expect(app).toContain("window.dev3Artifact");
		expect(app).not.toContain("report.velocity");
		expect(app).not.toContain("scenarioRadar");
		expect(report).toContain("const report =");
		expect(report).toContain("scenarioRadar");
		expect(guide).toContain("For most reports, edit only `index.html` and `report.js`");
		expect(guide).toContain("Do not read or edit `app.css` or `app.js`");
		expect(statSync(htmlPath).size).toBeLessThan(15_000);
		expect(statSync(reportPath).size).toBeLessThan(15_000);
	});

	it("ships the branded responsive interactive starter and authoring guide", () => {
		expect(existsSync(htmlPath)).toBe(true);
		const html = readFileSync(htmlPath, "utf8");
		const css = readFileSync(cssPath, "utf8");
		const app = readFileSync(appPath, "utf8");
		const guide = readFileSync(join(sourceDir, "AUTHORING.md"), "utf8");

		expect(html).toContain('data-dev3-artifact-template="v1"');
		expect(html).toContain("DEV3 ARTIFACT · OPERATIONS");
		expect(html).toContain("Built with dev3 Artifacts");
		expect(html).toContain('src="dev3-icon.png"');
		expect(html).toContain("◐ Auto");
		expect(app).toContain("☀ Light");
		expect(app).toContain("☾ Dark");
		expect(html).toContain('class="section-nav print-hidden"');
		expect(html).toContain('href="#charts"');
		expect(app).toContain("function initializeNavigation");
		expect(app).toContain('setAttribute("aria-current", "location")');
		expect(css).toContain("prefers-color-scheme");
		expect(app).toContain("dev3-artifact-theme");
		expect(css).toContain("@media (max-width: 560px)");
		expect(html).toContain("<form");
		expect(html).toContain("data-ui-select");
		expect(html).toContain("data-ui-slider");
		expect(html).toContain('type="radio"');
		expect(app).toContain("function enhanceControls");
		expect(app).toContain("window.Choices");
		expect(app).toContain("window.noUiSlider");
		expect(html).toContain('id="velocityChart"');
		expect(html).toContain('id="pipelinePie"');
		expect(html).toContain('id="capabilityRadar"');
		expect(html).toContain('id="galleryChart"');
		const report = readFileSync(reportPath, "utf8");
		for (const type of ["heatmap", "sankey", "sunburst", "gauge"]) expect(report).toContain(`${type}:`);
		expect(html).toContain("data-sort");
		expect(guide).toContain("DEV3_ARTIFACT_TEMPLATE_DIR");
		expect(guide).toContain("dev3 show-artifact");
		expect(guide).toContain("Print and PDF");
		expect(guide).toContain("Apache ECharts");
		expect(guide).toContain("window.dev3Artifact.chart()");
		expect(guide).toContain("Dense evidence tables");
		expect(guide).toContain("`evidence-data.js`");
		expect(css).toContain(".evidence-table-scroll");
		expect(css).toContain(".evidence-table .sig");
		expect(css).toContain(".evidence-table tr.regime td");
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

		expect(html).toContain('data-dev3-vendor="choices.js@11.2.3"');
		expect(html).toContain('href="https://cdnjs.cloudflare.com/ajax/libs/choices.js/11.2.3/choices.min.css"');
		expect(html).toContain('src="https://cdnjs.cloudflare.com/ajax/libs/choices.js/11.2.3/choices.min.js"');
		expect(html).toContain('data-dev3-vendor="nouislider@15.8.1"');
		expect(html).toContain('href="https://cdnjs.cloudflare.com/ajax/libs/noUiSlider/15.8.1/nouislider.min.css"');
		expect(html).toContain('src="https://cdnjs.cloudflare.com/ajax/libs/noUiSlider/15.8.1/nouislider.min.js"');
		expect(html).not.toContain("integrity=");
		expect(html).not.toContain("crossorigin=");
	});

	it("uses the full width of a wide monitor while prose keeps a measure", () => {
		const css = readFileSync(cssPath, "utf8");
		const guide = readFileSync(join(sourceDir, "AUTHORING.md"), "utf8");

		expect(css).toContain("width: min(100%, clamp(1180px, 88vw, 1840px))");
		expect(css).toContain(".prose { max-width: 72ch; }");
		expect(css).toContain(".kpis { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }");
		expect(css).toContain("@media (min-width: 1500px)");
		expect(guide).toContain("`.prose`");
	});

	it("gives every table zebra rows, row hover, column rules, and a pinned header", () => {
		const css = readFileSync(cssPath, "utf8");
		const app = readFileSync(appPath, "utf8");
		const guide = readFileSync(join(sourceDir, "AUTHORING.md"), "utf8");

		expect(css).toContain("th:not(:last-child), td:not(:last-child) { border-inline-end:");
		expect(css).toContain("tbody tr:nth-child(even) { --dev3-row-tint:");
		expect(css).toContain("tbody tr:hover { --dev3-row-tint:");
		expect(css).toContain("top: var(--dev3-table-head-top, 0px)");
		// hidden would turn the card into a scrollport and unpin the header.
		expect(css).toContain(".table-card { padding: 0; overflow: clip; }");
		// The evidence scroller is its own scrollport, so the page offset must not apply.
		expect(css).toContain(".evidence-table thead th { top: 0; }");
		expect(css).toContain('th[aria-sort="descending"]::after');
		expect(app).toContain("function trackStickyOffset");
		expect(app).toContain("--dev3-table-head-top");
		expect(app).toContain("function initializeSortIndicators");
		expect(app).toContain('setAttribute("aria-sort", next)');
		expect(guide).toContain("## Tables");
	});

	it("keeps the pinned evidence label column readable while the numbers scroll", () => {
		const css = readFileSync(cssPath, "utf8");
		const guide = readFileSync(join(sourceDir, "AUTHORING.md"), "utf8");
		const printBlock = css.slice(css.indexOf("@media print"));

		expect(css).toContain("inset-inline-start: 0");
		expect(css).toContain("background-image: linear-gradient(var(--dev3-row-tint, transparent)");
		expect(printBlock).toContain(".evidence-table th:first-child, .evidence-table td:first-child { position: static;");
		expect(guide).toContain("The first column is pinned");
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
		const report = readFileSync(reportPath, "utf8");
		const periodHandler = report.match(/document\.getElementById\("periods"\)[\s\S]*?\n  \}\);/)?.[0] || "";

		expect(app).not.toContain("function revealChart");
		expect(app).not.toContain("is-revealing");
		expect(css).not.toContain("chart-curtain");
		expect(periodHandler).toContain("velocityChart.remount()");
		expect(css).toContain(".choices__item--choice.is-selected");
		expect(css).toContain(".choices__item--selectable.is-highlighted");
	});

	it("opens every menu and dropdown in the browser top layer instead of stacking guesses", () => {
		const html = readFileSync(htmlPath, "utf8");
		const css = readFileSync(cssPath, "utf8");
		const app = readFileSync(appPath, "utf8");
		const guide = readFileSync(join(sourceDir, "AUTHORING.md"), "utf8");
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

		// The starter demonstrates the pattern where it used to break: inside a card.
		expect(html).toContain('data-popover-trigger="runsMenu"');
		expect(html).toContain('<div class="popover" id="runsMenu">');
		expect(guide).toContain("Never hand-roll `position: absolute` + `z-index`");
		expect(guide).toContain("dev3Artifact.popover(panel, triggerElement)");
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
		expect(css).toContain(".dashboard-grid > * { min-width: 0; }");
		expect(css).toContain("var(--dev3-print-chart-height, 155px)");
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
		// The shell stylesheet is not part of the authoring surface, so its budget
		// only has to stay far below an inlined library.
		expect(statSync(cssPath).size).toBeLessThan(34_000);
		expect(statSync(appPath).size).toBeLessThan(30_000);
		expect(statSync(reportPath).size).toBeLessThan(15_000);
	});
});
