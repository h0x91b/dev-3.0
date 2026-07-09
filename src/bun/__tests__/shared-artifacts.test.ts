import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SharedArtifact } from "../../shared/types";

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/dev3-shared-artifacts-test",
	OPS_DIR: "/tmp/dev3-shared-artifacts-test/ops",
}));

const TEST_HOME = "/tmp/dev3-shared-artifacts-test";
const SRC_DIR = mkdtempSync(join(tmpdir(), "dev3-artifact-src-"));

import {
	SharedArtifactError,
	deleteSharedArtifactFiles,
	injectArtifactThemeContract,
	loadSharedArtifactContent,
	loadSharedArtifactDownload,
	pruneSharedArtifacts,
	saveSharedArtifact,
} from "../shared-artifacts";

afterAll(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	rmSync(SRC_DIR, { recursive: true, force: true });
});

function artifact(id: string): SharedArtifact {
	return {
		id,
		kind: "html",
		title: id,
		name: `${id}.html`,
		storedPath: `${TEST_HOME}/${id}/${id}.html`,
		originalPath: `/src/${id}.html`,
		bytes: 1,
		createdAt: 1,
		assets: [],
	};
}

describe("injectArtifactThemeContract", () => {
	it("injects the stable dark/light token contract exactly once", () => {
		const source = "<!doctype html><html><head><title>X</title></head><body><main>Hi</main></body></html>";
		const once = injectArtifactThemeContract(source);
		const twice = injectArtifactThemeContract(once);
		expect(once).toContain("data-dev3-artifact-shell");
		expect(once).toContain("--dev3-surface-base");
		expect(once).toContain("prefers-color-scheme: light");
		expect(twice).toBe(once);
	});
});

describe("saveSharedArtifact", () => {
	beforeEach(() => rmSync(TEST_HOME, { recursive: true, force: true }));

	it("copies HTML and --images into one directory and creates a ZIP", () => {
		const html = join(SRC_DIR, "report.html");
		const image = join(SRC_DIR, "chart.png");
		writeFileSync(html, '<!doctype html><img src="chart.png">');
		writeFileSync(image, "PNGDATA");

		const saved = saveSharedArtifact("/my/project", html, [image], "Quarterly report");

		expect(saved.title).toBe("Quarterly report");
		expect(saved.name).toBe("report.html");
		expect(saved.assets.map((item) => item.name)).toEqual(["chart.png"]);
		expect(dirname(saved.assets[0].storedPath)).toBe(dirname(saved.storedPath));
		expect(readFileSync(saved.storedPath, "utf8")).toContain("data-dev3-artifact-shell");
		expect(readFileSync(saved.assets[0].storedPath, "utf8")).toBe("PNGDATA");
		expect(saved.bundlePath).toBeTruthy();
		expect(existsSync(saved.bundlePath!)).toBe(true);
		expect(basename(saved.bundlePath!)).toBe("report.zip");
	});

	it("keeps a no-image artifact as directly downloadable HTML", () => {
		const html = join(SRC_DIR, "standalone.html");
		writeFileSync(html, "<!doctype html><p>Standalone</p>");
		const saved = saveSharedArtifact("/my/project", html, []);
		expect(saved.assets).toEqual([]);
		expect(saved.bundlePath).toBeUndefined();
		expect(existsSync(saved.storedPath)).toBe(true);
		const content = loadSharedArtifactContent(saved);
		expect(content.html).toContain("Standalone");
		expect(content.assets).toEqual([]);
		const download = loadSharedArtifactDownload(saved);
		expect(download.fileName).toBe("standalone.html");
		expect(download.mime).toBe("text/html");
	});

	it("loads copied images as data URLs and downloads the ZIP bundle", () => {
		const html = join(SRC_DIR, "bundle.html");
		const image = join(SRC_DIR, "bundle.png");
		writeFileSync(html, '<!doctype html><img src="bundle.png">');
		writeFileSync(image, "PNGDATA");
		const saved = saveSharedArtifact("/my/project", html, [image]);
		const content = loadSharedArtifactContent(saved);
		expect(content.assets).toEqual([
			expect.objectContaining({ name: "bundle.png", dataUrl: expect.stringMatching(/^data:image\/png;base64,/) }),
		]);
		const download = loadSharedArtifactDownload(saved);
		expect(download.fileName).toBe("bundle.zip");
		expect(download.mime).toBe("application/zip");
		expect(Buffer.from(download.base64, "base64").subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
	});

	it("preserves nested paths so extracted ZIP references remain portable", () => {
		const html = join(SRC_DIR, "dupes.html");
		const aDir = join(SRC_DIR, "a");
		const bDir = join(SRC_DIR, "b");
		mkdirSync(aDir, { recursive: true });
		mkdirSync(bDir, { recursive: true });
		writeFileSync(html, "<!doctype html>");
		writeFileSync(join(aDir, "same.png"), "A");
		writeFileSync(join(bDir, "same.png"), "B");
		const saved = saveSharedArtifact("/my/project", html, [join(aDir, "same.png"), join(bDir, "same.png")]);
		expect(saved.assets.map((asset) => asset.name)).toEqual(["a/same.png", "b/same.png"]);
		expect(saved.assets.every((asset) => existsSync(asset.storedPath))).toBe(true);
		const zip = readFileSync(saved.bundlePath!);
		expect(zip.includes(Buffer.from("a/same.png"))).toBe(true);
		expect(zip.includes(Buffer.from("b/same.png"))).toBe(true);
	});

	it("rejects images outside the HTML directory instead of creating a broken bundle", () => {
		const htmlDir = join(SRC_DIR, "contained");
		mkdirSync(htmlDir, { recursive: true });
		const html = join(htmlDir, "report.html");
		const image = join(SRC_DIR, "outside.png");
		writeFileSync(html, '<!doctype html><img src="../outside.png">');
		writeFileSync(image, "PNGDATA");
		expect(() => saveSharedArtifact("/my/project", html, [image])).toThrow(/inside the HTML directory/);
	});
});

describe("pruneSharedArtifacts / deleteSharedArtifactFiles", () => {
	it("keeps newest records and removes an artifact directory recursively", () => {
		const { kept, dropped } = pruneSharedArtifacts([artifact("a"), artifact("b")], [artifact("c")], 2);
		expect(kept.map((item) => item.id)).toEqual(["b", "c"]);
		expect(dropped.map((item) => item.id)).toEqual(["a"]);

		const dir = dirname(dropped[0].storedPath);
		mkdirSync(dir, { recursive: true });
		writeFileSync(dropped[0].storedPath, "x");
		deleteSharedArtifactFiles(dropped);
		expect(existsSync(dir)).toBe(false);
	});
});

describe("stored artifact read boundary", () => {
	it("rejects traversal-shaped records supplied by the renderer", () => {
		const forged = {
			...artifact("forged"),
			storedPath: `${TEST_HOME}/worktrees/x/shared-artifacts/id/../../../../secret.txt`,
		};
		expect(() => loadSharedArtifactContent(forged)).toThrow(SharedArtifactError);
		expect(() => loadSharedArtifactDownload(forged)).toThrow(SharedArtifactError);
	});
});
