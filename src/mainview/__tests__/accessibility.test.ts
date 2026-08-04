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
 * Accessibility guards — static source scan over the component tree.
 *
 * 1. Every `aria-modal` dialog must have an accessible name: either
 *    `aria-label` or `aria-labelledby`.  A dialog with neither is opaque to
 *    screen-reader users who navigate by landmark or by dialog role.
 *
 * 2. No `<label>` element may be left unassociated.  An associated label either
 *    carries `htmlFor` (string-id association) or wraps its control so the DOM
 *    parent–child relationship supplies the accessible name.  A bare `<label>`
 *    with neither is never announced for its target field.
 *
 * Both checks are intentionally conservative: they only flag clear violations
 * that a static regex can catch reliably, not every possible a11y issue.
 */
describe("accessibility structural guards", () => {
	const files = walk(SRC);

	it("scans a meaningful number of source files", () => {
		expect(files.length).toBeGreaterThan(100);
	});

	/**
	 * The app shell owns exactly one `<main>` and the per-route `sr-only` `<h1>`.
	 * Screens predating that shell had their own, which nested a second landmark
	 * and a second `h1` inside the first — invalid, and it makes landmark
	 * navigation ambiguous. Only `App.tsx` may open the element.
	 */
	it("declares the main landmark in exactly one place", () => {
		const declarers = files
			.filter((file) => /<main[\s>]/.test(readFileSync(file, "utf8")))
			.map((file) => path.relative(SRC, file));
		expect(declarers).toEqual(["App.tsx"]);
	});

	/**
	 * Every `aria-modal` element must carry an accessible name.
	 *
	 * Pattern matches the dialog container opening tag (all on its own lines,
	 * as formatted by Prettier).  We look for the `aria-modal` attribute and
	 * then verify the same JSX block (next 10 lines) also has `aria-label` or
	 * `aria-labelledby`.
	 */
	it("every aria-modal element has an accessible name (aria-label or aria-labelledby)", () => {
		const offenders: string[] = [];

		for (const file of files) {
			const src = readFileSync(file, "utf8");
			const lines = src.split("\n");

			for (let i = 0; i < lines.length; i++) {
				if (!lines[i].includes('aria-modal')) continue;

				// Look in a window of ±10 lines for the opening tag that carries aria-modal.
				// The dialog's accessible name attributes are always on the same element.
				const windowStart = Math.max(0, i - 5);
				const windowEnd = Math.min(lines.length, i + 10);
				const window = lines.slice(windowStart, windowEnd).join("\n");

				// Only check elements that actually have role="dialog" or aria-modal="true"
				if (!window.includes('aria-modal="true"') && !window.includes("aria-modal={true}")) continue;

				const hasLabel = window.includes("aria-label") || window.includes("aria-labelledby");
				if (!hasLabel) {
					offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
				}
			}
		}

		expect(offenders, `aria-modal dialogs without accessible names:\n${offenders.join("\n")}`).toEqual([]);
	});

	/**
	 * No bare `<label>` without `htmlFor` that is NOT wrapping its input.
	 *
	 * A label is "associated" when it either:
	 *   a) carries `htmlFor="…"` — explicit id association, OR
	 *   b) contains an `<input`, `<select`, or `<textarea` on the very next
	 *      non-whitespace lines (wrapping label pattern).
	 *
	 * We flag labels that have neither: they appear as `<label className=…>` with
	 * only text content and no `htmlFor`, and no control inside them.
	 */
	it("no <label> elements are left unassociated with a form control", () => {
		const offenders: string[] = [];

		for (const file of files) {
			// Skip test files themselves
			if (file.includes("__tests__")) continue;

			const src = readFileSync(file, "utf8");
			const lines = src.split("\n");

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				// Match opening label tags: <label or <label\n (JSX multiline)
				if (!/^\s*<label[\s>]/.test(line)) continue;

				// Check if this label has htmlFor on this line or the next few
				const labelBlock = lines.slice(i, Math.min(lines.length, i + 5)).join("\n");
				if (labelBlock.includes("htmlFor")) continue;

				// Check if this label wraps a control (next ~15 lines contain an input/select/textarea
				// or a custom interactive element with a role= attribute like role="switch")
				const bodyLines = lines.slice(i + 1, Math.min(lines.length, i + 16)).join("\n");
				const wrapsControl = /<input[\s/>]|<select[\s/>]|<textarea[\s/>]|role=["']?(switch|checkbox|radio|combobox|listbox|spinbutton|slider)/.test(bodyLines);
				if (wrapsControl) continue;

				offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
			}
		}

		expect(offenders, `Unassociated <label> elements:\n${offenders.join("\n")}`).toEqual([]);
	});
});
