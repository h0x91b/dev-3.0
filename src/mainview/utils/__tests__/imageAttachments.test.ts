import { describe, it, expect } from "vitest";
import { extractImagePaths, extractFilePaths, removeImagePath } from "../imageAttachments";

const UPLOADS = "/Users/me/.dev3.0/worktrees/me-proj/uploads";

describe("extractFilePaths", () => {
	it("extracts an uploaded .txt attachment path", () => {
		const text = `${UPLOADS}/upload-1781612040314-24b3-pasted-text.txt\n`;
		expect(extractFilePaths(text)).toEqual([`${UPLOADS}/upload-1781612040314-24b3-pasted-text.txt`]);
	});

	it("extracts uploaded non-image files with a name (e.g. notes.log)", () => {
		const text = `${UPLOADS}/upload-1-abcd-server.log\n`;
		expect(extractFilePaths(text)).toEqual([`${UPLOADS}/upload-1-abcd-server.log`]);
	});

	it("ignores uploaded image files (those are thumbnails)", () => {
		const text = `${UPLOADS}/upload-1-abcd-shot.png\n`;
		expect(extractFilePaths(text)).toEqual([]);
		expect(extractImagePaths(text)).toEqual([`${UPLOADS}/upload-1-abcd-shot.png`]);
	});

	it("does not match plain file paths mentioned in prose", () => {
		const text = "Please edit /Users/me/src/components/Foo.tsx and /etc/hosts.conf";
		expect(extractFilePaths(text)).toEqual([]);
	});

	it("deduplicates repeated attachment paths", () => {
		const p = `${UPLOADS}/upload-2-beef-data.csv`;
		expect(extractFilePaths(`${p}\n${p}\n`)).toEqual([p]);
	});

	it("returns empty for empty text", () => {
		expect(extractFilePaths("")).toEqual([]);
	});
});

describe("removeImagePath removes file attachments too", () => {
	it("removes an attachment path line, leaving the rest intact", () => {
		const p = `${UPLOADS}/upload-3-cafe-pasted-text.txt`;
		const text = `Look at this:\n${p}\nthanks`;
		expect(removeImagePath(text, p)).toBe("Look at this:\nthanks");
	});
});
