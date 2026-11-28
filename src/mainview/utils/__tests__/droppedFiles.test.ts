import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ resolveDroppedFilePaths: vi.fn(), uploadFileBase64: vi.fn() }));
vi.mock("../../rpc", () => ({ api: { request } }));

import { dropEntriesToTerminalText, dropEntryError, placeDroppedFiles, quotePath } from "../droppedFiles";
import { MAX_UPLOAD_FILE_SIZE } from "../uploadDroppedFile";

type WithWebview = { __electrobunWebviewId?: number };

/** A File that reports `size` without allocating it. */
function sizedFile(name: string, size: number): File {
	const f = new File(["x"], name, { lastModified: 1_700_000_000_000 });
	Object.defineProperty(f, "size", { value: size });
	return f;
}

describe("quotePath", () => {
	it("keeps spaces and unicode inside POSIX single quotes", () => {
		expect(quotePath("/Users/me/My Drive/Ашкелон. Без шлема (1080p).mp4", "posix")).toBe("'/Users/me/My Drive/Ашкелон. Без шлема (1080p).mp4'");
	});

	it("leaves $, backticks, backslashes, double quotes and ! literal, and spells ' as '\\''", () => {
		expect(quotePath(`/a/say "hi" $HOME \`id\` back\\slash Wow!v2 it's.mp4`, "posix"))
			.toBe(`'/a/say "hi" $HOME \`id\` back\\slash Wow!v2 it'\\''s.mp4'`);
	});

	it("uses PowerShell's backtick escape, typographic quotes included, and leaves Windows backslashes alone", () => {
		expect(quotePath("C:\\Users\\me\\$cash `tick` \"q\" \u201csmart\u201d.mp4", "powershell"))
			.toBe('"C:\\Users\\me\\`$cash ``tick`` `"q`" `\u201csmart`\u201d.mp4"');
	});
});

describe("placeDroppedFiles", () => {
	beforeEach(() => {
		request.resolveDroppedFilePaths.mockReset();
		request.uploadFileBase64.mockReset().mockImplementation(async ({ filename }: { filename: string }) => ({ path: `/wt/uploads/${filename}` }));
	});
	afterEach(() => {
		delete (window as unknown as WithWebview).__electrobunWebviewId;
	});

	it("uploads small files and asks the host only for the oversized ones, keeping drop order", async () => {
		(window as unknown as WithWebview).__electrobunWebviewId = 1;
		request.resolveDroppedFilePaths.mockResolvedValue(["/Users/me/big one.mov"]);
		const entries = await placeDroppedFiles("p1", [sizedFile("a.txt", 3), sizedFile("big one.mov", MAX_UPLOAD_FILE_SIZE + 1)]);

		expect(request.resolveDroppedFilePaths).toHaveBeenCalledWith({ files: [{ name: "big one.mov", size: MAX_UPLOAD_FILE_SIZE + 1, lastModified: 1_700_000_000_000 }] });
		expect(request.uploadFileBase64).toHaveBeenCalledTimes(1);
		expect(entries).toEqual([
			{ kind: "uploaded", path: "/wt/uploads/a.txt" },
			{ kind: "host", path: "/Users/me/big one.mov", name: "big one.mov" },
		]);
	});

	it("still uploads a file of exactly the limit", async () => {
		(window as unknown as WithWebview).__electrobunWebviewId = 1;
		const entries = await placeDroppedFiles("p1", [sizedFile("edge.bin", MAX_UPLOAD_FILE_SIZE)]);
		expect(request.resolveDroppedFilePaths).not.toHaveBeenCalled();
		expect(entries).toEqual([{ kind: "uploaded", path: "/wt/uploads/edge.bin" }]);
	});

	it("keeps the plain error when the host cannot prove a path", async () => {
		(window as unknown as WithWebview).__electrobunWebviewId = 1;
		request.resolveDroppedFilePaths.mockResolvedValue([null]);
		expect(await placeDroppedFiles("p1", [sizedFile("big.mov", MAX_UPLOAD_FILE_SIZE + 1)])).toEqual([{ kind: "tooLarge", name: "big.mov", remote: false }]);
	});

	it("refuses a host path carrying control characters even if the host returned one", async () => {
		(window as unknown as WithWebview).__electrobunWebviewId = 1;
		request.resolveDroppedFilePaths.mockResolvedValue(["/tmp/x\";rm -rf ~\r.mov"]);
		expect(await placeDroppedFiles("p1", [sizedFile("big.mov", MAX_UPLOAD_FILE_SIZE + 1)])).toEqual([{ kind: "tooLarge", name: "big.mov", remote: false }]);
	});

	it("never asks the host in remote mode: the file is on the viewer's device", async () => {
		const entries = await placeDroppedFiles("p1", [sizedFile("big.mov", MAX_UPLOAD_FILE_SIZE + 1)]);
		expect(request.resolveDroppedFilePaths).not.toHaveBeenCalled();
		expect(entries).toEqual([{ kind: "tooLarge", name: "big.mov", remote: true }]);
	});
});

describe("dropEntryError", () => {
	const t = (key: string, vars: Record<string, string>) => `${key}:${Object.values(vars).join(",")}`;

	it("keeps an error toast for every file that was not uploaded, and none for an upload", () => {
		expect(dropEntryError({ kind: "uploaded", path: "/x" }, t)).toBeNull();
		expect(dropEntryError({ kind: "host", path: "/x/big.mov", name: "big.mov" }, t)).toBe("fileDrop.tooLargePathInserted:big.mov");
		expect(dropEntryError({ kind: "tooLarge", name: "big.mov", remote: true }, t)).toBe("fileDrop.tooLargeRemote:big.mov");
		expect(dropEntryError({ kind: "tooLarge", name: "big.mov", remote: false }, t)).toBe("fileDrop.tooLargeNoPath:big.mov");
		expect(dropEntryError({ kind: "failed", name: "a", error: "boom" }, t)).toBe("fileDrop.uploadFailed:boom");
	});
});

describe("dropEntriesToTerminalText", () => {
	it("types a mixed drop as escaped uploads and quoted original paths, space-separated, skipping failures", () => {
		expect(dropEntriesToTerminalText([
			{ kind: "uploaded", path: "/wt/uploads/my notes.txt" },
			{ kind: "host", path: "/Users/me/My Drive/big \"cut\".mov", name: "big \"cut\".mov" },
			{ kind: "tooLarge", name: "other.mov", remote: false },
			{ kind: "host", path: "/Users/me/Видео.mp4", name: "Видео.mp4" },
		], "posix")).toBe(`/wt/uploads/my\\ notes.txt '/Users/me/My Drive/big "cut".mov' '/Users/me/Видео.mp4'`);
	});
});
