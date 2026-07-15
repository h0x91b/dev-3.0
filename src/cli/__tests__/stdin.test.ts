import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { readStdin } from "../stdin";

describe("readStdin", () => {
	it("joins stream chunks and preserves UTF-8 Markdown", async () => {
		const input = Readable.from([Buffer.from("# Plan\n\n"), Buffer.from('Quote: "keep me"\n')]);

		expect(await readStdin(input)).toBe('# Plan\n\nQuote: "keep me"\n');
	});

	it("returns an empty string for empty input", async () => {
		expect(await readStdin(Readable.from([]))).toBe("");
	});
});
