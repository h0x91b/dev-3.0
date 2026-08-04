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
 * All font sizes must use the closed named scale defined in tailwind.config.js
 * (nano, dense, micro, xs, sm-plus, sm, base-sm, base, base-lg, lg, xl-sm, xl,
 * 2xl, 3xl, …) rather than arbitrary text-[…] values.
 *
 * Rationale:
 *  - Arbitrary sizes carry no line-height and silently inherit the ancestor's leading.
 *  - The two px-pinned rungs (nano=9px, dense=10px) are immune to MOBILE_DENSE_FACTOR
 *    root-font scaling; arbitrary rem sizes are not.
 *  - A closed scale makes visual audits possible at a glance.
 *
 * Exception — ExtraKeyBar.tsx:
 *  The virtual keyboard buttons use vw-relative font sizes (4vw, 3.5vw, 4.5vw) so
 *  their labels scale with the physical keyboard width on every phone screen size.
 *  This is not representable by a fixed rem or px rung — it is intentional and
 *  reviewed. Any new vw-relative text there must be documented in ExtraKeyBar.tsx.
 *
 * The banned prefix is assembled at runtime on purpose. Tailwind's content glob
 * covers `src/mainview/**` including this directory, so spelling it out as a
 * string literal would keep generating the very rule the test forbids.
 */

// "text" + "-[" assembled at runtime so Tailwind's static scanner cannot pick it up.
const ARBIT_PREFIX = ["text", "["].join("-");

describe("closed type scale", () => {
	const files = walk(SRC);

	it("scans a meaningful number of source files", () => {
		expect(files.length).toBeGreaterThan(100);
	});

	it("uses no arbitrary text-[…] sizes (rem, px, vw, or other) outside the named scale", () => {
		const EXEMPTED = ["ExtraKeyBar.tsx"]; // vw-relative keyboard buttons — see comment above

		const offenders = files
			.filter((file) => !EXEMPTED.some((ex) => file.endsWith(ex)))
			.filter((file) => readFileSync(file, "utf8").includes(ARBIT_PREFIX))
			.map((file) => path.relative(SRC, file));

		expect(offenders).toEqual([]);
	});
});
