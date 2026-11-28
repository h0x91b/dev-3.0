import { describe, it, expect, vi } from "vitest";

vi.mock("electrobun/bun", () => ({
	PATHS: { VIEWS_FOLDER: "/fake-bundle/Resources/app/views/" },
	Utils: {},
	Updater: {},
}));
const ffi = vi.hoisted(() => ({ dlopen: vi.fn() }));
vi.mock("bun:ffi", () => ({ dlopen: ffi.dlopen, FFIType: { ptr: "ptr", i32: "i32" }, ptr: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs")>()), existsSync: () => true }));

import { decodePathList, matchDroppedFiles, resolveDroppedFilePaths, type FileFacts } from "../drag-file-paths";
import { runAsRemoteRpc } from "../rpc-origin";

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
		expect(matchDroppedFiles([{ name: "Без шлема.mov".normalize("NFC"), size: 9, lastModified: MTIME }], [path], facts({ [path]: file(9) }))).toEqual([path]);
	});

	it("refuses a size or mtime mismatch instead of guessing — a stale pasteboard from an older drag", () => {
		const path = "/tmp/a/movie.mp4";
		const stat = facts({ [path]: file(100) });
		expect(matchDroppedFiles([{ name: "movie.mp4", size: 101, lastModified: MTIME }], [path], stat)).toEqual([null]);
		expect(matchDroppedFiles([{ name: "movie.mp4", size: 100, lastModified: MTIME - 5000 }], [path], stat)).toEqual([null]);
	});

	it("refuses an ambiguous match, a directory, and a path that no longer exists", () => {
		const a = "/one/movie.mp4";
		const b = "/two/movie.mp4";
		const dir = "/three/folder";
		const stat = facts({ [a]: file(7), [b]: file(7), [dir]: { isFile: false, size: 7, mtimeMs: MTIME } });
		expect(matchDroppedFiles([{ name: "movie.mp4", size: 7, lastModified: MTIME }], [a, b], stat)).toEqual([null]);
		expect(matchDroppedFiles([{ name: "folder", size: 7, lastModified: MTIME }], [dir], stat)).toEqual([null]);
		expect(matchDroppedFiles([{ name: "gone.mp4", size: 7, lastModified: MTIME }], ["/x/gone.mp4"], stat)).toEqual([null]);
	});
});

describe("matchDroppedFiles refusals", () => {
	it("refuses a file the webview reported no mtime for, so a match never rests on name and size alone", () => {
		const path = "/tmp/a/movie.mp4";
		expect(matchDroppedFiles([{ name: "movie.mp4", size: 100, lastModified: 0 }], [path], facts({ [path]: file(100) }))).toEqual([null]);
	});

	it.each([
		["a line-editing key sequence", 'x"\u0002\u0008\u0005;touch /tmp/PWNED;#\r.mp4'],
		["a newline", "two\nlines.mp4"],
		["DEL", "del\u007f.mp4"],
		["a C1 control", "csi\u009b.mp4"],
	])("refuses a path whose name carries %s — it would be typed into the pty as keystrokes", (_label, name) => {
		const path = `/tmp/drop/${name}`;
		expect(matchDroppedFiles([{ name, size: 100, lastModified: MTIME }], [path], facts({ [path]: file(100) }))).toEqual([null]);
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

describe("resolveDroppedFilePaths", () => {
	it("answers a remote viewer with nulls without touching the host pasteboard", async () => {
		const files = [{ name: "big.mov", size: 200_000_000, lastModified: MTIME }];
		expect(await runAsRemoteRpc(async () => resolveDroppedFilePaths(files))).toEqual([null]);
		expect(ffi.dlopen).not.toHaveBeenCalled();
	});
});
