import { describe, expect, it } from "vitest";
import { unplayableMediaReferences } from "../artifact-media-references";

describe("unplayableMediaReferences", () => {
	it("accepts bundled players and links, with query strings, encoding and ./ prefixes", () => {
		const html = [
			'<audio controls><source src="./audio/My%20Take.mp3?v=2" type="audio/mpeg"></audio>',
			"<video src=clips/tour.webm></video>",
			'<a href="audio/My Take.mp3" download>get</a>',
		].join("");
		expect(unplayableMediaReferences(html, new Set(["audio/My Take.mp3", "clips/tour.webm"]))).toEqual([]);
	});

	it("reports each broken reference once, with its own remedy", () => {
		const html = [
			'<audio src="audio/a.mp3"></audio><a href="audio/a.mp3" download>a</a>',
			"<video src='clips/raw.mov'></video>",
			'<source src="../shared/b.wav">',
		].join("");
		const problems = unplayableMediaReferences(html, new Set());
		expect(problems).toHaveLength(3);
		expect(problems[0]).toMatch(/^audio\/a\.mp3: not bundled/);
		expect(problems[1]).toMatch(/^clips\/raw\.mov: \.mov is not a supported .* "clips\/raw\.mp4"/);
		expect(problems[2]).toMatch(/^\.\.\/shared\/b\.wav: points outside the report directory/);
	});

	it("ignores non-media links, image sources and attributes on other tags", () => {
		const html = [
			'<a href="report.pdf">pdf</a><a href="#top">top</a>',
			'<picture><source srcset="shot.webp"></picture>',
			'<img src="clip.mp4"><div data-src="x.mp3"></div>',
			'<a data-href="x.mp3" href="notes.html">n</a>',
		].join("");
		expect(unplayableMediaReferences(html, new Set())).toEqual([]);
	});
});
