import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/shared-images`);

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
	OPS_DIR: `${TEST_HOME}/ops`,
}));

import { MAX_SHARED_IMAGE_BYTES, MAX_SHARED_MEDIA_BYTES } from "../../shared/types";
import { SharedImageError, imageExt, isSupportedImage, saveSharedClip, saveSharedClips, saveSharedImage, sharedImagesDir } from "../shared-images";

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

describe("saveSharedClip", () => {
	beforeEach(() => {
		rmSync(sharedImagesDir("/my/project"), { recursive: true, force: true });
	});

	it("copies an MP4 into the same store as images, marked by a video mime", async () => {
		const src = join(SRC_DIR, "demo.mp4");
		writeFileSync(src, MP4_HEAD);
		const rec = await saveSharedClip("/my/project", src, " watch the spinner ");

		expect(rec.storedPath.startsWith(`${TEST_HOME}/worktrees/my-project/shared-images/`)).toBe(true);
		expect(rec.storedPath.endsWith(".mp4")).toBe(true);
		expect(rec.mime).toBe("video/mp4");
		expect(rec.caption).toBe("watch the spinner");
		expect(rec.isUnread).toBe(true);
		expect(readFileSync(rec.storedPath).equals(MP4_HEAD)).toBe(true);
		expect(readdirSync(sharedImagesDir("/my/project")).some((f) => f.endsWith(".partial"))).toBe(false);
	});

	it("accepts a WebM by its EBML signature", async () => {
		const src = join(SRC_DIR, "qa.webm");
		writeFileSync(src, WEBM_HEAD);
		expect((await saveSharedClip("/my/project", src)).mime).toBe("video/webm");
	});

	it("rejects a renamed file whose container signature is missing", async () => {
		const src = join(SRC_DIR, "fake.mp4");
		writeFileSync(src, "definitely not a movie");
		await expect(saveSharedClip("/my/project", src)).rejects.toThrow(/Not a real MP4 file/);
		const webm = join(SRC_DIR, "fake.webm");
		writeFileSync(webm, MP4_HEAD);
		await expect(saveSharedClip("/my/project", webm)).rejects.toThrow(/Not a real WEBM file/);
	});

	it("rejects other containers, unsupported audio and images", async () => {
		for (const name of ["clip.mov", "clip.mkv", "track.flac", "track.opus", "track.aac", "shot.png"]) {
			const src = join(SRC_DIR, name);
			writeFileSync(src, MP4_HEAD);
			await expect(saveSharedClip("/my/project", src)).rejects.toThrow(/Unsupported media type/);
		}
	});

	it.each([
		["tone.mp3", Buffer.concat([Buffer.from("ID3"), Buffer.alloc(16)]), "audio/mpeg"],
		["bare.mp3", Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(16)]), "audio/mpeg"],
		["tone.m4a", MP4_HEAD, "audio/mp4"],
		["tone.wav", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)]), "audio/wav"],
		["tone.ogg", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(16)]), "audio/ogg"],
	])("accepts audio %s by its container signature, marked %s", async (name, head, mime) => {
		const src = join(SRC_DIR, name);
		writeFileSync(src, head);
		const rec = await saveSharedClip("/my/project", src, "listen");
		expect(rec.mime).toBe(mime);
		expect(rec.storedPath.endsWith(`.${name.split(".").pop()}`)).toBe(true);
		expect(rec.caption).toBe("listen");
	});

	it.each([
		["fake.mp3", "not an mpeg stream", /Not a real MP3 file/],
		["fake.wav", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("AVI "), Buffer.alloc(8)]), /Not a real WAV file/],
		["fake.ogg", "OggX", /Not a real OGG file/],
		["fake.m4a", "ID3 tagged mp3 renamed", /Not a real M4A file/],
		["empty.mp3", "", /Not a real MP3 file/],
	])("rejects a renamed %s", async (name, body, error) => {
		const src = join(SRC_DIR, name);
		writeFileSync(src, body);
		await expect(saveSharedClip("/my/project", src)).rejects.toThrow(error);
	});

	it("caps clips at exactly 300 MB: one byte below and at the cap copy, one byte over is refused with exact sizes", async () => {
		expect(MAX_SHARED_MEDIA_BYTES).toBe(300 * 1024 * 1024);
		const src = join(SRC_DIR, "long.mp4");
		for (const size of [MAX_SHARED_MEDIA_BYTES - 1, MAX_SHARED_MEDIA_BYTES]) {
			writeFileSync(src, MP4_HEAD);
			truncateSync(src, size);
			const rec = await saveSharedClip("/my/project", src);
			expect(rec.bytes).toBe(size);
			rmSync(rec.storedPath);
		}
		writeFileSync(src, MP4_HEAD);
		truncateSync(src, MAX_SHARED_MEDIA_BYTES + 1);
		await expect(saveSharedClip("/my/project", src)).rejects.toThrow(
			"Media file too large (314,572,801 bytes; max 300 MB = 314,572,800 bytes)",
		);
		await expect(saveSharedClip("/my/project", src)).rejects.toThrow(/Trim or re-encode/);
		rmSync(src);
	});

	it("leaves the image cap at 25 MB", () => {
		expect(MAX_SHARED_IMAGE_BYTES).toBe(25 * 1024 * 1024);
		const src = join(SRC_DIR, "huge.png");
		writeFileSync(src, "");
		truncateSync(src, MAX_SHARED_IMAGE_BYTES + 1);
		expect(() => saveSharedImage("/my/project", src)).toThrow("Image too large (26,214,401 bytes; max 25 MB = 26,214,400 bytes)");
		rmSync(src);
	});

	it("keeps the path protections of show-image", async () => {
		await expect(saveSharedClip("/my/project", "rel/a.mp4")).rejects.toThrow(SharedImageError);
		await expect(saveSharedClip("/my/project", "/a/../b.mp4")).rejects.toThrow(SharedImageError);
		await expect(saveSharedClip("/my/project", join(SRC_DIR, "missing.mp4"))).rejects.toThrow(/File not found/);
		await expect(saveSharedClip("/my/project", SRC_DIR)).rejects.toThrow(/Not a file/);
	});

	it("validates a whole batch before copying any clip", async () => {
		const good = join(SRC_DIR, "good.mp4");
		writeFileSync(good, MP4_HEAD);
		const bad = join(SRC_DIR, "bad.mp4");
		writeFileSync(bad, "nope");
		await expect(saveSharedClips("/my/project", [{ path: good }, { path: bad }])).rejects.toThrow(/Not a real MP4 file/);
		expect(existsSync(sharedImagesDir("/my/project")) ? readdirSync(sharedImagesDir("/my/project")) : []).toEqual([]);
	});

	it("does not let show-image take a clip", () => {
		for (const name of ["sneaky.mp4", "sneaky.mp3"]) {
			const src = join(SRC_DIR, name);
			writeFileSync(src, MP4_HEAD);
			expect(() => saveSharedImage("/my/project", src)).toThrow(/Unsupported image type/);
		}
	});
});
