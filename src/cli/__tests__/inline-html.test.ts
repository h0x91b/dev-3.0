import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLI_EXIT_CODE_ARTIFACT_ASSET_MISSING,
	CLI_EXIT_CODE_ARTIFACT_SECRET_FOUND,
	CLI_EXIT_CODE_SUCCESS,
} from "../../shared/cli-exit-codes";
import { handleInlineHtml, inlineHtml, scanForSecrets } from "../commands/inline-html";

const ROOT = mkdtempSync(join(tmpdir(), "dev3-inline-html-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A tiny 1x1 PNG — real bytes, so base64 encoding is exercised for real. */
const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
	"base64",
);

function artifact(name: string, files: Record<string, string | Buffer>): string {
	const dir = join(ROOT, name);
	rmSync(dir, { recursive: true, force: true });
	for (const [rel, content] of Object.entries(files)) {
		const target = join(dir, rel);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, content);
	}
	return dir;
}

describe("inlineHtml", () => {
	it("embeds local stylesheet, script and image, and leaves CDN references alone", () => {
		const dir = artifact("full", {
			"index.html": `<!doctype html>
<link rel="stylesheet" href="app.css">
<link rel="stylesheet" href="https://cdn.example.com/x.css">
<script src="report.js"></script>
<script src="https://cdn.example.com/chart.js"></script>
<img src="chart.png">`,
			"app.css": "body { color: red; }",
			"report.js": "document.body.dataset.ready = 'true';",
			"chart.png": PNG_BYTES,
		});

		const { html, state } = inlineHtml(join(dir, "index.html"));

		expect(html).toContain("<style>\nbody { color: red; }\n</style>");
		expect(html).toContain("document.body.dataset.ready = 'true';");
		expect(html).not.toMatch(/src=["']report\.js["']/);
		expect(html).toContain("src=\"data:image/png;base64,");
		// Remote refs must survive untouched — inlining them would only bloat the file.
		expect(html).toContain('href="https://cdn.example.com/x.css"');
		expect(html).toContain('src="https://cdn.example.com/chart.js"');
		expect(state.inlined.map((ref) => ref.kind).sort()).toEqual(["media", "script", "stylesheet"]);
		expect(state.external.map((ref) => ref.ref).sort()).toEqual([
			"https://cdn.example.com/chart.js",
			"https://cdn.example.com/x.css",
		]);
		expect(state.missing).toEqual([]);
	});

	it("rewrites url() references inside an inlined stylesheet", () => {
		const dir = artifact("css-urls", {
			"index.html": '<link rel="stylesheet" href="css/app.css">',
			"css/app.css": "@font-face { src: url('font.woff2'); }\n.bg { background: url(https://cdn.example.com/bg.png); }",
			"css/font.woff2": PNG_BYTES,
		});

		const { html, state } = inlineHtml(join(dir, "index.html"));

		expect(html).toContain("url('data:font/woff2;base64,");
		expect(html).toContain("url(https://cdn.example.com/bg.png)");
		expect(state.inlined.some((ref) => ref.kind === "css-url")).toBe(true);
	});

	it("keeps the artifact shell marker and media attribute on a folded stylesheet", () => {
		const dir = artifact("shell", {
			"index.html": '<link rel="stylesheet" data-dev3-artifact-shell href="app.css" media="print">',
			"app.css": "body { color: blue; }",
		});

		const { html } = inlineHtml(join(dir, "index.html"));

		expect(html).toContain('<style data-dev3-artifact-shell media="print">');
	});

	it("escapes a literal </script> inside an inlined script", () => {
		const dir = artifact("script-close", {
			"index.html": '<script src="app.js"></script>',
			"app.js": 'const t = "</script>";',
		});

		const { html } = inlineHtml(join(dir, "index.html"));

		expect(html).toContain('const t = "<\\/script>";');
		// Exactly one closing tag: the one we emit.
		expect(html.match(/<\/script>/g)).toHaveLength(1);
	});

	it("records a referenced file that does not exist instead of silently dropping it", () => {
		const dir = artifact("broken", {
			"index.html": '<link rel="stylesheet" href="missing.css">',
		});

		const { html, state } = inlineHtml(join(dir, "index.html"));

		expect(state.missing).toHaveLength(1);
		expect(state.missing[0].ref).toBe("missing.css");
		expect(html).toContain('href="missing.css"');
	});
});

describe("scanForSecrets", () => {
	it("flags credential-shaped strings", () => {
		const { secrets } = scanForSecrets(`token: ghp_${"a".repeat(30)} and key sk-${"b".repeat(30)}`);

		expect(secrets.map((hit) => hit.kind)).toEqual(["github token", "openai/anthropic key"]);
		// Samples are truncated so the report itself never carries a usable secret.
		expect(secrets[0].sample.length).toBeLessThanOrEqual(13);
	});

	it("dedupes possible leaks and leaves them non-blocking", () => {
		const { secrets, possibleLeaks } = scanForSecrets(
			"/Users/someone/a /Users/someone/a me@example.com https://foo.trycloudflare.com/x",
		);

		expect(secrets).toEqual([]);
		expect(possibleLeaks.map((leak) => leak.kind)).toEqual(["home path", "email", "tunnel url"]);
	});
});

describe("handleInlineHtml", () => {
	let exitCode: number | undefined;
	let stdout = "";

	beforeEach(() => {
		exitCode = undefined;
		stdout = "";
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCode = code;
			throw new Error("EXIT");
		}) as never);
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout += String(chunk);
			return true;
		});
	});

	afterEach(() => vi.restoreAllMocks());

	async function run(argv: string[]): Promise<void> {
		await handleInlineHtml(argv).catch((err: Error) => {
			if (err.message !== "EXIT") throw err;
		});
	}

	it("writes the folded file from a directory argument and reports what it did", async () => {
		const dir = artifact("handler-ok", {
			"index.html": '<link rel="stylesheet" href="app.css"><script src="https://cdn.example.com/c.js"></script>',
			"app.css": "body { color: red; }",
		});
		const out = join(ROOT, "handler-ok.html");

		await run([dir, "-o", out]);

		expect(exitCode).toBe(CLI_EXIT_CODE_SUCCESS);
		expect(readFileSync(out, "utf-8")).toContain("body { color: red; }");
		expect(stdout).toContain("inlined:  1");
		expect(stdout).toContain("external: 1 (left as-is)");
		expect(stdout).toContain("secrets:  none found");
	});

	it("refuses on a missing asset and writes nothing", async () => {
		const dir = artifact("handler-missing", {
			"index.html": '<link rel="stylesheet" href="gone.css">',
		});
		const out = join(ROOT, "handler-missing.html");

		await run([join(dir, "index.html"), "-o", out]);

		expect(exitCode).toBe(CLI_EXIT_CODE_ARTIFACT_ASSET_MISSING);
		expect(existsSync(out)).toBe(false);
		expect(JSON.parse(stdout).missing[0].ref).toBe("gone.css");
	});

	it("refuses on an embedded credential and writes nothing", async () => {
		const dir = artifact("handler-secret", {
			"index.html": `<p>token ghp_${"c".repeat(30)}</p>`,
		});
		const out = join(ROOT, "handler-secret.html");

		await run([join(dir, "index.html"), "-o", out]);

		expect(exitCode).toBe(CLI_EXIT_CODE_ARTIFACT_SECRET_FOUND);
		expect(existsSync(out)).toBe(false);
		expect(JSON.parse(stdout).error).toContain("do not publish");
	});

	it("emits a machine-readable report with --json", async () => {
		const dir = artifact("handler-json", { "index.html": "<h1>ok</h1>" });
		const out = join(ROOT, "handler-json.html");

		await run([dir, "-o", out, "--json"]);

		const report = JSON.parse(stdout);
		expect(exitCode).toBe(CLI_EXIT_CODE_SUCCESS);
		expect(report.output).toBe(out);
		expect(report.bytes).toBeGreaterThan(0);
	});
});
