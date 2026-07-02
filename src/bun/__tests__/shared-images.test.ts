import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SharedImage } from "../../shared/types";

// vi.mock is hoisted above module init, so the factory must use a literal path.
vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/dev3-shared-images-test",
	OPS_DIR: "/tmp/dev3-shared-images-test/ops",
}));

const TEST_HOME = "/tmp/dev3-shared-images-test";

import {
	SharedImageError,
	deleteSharedImageFiles,
	imageExt,
	isSupportedImage,
	pruneSharedImages,
	saveSharedImage,
	sharedImagesDir,
} from "../shared-images";

const SRC_DIR = mkdtempSync(join(tmpdir(), "dev3-shared-src-"));

afterAll(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	rmSync(SRC_DIR, { recursive: true, force: true });
});

function makeImage(id: string, createdAt: number): SharedImage {
	return {
		id,
		storedPath: `${TEST_HOME}/x/${id}.png`,
		originalPath: `/src/${id}.png`,
		name: `${id}.png`,
		mime: "image/png",
		bytes: 10,
		createdAt,
	};
}

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

describe("pruneSharedImages", () => {
	it("keeps everything when under the cap", () => {
		const existing = [makeImage("a", 1), makeImage("b", 2)];
		const incoming = [makeImage("c", 3)];
		const { kept, dropped } = pruneSharedImages(existing, incoming, 50);
		expect(kept.map((i) => i.id)).toEqual(["a", "b", "c"]);
		expect(dropped).toEqual([]);
	});

	it("drops the oldest when over the cap, keeping newest in order", () => {
		const existing = [makeImage("a", 1), makeImage("b", 2), makeImage("c", 3)];
		const incoming = [makeImage("d", 4)];
		const { kept, dropped } = pruneSharedImages(existing, incoming, 2);
		expect(kept.map((i) => i.id)).toEqual(["c", "d"]);
		expect(dropped.map((i) => i.id)).toEqual(["a", "b"]);
	});

	it("treats undefined existing as empty", () => {
		const { kept, dropped } = pruneSharedImages(undefined, [makeImage("a", 1)], 50);
		expect(kept.map((i) => i.id)).toEqual(["a"]);
		expect(dropped).toEqual([]);
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
		expect(existsSync(rec.storedPath)).toBe(true);
		expect(readFileSync(rec.storedPath, "utf8")).toBe("PNGDATA");
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

describe("deleteSharedImageFiles", () => {
	it("removes the stored files and never throws on a missing one", () => {
		const src = join(SRC_DIR, "todelete.png");
		writeFileSync(src, "X");
		const rec = saveSharedImage("/my/project", src);
		expect(existsSync(rec.storedPath)).toBe(true);
		deleteSharedImageFiles([rec, makeImage("ghost", 1)]);
		expect(existsSync(rec.storedPath)).toBe(false);
	});
});
