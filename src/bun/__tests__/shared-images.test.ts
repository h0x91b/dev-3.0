import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/shared-images`);

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
	OPS_DIR: `${TEST_HOME}/ops`,
}));

import { SharedImageError, imageExt, isSupportedImage, saveSharedImage, sharedImagesDir } from "../shared-images";

const SRC_DIR = mkdtempSync(join(tmpdir(), "dev3-shared-src-"));

afterAll(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	rmSync(SRC_DIR, { recursive: true, force: true });
});

describe("imageExt / isSupportedImage", () => {
	it("normalizes the extension to lowercase without the dot", () => {
		expect(imageExt("/a/B/Shot.PNG")).toBe("png");
		expect(imageExt("/a/b/no-ext")).toBe("");
	});

	it("accepts raster types and rejects svg / others", () => {
		expect(isSupportedImage("/a.png")).toBe(true);
		expect(isSupportedImage("/a.jpeg")).toBe(true);
		expect(isSupportedImage("/a.webp")).toBe(true);
		expect(isSupportedImage("/a.svg")).toBe(false);
		expect(isSupportedImage("/a.txt")).toBe(false);
	});
});

describe("saveSharedImage", () => {
	beforeEach(() => {
		rmSync(sharedImagesDir("/my/project"), { recursive: true, force: true });
	});

	it("copies the file into the project worktree shared-images dir", () => {
		const src = join(SRC_DIR, "screenshot.png");
		writeFileSync(src, "PNGDATA");
		const rec = saveSharedImage("/my/project", src);

		expect(rec.storedPath.startsWith(`${TEST_HOME}/worktrees/my-project/shared-images/`)).toBe(true);
		expect(rec.storedPath.endsWith(".png")).toBe(true);
		expect(rec.name).toBe("screenshot.png");
		expect(rec.mime).toBe("image/png");
		expect(rec.originalPath).toBe(src);
		expect(rec.bytes).toBe(Buffer.byteLength("PNGDATA"));
		expect(rec.isUnread).toBe(true);
		expect(existsSync(rec.storedPath)).toBe(true);
		expect(readFileSync(rec.storedPath, "utf8")).toBe("PNGDATA");
	});

	it("stores a trimmed per-image caption when given, omits it otherwise", () => {
		const src = join(SRC_DIR, "caption.png");
		writeFileSync(src, "PNGDATA");
		expect(saveSharedImage("/my/project", src, "  look here  ").caption).toBe("look here");
		expect(saveSharedImage("/my/project", src, "   ").caption).toBeUndefined();
		expect(saveSharedImage("/my/project", src).caption).toBeUndefined();
	});

	it("rejects a relative path", () => {
		expect(() => saveSharedImage("/my/project", "rel/a.png")).toThrow(SharedImageError);
	});

	it("rejects a path containing ..", () => {
		expect(() => saveSharedImage("/my/project", "/a/../b.png")).toThrow(SharedImageError);
	});

	it("rejects a missing file", () => {
		expect(() => saveSharedImage("/my/project", join(SRC_DIR, "nope.png"))).toThrow(/File not found/);
	});

	it("rejects an unsupported type", () => {
		const src = join(SRC_DIR, "notes.txt");
		writeFileSync(src, "hi");
		expect(() => saveSharedImage("/my/project", src)).toThrow(/Unsupported image type/);
	});
});
