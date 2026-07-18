import { describe, it, expect } from "vitest";
import { CloneProgressParser } from "../clone-progress";

describe("CloneProgressParser", () => {
	it("commits lines on \\n", () => {
		const p = new CloneProgressParser();
		p.feed("Cloning into 'repo'...\nremote: Enumerating objects: 10, done.\n");
		expect(p.lines(4)).toEqual([
			"Cloning into 'repo'...",
			"remote: Enumerating objects: 10, done.",
		]);
	});

	it("includes the in-progress line before any terminator arrives", () => {
		const p = new CloneProgressParser();
		p.feed("Cloning into 'repo'...\nReceiving objects:  10%");
		expect(p.lines(4)).toEqual([
			"Cloning into 'repo'...",
			"Receiving objects:  10%",
		]);
	});

	it("\\r rewrites the live line like a terminal", () => {
		const p = new CloneProgressParser();
		p.feed("Receiving objects:  10% (1/10)\rReceiving objects:  50% (5/10)\rReceiving objects: 100% (10/10), done.\n");
		expect(p.lines(4)).toEqual(["Receiving objects: 100% (10/10), done."]);
	});

	it("handles a \\r rewrite split across chunks", () => {
		const p = new CloneProgressParser();
		p.feed("Receiving objects:  10%\r");
		p.feed("Receiving objects:  9");
		p.feed("0%");
		expect(p.lines(4)).toEqual(["Receiving objects:  90%"]);
	});

	it("returns only the last N non-empty lines", () => {
		const p = new CloneProgressParser();
		p.feed("one\ntwo\n\nthree\nfour\nfive\n");
		expect(p.lines(4)).toEqual(["two", "three", "four", "five"]);
	});

	it("caps committed lines to bound memory", () => {
		const p = new CloneProgressParser();
		for (let i = 0; i < 200; i++) p.feed(`line ${i}\n`);
		expect(p.lines(2)).toEqual(["line 198", "line 199"]);
	});
});
