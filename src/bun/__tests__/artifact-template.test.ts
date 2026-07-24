import {
	existsSync,
	mkdtempSync,
	mkdirSync,
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
		writeFileSync(join(sourceDir, "AUTHORING.md"), "Authoring guide");
		writeFileSync(join(sourceDir, "dev3-icon.png"), "png");

		const result = ensureArtifactTemplate(project("/repo"), task(), {
			sourceDir,
			taskContainerDir,
		});

		expect(result).toBe(join(taskContainerDir, `artifact-template-v${ARTIFACT_TEMPLATE_VERSION}`));
		expect(readFileSync(join(result, "index.html"), "utf8")).toBe("<html>starter</html>");
		expect(readFileSync(join(result, "AUTHORING.md"), "utf8")).toBe("Authoring guide");
		expect(readFileSync(join(result, "dev3-icon.png"), "utf8")).toBe("png");
	});

	it("restores managed files without deleting unrelated task-local files", () => {
		const root = tempDir("dev3-artifact-refresh-");
		const sourceDir = join(root, "bundle");
		const taskContainerDir = join(root, "task-container");
		mkdirSync(sourceDir, { recursive: true });
		for (const [name, body] of [["index.html", "fresh"], ["AUTHORING.md", "guide"], ["dev3-icon.png", "png"]]) {
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
		writeFileSync(join(sourceDir, "AUTHORING.md"), "Authoring guide");

		expect(() => ensureArtifactTemplate(project("/repo"), task(), { sourceDir, taskContainerDir })).toThrow(
			/Bundled dev3 artifact template is missing dev3-icon\.png/,
		);
	});
});

describe("bundled artifact starter contract", () => {
	const sourceDir = resolve(import.meta.dirname, "../../assets/artifact-template");
	const htmlPath = join(sourceDir, "index.html");

	it("ships the branded responsive interactive starter and authoring guide", () => {
		expect(existsSync(htmlPath)).toBe(true);
		const html = readFileSync(htmlPath, "utf8");
		const guide = readFileSync(join(sourceDir, "AUTHORING.md"), "utf8");

		expect(html).toContain('data-dev3-artifact-template="v1"');
		expect(html).toContain("DEV3 ARTIFACT · OPERATIONS");
		expect(html).toContain("Built with dev3 Artifacts");
		expect(html).toContain('src="dev3-icon.png"');
		expect(html).toContain("◐ Auto");
		expect(html).toContain("☀ Light");
		expect(html).toContain("☾ Dark");
		expect(html).toContain("prefers-color-scheme");
		expect(html).toContain("dev3-artifact-theme");
		expect(html).toContain("@media (max-width: 560px)");
		expect(html).toContain("<form");
		expect(html).toContain('id="velocityChart"');
		expect(html).toContain('id="pipelinePie"');
		expect(html).toContain('id="capabilityRadar"');
		expect(html).toContain('id="galleryChart"');
		for (const type of ["heatmap", "sankey", "sunburst", "gauge"]) expect(html).toContain(`"${type}"`);
		expect(html).toContain("data-sort");
		expect(guide).toContain("DEV3_ARTIFACT_TEMPLATE_DIR");
		expect(guide).toContain("dev3 show-artifact");
		expect(guide).toContain("Print and PDF");
		expect(guide).toContain("Apache ECharts");
		expect(guide).toContain("dev3Chart");
	});

	it("loads the pinned ECharts build behind the dev3Chart bridge", () => {
		const html = readFileSync(htmlPath, "utf8");

		expect(html).toContain('data-dev3-vendor="echarts@6.1.0"');
		// The exact origin the viewer CSP allowlists; SRI + crossorigin are
		// mandatory so a tampered CDN payload is rejected, not executed.
		expect(html).toContain('src="https://cdnjs.cloudflare.com/ajax/libs/echarts/6.1.0/echarts.min.js"');
		expect(html).toMatch(/integrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/);
		expect(html).toContain('crossorigin="anonymous"');
		expect(html).toContain("function dev3Chart");
		expect(html).toContain('renderer: "svg"');
		expect(html).toContain('registerTheme("dev3"');
		expect(html).toContain("aria: { enabled: true }");
		// Offline degradation: charts show a notice instead of throwing.
		expect(html).toContain("chart-unavailable");
	});

	it("keeps the selected theme and report structure in print output", () => {
		const html = readFileSync(htmlPath, "utf8");

		expect(html).toContain("@media print");
		expect(html).toContain("-webkit-print-color-adjust: exact");
		expect(html).toContain("print-color-adjust: exact");
		expect(html).toContain("background: rgb(var(--dev3-surface-base)) !important");
		expect(html).toContain(".scenario-panel, .table-tools, .toast, .print-hidden { display: none !important; }");
		expect(html).toContain("break-inside: avoid");
		expect(html).toContain("thead { display: table-header-group; }");
	});

	it("defines the complete dev3 semantic token contract and stays lean beyond the pinned CDN script", () => {
		const html = readFileSync(htmlPath, "utf8");
		// The viewer allows network access, but the STARTER itself must stay
		// self-contained: ECharts from cdnjs is its only remote reference.
		const withoutVendorTag = html.replace(/<script data-dev3-vendor=[^>]*><\/script>/, "");
		expect(withoutVendorTag.length).toBeLessThan(html.length);
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
			expect(html).toContain(token);
		}
		expect(withoutVendorTag).not.toMatch(/https?:\/\/(?!cdnjs\.cloudflare\.com)/);
		// mentions of the CDN host outside the tag (comments) are fine; loads are not
		expect(withoutVendorTag).not.toMatch(/\bsrc\s*=\s*["']https?:/);
	});

	it("stays a small readable file so agents and LLMs can consume artifact HTML", () => {
		// Guards against re-inlining the chart library: a ~1 MB single-line blob
		// makes artifact HTML unreadable for agents (the reason we load from CDN).
		expect(statSync(htmlPath).size).toBeLessThan(120_000);
		expect(statSync(htmlPath).size).toBeLessThan(MAX_SHARED_ARTIFACT_HTML_BYTES);
	});
});
