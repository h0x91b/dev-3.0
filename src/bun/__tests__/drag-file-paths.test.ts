import { describe, it, expect, vi } from "vitest";

vi.mock("electrobun/bun", () => ({
	PATHS: { VIEWS_FOLDER: "/fake-bundle/Resources/app/views/" },
	Utils: {},
	Updater: {},
}));
vi.mock("bun:ffi", () => ({ dlopen: vi.fn(), FFIType: { ptr: "ptr", i32: "i32" }, ptr: vi.fn() }));

import { decodePathList, matchDroppedFiles, type FileFacts } from "../drag-file-paths";

const MTIME = 1_764_300_000_123.4;
const facts = (table: Record<string, FileFacts>) => (path: string) => table[path] ?? null;
const file = (size: number, mtimeMs = MTIME): FileFacts => ({ isFile: true, size, mtimeMs });

describe("matchDroppedFiles", () => {
	it("returns the one path whose name, size and mtime match, in drop order", () => {
		const big = "/Users/me/My Drive/Ашкелон. Без шлема (1080p).mp4";
		const other = "/Users/me/My Drive/cover.png";
		const stat = facts({ [big]: file(200_000_000), [other]: file(5) });
		expect(matchDroppedFiles(
			[{ name: "cover.png", size: 5, lastModified: Math.floor(MTIME) }, { name: "Ашкелон. Без шлема (1080p).mp4", size: 200_000_000, lastModified: Math.floor(MTIME) }],
			[big, other],
			stat,
		)).toEqual([other, big]);
	});

	it("matches a decomposed (NFD) file-system name against the composed name the webview reports", () => {
		const path = "/tmp/Ashkelon/Без шлема.mov".normalize("NFD");
		expect(matchDroppedFiles([{ name: "Без шлема.mov".normalize("NFC"), size: 9, lastModified: 0 }], [path], facts({ [path]: file(9) }))).toEqual([path]);
	});

	it("refuses a size or mtime mismatch instead of guessing — a stale pasteboard from an older drag", () => {
		const path = "/tmp/a/movie.mp4";
		const stat = facts({ [path]: file(100) });
		expect(matchDroppedFiles([{ name: "movie.mp4", size: 101, lastModified: 0 }], [path], stat)).toEqual([null]);
		expect(matchDroppedFiles([{ name: "movie.mp4", size: 100, lastModified: MTIME - 5000 }], [path], stat)).toEqual([null]);
	});

	it("refuses an ambiguous match, a directory, and a path that no longer exists", () => {
		const a = "/one/movie.mp4";
		const b = "/two/movie.mp4";
		const dir = "/three/folder";
		const stat = facts({ [a]: file(7), [b]: file(7), [dir]: { isFile: false, size: 7, mtimeMs: MTIME } });
		expect(matchDroppedFiles([{ name: "movie.mp4", size: 7, lastModified: 0 }], [a, b], stat)).toEqual([null]);
		expect(matchDroppedFiles([{ name: "folder", size: 7, lastModified: 0 }], [dir], stat)).toEqual([null]);
		expect(matchDroppedFiles([{ name: "gone.mp4", size: 7, lastModified: 0 }], ["/x/gone.mp4"], stat)).toEqual([null]);
	});
});

describe("decodePathList", () => {
	it("splits the shim's NUL-separated UTF-8 paths, keeping spaces, quotes and unicode", () => {
		const paths = ["/a b/\"quoted\" $x.mp4", "/Ашкелон/файл.png"];
		const bytes = new TextEncoder().encode(paths.map((p) => `${p}\0`).join(""));
		expect(decodePathList(bytes)).toEqual(paths);
		expect(decodePathList(new Uint8Array())).toEqual([]);
	});
});
