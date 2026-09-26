import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/shared-images`);

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
	OPS_DIR: `${TEST_HOME}/ops`,
}));

import { SharedImageError, imageExt, isSupportedImage, saveSharedImage, saveSharedVideo, sharedImagesDir } from "../shared-images";

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

const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
const WEBM_HEAD = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);

describe("saveSharedVideo", () => {
	beforeEach(() => {
		rmSync(sharedImagesDir("/my/project"), { recursive: true, force: true });
	});

	it("copies an MP4 into the same store as images, marked by a video mime", () => {
		const src = join(SRC_DIR, "demo.mp4");
		writeFileSync(src, MP4_HEAD);
		const rec = saveSharedVideo("/my/project", src, " watch the spinner ");

		expect(rec.storedPath.startsWith(`${TEST_HOME}/worktrees/my-project/shared-images/`)).toBe(true);
		expect(rec.storedPath.endsWith(".mp4")).toBe(true);
		expect(rec.mime).toBe("video/mp4");
		expect(rec.caption).toBe("watch the spinner");
		expect(rec.isUnread).toBe(true);
		expect(readFileSync(rec.storedPath).equals(MP4_HEAD)).toBe(true);
	});

	it("accepts a WebM by its EBML signature", () => {
		const src = join(SRC_DIR, "qa.webm");
		writeFileSync(src, WEBM_HEAD);
		expect(saveSharedVideo("/my/project", src).mime).toBe("video/webm");
	});

	it("rejects a renamed file whose container signature is missing", () => {
		const src = join(SRC_DIR, "fake.mp4");
		writeFileSync(src, "definitely not a movie");
		expect(() => saveSharedVideo("/my/project", src)).toThrow(/Not a real MP4 file/);
		const webm = join(SRC_DIR, "fake.webm");
		writeFileSync(webm, MP4_HEAD);
		expect(() => saveSharedVideo("/my/project", webm)).toThrow(/Not a real WEBM file/);
	});

	it("rejects other containers and images", () => {
		for (const name of ["clip.mov", "clip.mkv", "shot.png"]) {
			const src = join(SRC_DIR, name);
			writeFileSync(src, MP4_HEAD);
			expect(() => saveSharedVideo("/my/project", src)).toThrow(/Unsupported video type/);
		}
	});

	it("rejects a clip over the 25 MB cap and names the fix", () => {
		const src = join(SRC_DIR, "long.mp4");
		writeFileSync(src, MP4_HEAD);
		truncateSync(src, 25 * 1024 * 1024 + 1);
		expect(() => saveSharedVideo("/my/project", src)).toThrow(/Video too large .*max 25 MB.*Trim or re-encode/);
	});

	it("keeps the path protections of show-image", () => {
		expect(() => saveSharedVideo("/my/project", "rel/a.mp4")).toThrow(SharedImageError);
		expect(() => saveSharedVideo("/my/project", "/a/../b.mp4")).toThrow(SharedImageError);
		expect(() => saveSharedVideo("/my/project", join(SRC_DIR, "missing.mp4"))).toThrow(/File not found/);
		expect(() => saveSharedVideo("/my/project", SRC_DIR)).toThrow(/Not a file/);
	});

	it("does not let show-image take a video", () => {
		const src = join(SRC_DIR, "sneaky.mp4");
		writeFileSync(src, MP4_HEAD);
		expect(() => saveSharedImage("/my/project", src)).toThrow(/Unsupported image type/);
	});
});
