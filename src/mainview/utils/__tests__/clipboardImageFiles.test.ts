import { describe, it, expect, vi } from "vitest";
import { imageFilesFromClipboard } from "../clipboardImageFiles";

function pngFile(name: string): File {
	return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asClipboard = (v: unknown) => v as any;

describe("imageFilesFromClipboard", () => {
	it("takes image files straight off the event", () => {
		const file = pngFile("image.png");
		expect(
			imageFilesFromClipboard(asClipboard({ files: [file] })),
			"cause: the paste event's own image file was ignored, so the paste falls back to reading the host clipboard. fix: return clipboardData.files entries whose type starts with image/",
		).toEqual([file]);
	});

	it("ignores non-image files on the event", () => {
		expect(
			imageFilesFromClipboard(asClipboard({ files: [new File(["x"], "a.txt", { type: "text/plain" })] })),
			"cause: a pasted text file was treated as an image. fix: filter on type.startsWith(\"image/\")",
		).toEqual([]);
	});

	it("falls back to items.getAsFile() when the files list is empty", () => {
		const file = pngFile("clip.png");
		const items = [{ kind: "file", type: "image/png", getAsFile: () => file }];
		expect(
			imageFilesFromClipboard(asClipboard({ files: [], items })),
			"cause: a webview that exposes the image only through clipboardData.items is not handled. fix: fall back to items[i].getAsFile()",
		).toEqual([file]);
	});

	it("does not take the same image from both files and items", () => {
		// Chromium populates both for one pasted bitmap; using both attaches it twice.
		const file = pngFile("image.png");
		const getAsFile = vi.fn(() => file);
		const result = imageFilesFromClipboard(
			asClipboard({ files: [file], items: [{ kind: "file", type: "image/png", getAsFile }] }),
		);
		expect(
			result.length,
			"cause: one pasted image produced two uploads. fix: only consult items when the files list yielded nothing",
		).toBe(1);
		expect(
			getAsFile,
			"cause: items were read even though files already had the image. fix: return early after the files branch",
		).not.toHaveBeenCalled();
	});

	it("survives a clipboard with items that have no getAsFile", () => {
		const items = [{ kind: "file", type: "image/png" }];
		expect(
			() => imageFilesFromClipboard(asClipboard({ items })),
			"cause: an item without getAsFile threw instead of being skipped. fix: check typeof item.getAsFile === \"function\"",
		).not.toThrow();
	});

	it("returns nothing for a missing clipboard", () => {
		expect(
			imageFilesFromClipboard(null),
			"cause: a null clipboardData threw or produced files. fix: return [] when clip is falsy",
		).toEqual([]);
	});
});
