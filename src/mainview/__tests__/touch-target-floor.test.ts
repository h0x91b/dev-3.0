import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Two cascade invariants behind the mobile touch floor. Both were shipped
 * broken once, both are invisible in a component test because happy-dom does
 * not run the real stylesheet — so they are asserted against the source.
 *
 * See decisions/2026/08/06/touch-target-floor-is-24px-and-never-overrides.md
 * and decisions/2026/08/08/phone-density-is-per-screen-not-global.md.
 */
const CSS = readFileSync(path.resolve(__dirname, "..", "index.css"), "utf8");

/** The rule body that follows a selector, up to its closing brace. */
function bodyAfter(selectorFragment: string): string {
	const at = CSS.indexOf(selectorFragment);
	expect(at, `selector not found: ${selectorFragment}`).toBeGreaterThan(-1);
	return CSS.slice(at, CSS.indexOf("}", at));
}

describe("touch target floor", () => {
	it("keeps the global coarse-pointer floor at 24px and at specificity 0", () => {
		const body = bodyAfter(':where(button, a[role="button"], [role="menuitem"]');
		expect(body).toContain("min-height: 24px");
		expect(body).toContain("min-width: 24px");
		// `:is()` would inherit [role="menuitem"]'s weight and beat an author's
		// deliberate size; a floor must always lose to one.
		expect(CSS).not.toContain(':is(button, a[role="button"], [role="menuitem"], [role="option"]');
	});

	it("lets inline chips opt out of the 44px sheet floor", () => {
		// Without the :not(), this rule (0-2-0) outweighs `.touch-inline` (0-1-0)
		// and blows a label pill up into a 44px square inside a sheet.
		expect(CSS).toContain('.touch-actions :is(button, a[role="button"], [role="menuitem"]):not(.touch-inline)');
	});

	it("centres whatever the sheet floor inflates, without outranking a utility", () => {
		const at = CSS.indexOf(".touch-actions :where(");
		expect(at).toBeGreaterThan(-1);
		const body = CSS.slice(at, CSS.indexOf("}", at));
		expect(body).toContain("display: inline-flex"); // Tailwind makes every svg a block
		expect(body).toContain("justify-content: center");
		expect(body).toContain("align-items: center");
		// In the components layer, so `flex` / `justify-between` / `text-left`
		// on the element itself still win — utilities are emitted after it.
		expect(CSS.slice(0, at)).toMatch(/@layer components \{\s*$/m);
	});
});
