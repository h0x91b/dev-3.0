import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SharedArtifact } from "../../shared/types";
import { MAX_SHARED_ARTIFACT_VIDEO_BYTES } from "../../shared/types";
import { TINY_MP4, TINY_WEBM } from "./fixtures/tiny-clips";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/shared-artifacts`);

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
	OPS_DIR: `${TEST_HOME}/ops`,
}));

const SRC_DIR = mkdtempSync(join(tmpdir(), "dev3-artifact-src-"));

import {
	SharedArtifactError,
	injectArtifactThemeContract,
	loadSharedArtifactContent,
	loadSharedArtifactDownload,
	saveSharedArtifact,
	sharedArtifactHtmlPath,
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

	it("stamps the grouping key from the resolved title, the slug, or --new", () => {
		const html = join(SRC_DIR, "keyed.html");
		writeFileSync(html, "<!doctype html><h1>Keyed</h1>");

		expect(saveSharedArtifact("/my/project", html, [], "  Weekly   Report ").groupKey).toBe("title:weekly report");
		// No --title: the key falls back to the HTML basename, exactly like the title.
		expect(saveSharedArtifact("/my/project", html, []).groupKey).toBe("title:keyed");
		expect(saveSharedArtifact("/my/project", html, [], "Anything", { artifactId: "Weekly" }).groupKey).toBe("id:weekly");
		const forced = saveSharedArtifact("/my/project", html, [], "Weekly Report", { forceNew: true });
		expect(forced.groupKey).toBe(`new:${forced.id}`);
		expect(forced.version).toBe(1);
	});

	it("keeps one directory per publish, so versioning never reshapes storage", () => {
		const html = join(SRC_DIR, "twice.html");
		writeFileSync(html, "<!doctype html><h1>Twice</h1>");
		const first = saveSharedArtifact("/my/project", html, [], "Same title");
		const second = saveSharedArtifact("/my/project", html, [], "Same title");
		expect(first.groupKey).toBe(second.groupKey);
		expect(dirname(first.storedPath)).not.toBe(dirname(second.storedPath));
		expect(existsSync(first.storedPath)).toBe(true);
		expect(existsSync(second.storedPath)).toBe(true);
	});

	it("copies HTML and local assets into one portable bundle", () => {
		const html = join(SRC_DIR, "report.html");
		const image = join(SRC_DIR, "chart.png");
		const css = join(SRC_DIR, "app.css");
		const script = join(SRC_DIR, "app.js");
		writeFileSync(html, '<!doctype html><link rel="stylesheet" href="app.css"><img src="chart.png"><script src="app.js"></script>');
		writeFileSync(image, "PNGDATA");
		writeFileSync(css, "body { color: red; }");
		writeFileSync(script, "document.body.dataset.ready = 'true';");

		const saved = saveSharedArtifact("/my/project", html, [css, script, image], "Quarterly report");

		expect(saved.title).toBe("Quarterly report");
		expect(saved.isUnread).toBe(true);
		expect(saved.name).toBe("report.html");
		expect(saved.assets.map((item) => [item.name, item.mime])).toEqual([
			["app.css", "text/css"],
			["app.js", "text/javascript"],
			["chart.png", "image/png"],
		]);
		expect(dirname(saved.assets[0].storedPath)).toBe(dirname(saved.storedPath));
		expect(readFileSync(saved.storedPath, "utf8")).toContain("data-dev3-artifact-shell");
		expect(readFileSync(saved.assets[0].storedPath, "utf8")).toBe("body { color: red; }");
		expect(readFileSync(saved.assets[1].storedPath, "utf8")).toContain("dataset.ready");
		expect(readFileSync(saved.assets[2].storedPath, "utf8")).toBe("PNGDATA");
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

	it("names the download from the title, sanitizing separators and illegal characters", () => {
		const html = join(SRC_DIR, "index.html");
		const image = join(SRC_DIR, "pic.png");
		writeFileSync(html, '<!doctype html><img src="pic.png">');
		writeFileSync(image, "PNGDATA");
		const saved = saveSharedArtifact("/my/project", html, [image], 'Q4 Revenue / "Draft"');
		expect(basename(saved.bundlePath!)).toBe("index.zip");
		expect(loadSharedArtifactDownload(saved).fileName).toBe("Q4 Revenue Draft.zip");
	});

	it("falls back to the HTML basename when the title yields no usable stem", () => {
		const html = join(SRC_DIR, "index.html");
		writeFileSync(html, "<!doctype html><p>Hi</p>");
		const saved = { ...saveSharedArtifact("/my/project", html, []), title: "///" };
		expect(loadSharedArtifactDownload(saved).fileName).toBe("index.html");
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

	it("labels text asset data URLs as UTF-8", () => {
		const html = join(SRC_DIR, "localized.html");
		const css = join(SRC_DIR, "localized.css");
		const script = join(SRC_DIR, "localized.js");
		writeFileSync(html, '<!doctype html><link rel="stylesheet" href="localized.css"><script src="localized.js"></script>');
		writeFileSync(css, '.label::before { content: "Hello ✓ 🌍"; }');
		writeFileSync(script, 'document.body.textContent = "Hello ✓ 🌍";');

		const payload = loadSharedArtifactContent(saveSharedArtifact("/my/project", html, [css, script]));
		const stylesheet = payload.assets.find((asset) => asset.name === "localized.css");
		const javascript = payload.assets.find((asset) => asset.name === "localized.js");

		expect(stylesheet?.dataUrl).toMatch(/^data:text\/css;charset=utf-8;base64,/);
		expect(javascript?.dataUrl).toMatch(/^data:text\/javascript;charset=utf-8;base64,/);
		expect(Buffer.from(stylesheet?.dataUrl.split(",", 2)[1] ?? "", "base64").toString("utf8")).toContain("Hello ✓ 🌍");
		expect(Buffer.from(javascript?.dataUrl.split(",", 2)[1] ?? "", "base64").toString("utf8")).toContain("Hello ✓ 🌍");
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

	it("rewrites local URLs inside copied stylesheets for sandbox rendering", () => {
		const root = join(SRC_DIR, "css-assets");
		const styles = join(root, "styles");
		const images = join(root, "images");
		mkdirSync(styles, { recursive: true });
		mkdirSync(images, { recursive: true });
		const html = join(root, "index.html");
		const css = join(styles, "app.css");
		const image = join(images, "background.png");
		writeFileSync(html, '<!doctype html><link rel="stylesheet" href="styles/app.css">');
		writeFileSync(css, '.hero { background-image: url("../images/background.png"); }');
		writeFileSync(image, "PNGDATA");

		const saved = saveSharedArtifact("/my/project", html, [css, image]);
		const payload = loadSharedArtifactContent(saved);
		const stylesheet = payload.assets.find((asset) => asset.name === "styles/app.css");
		const encoded = stylesheet?.dataUrl.split(",", 2)[1] ?? "";
		const renderedCss = Buffer.from(encoded, "base64").toString("utf8");

		expect(renderedCss).toContain("data:image/png;base64,");
		expect(renderedCss).not.toContain("../images/background.png");
	});

	it("rewrites nested CSS imports and their local URLs for sandbox rendering", () => {
		const root = join(SRC_DIR, "css-imports");
		const styles = join(root, "styles");
		const images = join(root, "images");
		mkdirSync(styles, { recursive: true });
		mkdirSync(images, { recursive: true });
		const html = join(root, "index.html");
		const appCss = join(styles, "app.css");
		const themeCss = join(styles, "theme.css");
		const image = join(images, "texture.png");
		writeFileSync(html, '<!doctype html><link rel="stylesheet" href="styles/app.css">');
		writeFileSync(appCss, '@import "./theme.css" screen;');
		writeFileSync(themeCss, '.card { background: url("../images/texture.png"); }');
		writeFileSync(image, "PNGDATA");

		const saved = saveSharedArtifact("/my/project", html, [appCss, themeCss, image]);
		const payload = loadSharedArtifactContent(saved);
		const stylesheet = payload.assets.find((asset) => asset.name === "styles/app.css");
		const renderedCss = Buffer.from(stylesheet?.dataUrl.split(",", 2)[1] ?? "", "base64").toString("utf8");
		const importedDataUrl = renderedCss.match(/@import "(data:text\/css;charset=utf-8;base64,[^"]+)"/)?.[1];
		const importedCss = Buffer.from(importedDataUrl?.split(",", 2)[1] ?? "", "base64").toString("utf8");

		expect(renderedCss).not.toContain("./theme.css");
		expect(importedCss).toContain("data:image/png;base64,");
		expect(importedCss).not.toContain("../images/texture.png");
	});

	it("rejects assets outside the HTML directory instead of creating a broken bundle", () => {
		const htmlDir = join(SRC_DIR, "contained");
		mkdirSync(htmlDir, { recursive: true });
		const html = join(htmlDir, "report.html");
		const image = join(SRC_DIR, "outside.png");
		writeFileSync(html, '<!doctype html><img src="../outside.png">');
		writeFileSync(image, "PNGDATA");
		expect(() => saveSharedArtifact("/my/project", html, [image])).toThrow(/inside the HTML directory/);
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
		expect(() => sharedArtifactHtmlPath(forged)).toThrow(SharedArtifactError);
	});

	it("returns the stored HTML path for the OS browser, and refuses a vanished file", () => {
		const html = join(SRC_DIR, "browser.html");
		writeFileSync(html, "<!doctype html><html><body>Hi</body></html>", "utf8");
		const saved = saveSharedArtifact("/tmp/proj", html, []);
		expect(sharedArtifactHtmlPath(saved)).toBe(saved.storedPath);
		rmSync(saved.storedPath, { force: true });
		expect(() => sharedArtifactHtmlPath(saved)).toThrow(SharedArtifactError);
	});
});

/** Read the ZIP back with an independent inflater, so "it is in the bundle" means the bytes are. */
function unzipEntries(zip: Buffer): Map<string, Buffer> {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const entries = new Map<string, Buffer>();
	let offset = 0;
	while (offset + 30 <= zip.byteLength && view.getUint32(offset, true) === 0x04034b50) {
		const method = view.getUint16(offset + 8, true);
		const compressedSize = view.getUint32(offset + 18, true);
		const nameLength = view.getUint16(offset + 26, true);
		const extraLength = view.getUint16(offset + 28, true);
		const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
		const dataOffset = offset + 30 + nameLength + extraLength;
		const data = zip.subarray(dataOffset, dataOffset + compressedSize);
		entries.set(name, method === 8 ? Buffer.from(inflateRawSync(data)) : Buffer.from(data));
		offset = dataOffset + compressedSize;
	}
	return entries;
}

describe("bundled video assets", () => {
	beforeEach(() => rmSync(TEST_HOME, { recursive: true, force: true }));

	function clipDir(name: string): { html: string; mp4: string; webm: string; poster: string } {
		const root = join(SRC_DIR, name);
		const nested = join(root, "clips and posters");
		mkdirSync(nested, { recursive: true });
		const html = join(root, "index.html");
		const mp4 = join(nested, "tour take 1.mp4");
		const webm = join(nested, "tour take 1.webm");
		const poster = join(nested, "tour.png");
		writeFileSync(html, [
			"<!doctype html><html><head></head><body>",
			'<video controls playsinline preload="metadata" poster="clips and posters/tour.png">',
			'<source src="clips and posters/tour take 1.webm" type="video/webm">',
			'<source src="clips and posters/tour take 1.mp4" type="video/mp4">',
			"</video></body></html>",
		].join(""));
		writeFileSync(mp4, TINY_MP4);
		writeFileSync(webm, TINY_WEBM);
		writeFileSync(poster, "PNGDATA");
		return { html, mp4, webm, poster };
	}

	it("stores real MP4/WebM clips byte-exact, with their own MIME types and a nested name", () => {
		const { html, mp4, webm, poster } = clipDir("video-store");
		const saved = saveSharedArtifact("/my/project", html, [mp4, webm, poster], "Video report");

		expect(saved.assets.map((asset) => [asset.name, asset.mime])).toEqual([
			["clips and posters/tour take 1.mp4", "video/mp4"],
			["clips and posters/tour take 1.webm", "video/webm"],
			["clips and posters/tour.png", "image/png"],
		]);
		expect(readFileSync(saved.assets[0].storedPath).equals(TINY_MP4)).toBe(true);
		expect(readFileSync(saved.assets[1].storedPath).equals(TINY_WEBM)).toBe(true);
		expect(saved.assets[0].bytes).toBe(TINY_MP4.byteLength);
	});

	it("hands clips to the viewer as playable data URLs and keeps them in the ZIP", () => {
		const { html, mp4, webm, poster } = clipDir("video-load");
		const saved = saveSharedArtifact("/my/project", html, [mp4, webm, poster], "Video report");
		const content = loadSharedArtifactContent(saved);

		const clip = content.assets.find((asset) => asset.name.endsWith(".mp4"))!;
		expect(clip.mime).toBe("video/mp4");
		expect(clip.dataUrl.startsWith("data:video/mp4;base64,")).toBe(true);
		// The payload is the file itself, so what the media element decodes is what ffmpeg wrote.
		expect(Buffer.from(clip.dataUrl.split(",")[1], "base64").equals(TINY_MP4)).toBe(true);
		expect(content.assets.find((asset) => asset.name.endsWith(".webm"))!.mime).toBe("video/webm");

		const entries = unzipEntries(readFileSync(saved.bundlePath!));
		expect(entries.get("clips and posters/tour take 1.mp4")!.equals(TINY_MP4)).toBe(true);
		expect(entries.get("clips and posters/tour take 1.webm")!.equals(TINY_WEBM)).toBe(true);
		expect(loadSharedArtifactDownload(saved).fileName).toBe("Video report.zip");
	});

	it("names the file and the fix when a clip or the whole set is too big", () => {
		const root = join(SRC_DIR, "video-limits");
		mkdirSync(root, { recursive: true });
		const html = join(root, "index.html");
		writeFileSync(html, "<!doctype html>");

		const huge = join(root, "huge.mp4");
		writeFileSync(huge, Buffer.alloc(MAX_SHARED_ARTIFACT_VIDEO_BYTES + 1));
		expect(() => saveSharedArtifact("/my/project", html, [huge])).toThrow(/huge\.mp4 is 16 MB \(max 16 MB per clip\)/);
		expect(() => saveSharedArtifact("/my/project", html, [huge])).toThrow(/re-encode at a lower bitrate/);

		// A clip stays under the per-file cap while the set blows the combined one.
		const each = Buffer.alloc(MAX_SHARED_ARTIFACT_VIDEO_BYTES - 1);
		const paths = ["a", "b", "c", "d"].map((name) => {
			const path = join(root, `${name}.webm`);
			writeFileSync(path, each);
			return path;
		});
		expect(() => saveSharedArtifact("/my/project", html, paths)).toThrow(/max 48 MB combined/);
	});

	it("rejects a container the viewer cannot play instead of storing it", () => {
		const root = join(SRC_DIR, "video-reject");
		mkdirSync(root, { recursive: true });
		const html = join(root, "index.html");
		const mov = join(root, "clip.mov");
		writeFileSync(html, "<!doctype html>");
		writeFileSync(mov, TINY_MP4);
		expect(() => saveSharedArtifact("/my/project", html, [mov])).toThrow(/Unsupported artifact asset type "mov"/);
	});
});
