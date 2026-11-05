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

/** The body of the first rule whose selector list contains `selector`. */
function ruleBody(selector: string): string {
	const start = css.indexOf(selector);
	expect(start, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
	return css.slice(css.indexOf("{", start), css.indexOf("}", start));
}

describe("coordinator identity tokens", () => {
	it.each(["--coordinator", "--coordinator-ink"])("declares %s once per theme as a raw RGB triplet", (token) => {
		const declaration = new RegExp(`${token}:\\s*\\d+ \\d+ \\d+;`, "g");
		expect(css.match(declaration)?.length).toBe(2);
		expect(lightBlock.match(declaration)?.length).toBe(1);
	});

	it("paints the hazard-tape band on cards and sidebar rows from the token", () => {
		const band = ruleBody(".task-row-coordinator::before {\n\tcontent");
		expect(css).toContain(".task-card-coordinator::before,\n.task-row-coordinator::before {");
		expect(band).toContain("rgb(var(--coordinator))");
		// Under the text, never over it.
		expect(band).toContain("z-index: -1");
		expect(band).toContain("pointer-events: none");
	});

	it("draws the card border from the same token", () => {
		expect(ruleBody(".task-card-coordinator:hover {")).toContain("rgb(var(--coordinator)");
	});
});
