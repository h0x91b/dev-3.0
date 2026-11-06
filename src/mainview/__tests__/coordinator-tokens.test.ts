import { readFileSync } from "node:fs";
import { join } from "node:path";

// Same lookup as wire-tokens.test.ts: the worker may start at src/mainview or the repo root.
const css = (() => {
	for (const path of [join(process.cwd(), "index.css"), join(process.cwd(), "src/mainview/index.css")]) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			continue;
		}
	}
	throw new Error("index.css not found from " + process.cwd());
})();

const lightBlock = css.slice(css.indexOf('[data-theme="light"]'));

describe("coordinator identity tokens", () => {
	it.each(["--coordinator", "--coordinator-ink", "--coordinator-on"])("declares %s once per theme as a raw RGB triplet", (token) => {
		const declaration = new RegExp(`${token}:\\s*\\d+ \\d+ \\d+;`, "g");
		expect(css.match(declaration)?.length).toBe(2);
		expect(lightBlock.match(declaration)?.length).toBe(1);
	});

	it("carries no hazard-tape stripes or coordinator border rules", () => {
		expect(css).not.toContain("repeating-linear-gradient");
		expect(css).not.toMatch(/\.task-(card|row)-coordinator/);
	});
});
