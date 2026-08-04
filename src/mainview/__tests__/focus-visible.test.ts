import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "node_modules" || entry === "__tests__") continue;
			walk(full, out);
		} else if (/\.tsx?$/.test(entry)) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Tailwind compiles the focus variant of `outline-none` to a class plus a
 * pseudo-class, specificity (0,2,0). The app's single focus affordance is the bare
 * `:focus-visible` rule in index.css at (0,1,0), so the variant silently wins and
 * paints a TRANSPARENT outline over the keyboard ring. It shipped on 27 controls.
 *
 * The bare `outline-none` utility is fine: same specificity as the global rule, and
 * the global rule is authored after `@tailwind utilities`, so source order settles it.
 *
 * The banned class is assembled at runtime on purpose. Tailwind's content glob covers
 * `src/mainview/**` including this directory, so spelling it out here would keep
 * generating the very rule the test forbids.
 */
const BANNED = ["focus", "outline-none"].join(":");

describe("keyboard focus ring", () => {
	const files = walk(SRC);

	it("scans a meaningful number of source files", () => {
		expect(files.length).toBeGreaterThan(100);
	});

	it("never uses the focus variant of outline-none, which out-specifies the global ring", () => {
		const offenders = files
			.filter((file) => readFileSync(file, "utf8").includes(BANNED))
			.map((file) => path.relative(SRC, file));
		expect(offenders).toEqual([]);
	});

	it("keeps the global :focus-visible ring in index.css", () => {
		const css = readFileSync(path.join(SRC, "index.css"), "utf8");
		expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid rgb\(var\(--accent\)\)/);
	});
});
