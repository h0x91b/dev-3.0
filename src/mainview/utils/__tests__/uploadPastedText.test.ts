import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	LARGE_TEXT_PASTE_THRESHOLD,
	isLargeTextPaste,
	textByteLength,
	uploadPastedText,
} from "../uploadPastedText";
import { api } from "../../rpc";

vi.mock("../../rpc", () => ({
	api: { request: { uploadFileBase64: vi.fn() } },
}));

const mockedApi = api as unknown as {
	request: { uploadFileBase64: ReturnType<typeof vi.fn> };
};

describe("textByteLength", () => {
	it("counts ASCII bytes", () => {
		expect(textByteLength("abc")).toBe(3);
	});

	it("counts multibyte UTF-8 characters by byte length", () => {
		// "é" is 2 bytes, "💡" is 4 bytes in UTF-8.
		expect(textByteLength("é")).toBe(2);
		expect(textByteLength("💡")).toBe(4);
	});
});

describe("isLargeTextPaste", () => {
	it("returns false at or below the threshold", () => {
		expect(isLargeTextPaste("a".repeat(LARGE_TEXT_PASTE_THRESHOLD))).toBe(false);
	});

	it("returns true above the threshold", () => {
		expect(isLargeTextPaste("a".repeat(LARGE_TEXT_PASTE_THRESHOLD + 1))).toBe(true);
	});

	it("uses byte length, not character count, for multibyte text", () => {
		// 300 four-byte chars = 1200 bytes > 1024, even though JS length is only 600.
		const text = "💡".repeat(300);
		expect(text.length).toBeLessThan(LARGE_TEXT_PASTE_THRESHOLD);
		expect(textByteLength(text)).toBeGreaterThan(LARGE_TEXT_PASTE_THRESHOLD);
		expect(isLargeTextPaste(text)).toBe(true);
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
