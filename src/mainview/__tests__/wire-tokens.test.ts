import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WIRE_COLORS } from "../components/agent-traffic/nodes-layout";

/**
 * A traffic wire paints itself with `var(--wire-N)`, so a missing token is not a
 * type error and not a test failure anywhere else — the wire just falls back to
 * the shared violet and the whole point of per-connection colour is gone. These
 * assertions are the only thing standing between that and a silent regression.
 */
// The renderer config's root is src/mainview, but a worker may start at the repo
// root, so both are tried rather than assuming one.
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

/** Token declarations inside the light-theme block, which starts at its selector. */
const lightBlock = css.slice(css.indexOf('[data-theme="light"]'));

describe("traffic wire colour tokens", () => {
	it("declares every wire token twice: once per theme", () => {
		expect(lightBlock.length).toBeGreaterThan(0);
		for (let index = 1; index <= WIRE_COLORS; index += 1) {
			const declaration = new RegExp(`--wire-${index}:\\s*\\d+ \\d+ \\d+;`, "g");
			expect(css.match(declaration)?.length, `--wire-${index} in both themes`).toBe(2);
			expect(lightBlock.match(declaration)?.length, `--wire-${index} in the light theme`).toBe(1);
		}
	});

	it("holds raw RGB triplets, since the wire wraps them in rgb() with an alpha", () => {
		for (const [, value] of css.matchAll(/--wire-\d+:\s*([^;]+);/g)) {
			expect(value.trim()).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
			for (const channel of value.trim().split(" ")) expect(Number(channel)).toBeLessThanOrEqual(255);
		}
	});

	it("defines no token beyond the count the code indexes into", () => {
		const declared = new Set([...css.matchAll(/--wire-(\d+):/g)].map(([, index]) => Number(index)));
		expect([...declared].sort((a, b) => a - b)).toEqual(
			Array.from({ length: WIRE_COLORS }, (_, index) => index + 1),
		);
	});
});
