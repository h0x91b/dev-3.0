import { describe, it, expect } from "vitest";
import { extractImagePaths, extractFilePaths, removeImagePath } from "../imageAttachments";

const UPLOADS = "/Users/me/.dev3.0/worktrees/me-proj/uploads";

describe("extractImagePaths", () => {
	it("extracts a bare path", () => {
		expect(extractImagePaths("/Users/a/shot.png")).toEqual(["/Users/a/shot.png"]);
	});

	it("keeps spaces inside an inline path", () => {
		expect(extractImagePaths("see /Users/a/Screenshot 2026-03-04.png here")).toEqual([
			"/Users/a/Screenshot 2026-03-04.png",
		]);
	});

	it("joins two image paths on one line into a single match", () => {
		expect(extractImagePaths("a /x/1.png b /y/2.png c")).toEqual(["/x/1.png b /y/2.png"]);
	});

	it("matches paths on separate lines separately", () => {
		expect(extractImagePaths("/x/1.png\n/y/2.jpg")).toEqual(["/x/1.png", "/y/2.jpg"]);
	});

	it("stops at quotes", () => {
		expect(extractImagePaths('"/x/a.png"')).toEqual(["/x/a.png"]);
	});

	it("requires a name before the extension", () => {
		expect(extractImagePaths("/.png")).toEqual([]);
	});

	it("matches the extension case-insensitively", () => {
		expect(extractImagePaths("/x/a.JPEG")).toEqual(["/x/a.JPEG"]);
	});

	it("returns nothing for empty text", () => {
		expect(extractImagePaths("")).toEqual([]);
	});

	describe("long lines with many slashes", () => {
		const words = "Check the build result and describe the problems found in a note for the next agent";
		const longLine = Array.from({ length: 30 }, (_, i) => `${words.slice(i % 20, 20 + (i % 20))}/`)
			.join(" ")
			.repeat(2)
			.slice(0, 850);

		it("finishes quickly when there is no image extension", () => {
			expect(longLine.length).toBeGreaterThan(800);
			expect(longLine.split("/").length).toBeGreaterThan(28);
			const start = performance.now();
			expect(extractImagePaths(longLine)).toEqual([]);
			expect(performance.now() - start).toBeLessThan(200);
		});

		it("matches from the first slash of the line when an image path follows", () => {
			const text = `${longLine} /tmp/x.png`;
			const start = performance.now();
			const result = extractImagePaths(text);
			expect(performance.now() - start).toBeLessThan(200);
			expect(result).toEqual([text.slice(text.indexOf("/"))]);
		});
	});

	it("returns the same matches as the previous nested-group pattern", () => {
		const oldRe = /(\/(?:[^\n"'<>]*\/)*[^\n"'<>]+\.(png|jpe?g|gif|webp|bmp|svg))/gi;
		const alphabet = ["/", "a", ".", "png", "jpg", " ", "\n", '"', "x", "PNG", ".jpeg"];
		let seed = 12345;
		const rand = (n: number) => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed % n;
		};
		for (let i = 0; i < 4000; i++) {
			const len = rand(11);
			let text = "";
			for (let j = 0; j < len; j++) text += alphabet[rand(alphabet.length)];
			const expected: string[] = [];
			oldRe.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = oldRe.exec(text)) !== null) expected.push(m[1]);
			expect(extractImagePaths(text), JSON.stringify(text)).toEqual([...new Set(expected)]);
		}
	});
});

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
