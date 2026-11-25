import { describe, it, expect } from "vitest";
import { CloneProgressParser } from "../clone-progress";

describe("CloneProgressParser", () => {
	it("commits lines on \\n and includes the in-progress line before any terminator", () => {
		const p = new CloneProgressParser();
		p.feed("Cloning into 'repo'...\nremote: Enumerating objects: 10, done.\nReceiving objects:  10%");
		expect(p.lines(4)).toEqual([
			"Cloning into 'repo'...",
			"remote: Enumerating objects: 10, done.",
			"Receiving objects:  10%",
		]);
	});

	it("\\r rewrites the live line like a terminal, even split across chunks", () => {
		const p = new CloneProgressParser();
		p.feed("Receiving objects:  10% (1/10)\rReceiving objects:  50% (5/10)\rReceiving objects: 100% (10/10), done.\n");
		expect(p.lines(4)).toEqual(["Receiving objects: 100% (10/10), done."]);

		const split = new CloneProgressParser();
		split.feed("Receiving objects:  10%\r");
		split.feed("Receiving objects:  9");
		split.feed("0%");
		expect(split.lines(4)).toEqual(["Receiving objects:  90%"]);
	});

	it("returns only the last N non-empty lines, and caps committed lines to bound memory", () => {
		const p = new CloneProgressParser();
		p.feed("one\ntwo\n\nthree\nfour\nfive\n");
		expect(p.lines(4)).toEqual(["two", "three", "four", "five"]);

		const capped = new CloneProgressParser();
		for (let i = 0; i < 200; i++) capped.feed(`line ${i}\n`);
		expect(capped.lines(2)).toEqual(["line 198", "line 199"]);
	});
});
