import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { readStdin } from "../stdin";

describe("readStdin", () => {
	it("joins stream chunks and preserves UTF-8 Markdown", async () => {
		const input = Readable.from([Buffer.from("# Plan\n\n"), Buffer.from('Quote: "keep me"\n')]);

		expect(await readStdin(input)).toBe('# Plan\n\nQuote: "keep me"\n');
	});

	it("keeps a multibyte character intact when a chunk boundary splits its bytes", async () => {
		const bytes = Buffer.from("Проверка 🙂", "utf-8");
		const input = Readable.from([bytes.subarray(0, 1), bytes.subarray(1, 19), bytes.subarray(19)]);

		expect(await readStdin(input)).toBe("Проверка 🙂");
	});

	it("returns an empty string for empty input", async () => {
		expect(await readStdin(Readable.from([]))).toBe("");
	});
});
