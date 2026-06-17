import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	LARGE_TEXT_PASTE_THRESHOLD,
	isLargeTextPaste,
	textCharLength,
	uploadPastedText,
} from "../uploadPastedText";
import { api } from "../../rpc";

vi.mock("../../rpc", () => ({
	api: { request: { uploadFileBase64: vi.fn() } },
}));

const mockedApi = api as unknown as {
	request: { uploadFileBase64: ReturnType<typeof vi.fn> };
};

describe("textCharLength", () => {
	it("counts ASCII characters", () => {
		expect(textCharLength("abc")).toBe(3);
	});

	it("counts each multibyte character as one, regardless of UTF-8 byte size", () => {
		// "é" is 2 bytes but 1 character; "💡" is 4 bytes / 2 UTF-16 units but 1 code point.
		expect(textCharLength("é")).toBe(1);
		expect(textCharLength("💡")).toBe(1);
	});
});

describe("isLargeTextPaste", () => {
	it("returns false at or below the threshold", () => {
		expect(isLargeTextPaste("a".repeat(LARGE_TEXT_PASTE_THRESHOLD))).toBe(false);
	});

	it("returns true above the threshold", () => {
		expect(isLargeTextPaste("a".repeat(LARGE_TEXT_PASTE_THRESHOLD + 1))).toBe(true);
	});

	it("counts characters language-independently — Cyrillic is not penalized for byte size", () => {
		// A Cyrillic paragraph well under the character threshold must NOT be saved
		// to a file, even though its UTF-8 byte size is ~2x its character count.
		const text = "Короткий абзац на русском языке для проверки порога вставки. ".repeat(100);
		expect(textCharLength(text)).toBeLessThan(LARGE_TEXT_PASTE_THRESHOLD);
		expect(isLargeTextPaste(text)).toBe(false);
	});

	it("counts code points, not UTF-16 code units, for astral characters", () => {
		// Each "💡" is 2 UTF-16 units but 1 code point. 5000 of them = 5000 chars
		// (below the threshold), even though string.length reports 10000.
		const text = "💡".repeat(5000);
		expect(text.length).toBeGreaterThan(LARGE_TEXT_PASTE_THRESHOLD);
		expect(textCharLength(text)).toBeLessThan(LARGE_TEXT_PASTE_THRESHOLD);
		expect(isLargeTextPaste(text)).toBe(false);
	});
});

describe("uploadPastedText", () => {
	beforeEach(() => {
		mockedApi.request.uploadFileBase64.mockReset();
	});

	it("uploads the text as a pasted-text.txt file and returns its path", async () => {
		mockedApi.request.uploadFileBase64.mockResolvedValue({ path: "/tmp/uploads/upload-1-abcd-pasted-text.txt" });

		const path = await uploadPastedText("p1", "hello world");

		expect(path).toBe("/tmp/uploads/upload-1-abcd-pasted-text.txt");
		expect(mockedApi.request.uploadFileBase64).toHaveBeenCalledWith({
			projectId: "p1",
			base64: btoa("hello world"),
			filename: "pasted-text.txt",
			mimeType: "text/plain",
		});
	});
});
