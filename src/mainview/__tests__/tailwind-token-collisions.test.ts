/**
 * Guards the design-token namespace against Tailwind utility-name collisions.
 *
 * A colour token whose name matches a `fontSize` rung makes Tailwind emit TWO
 * rules for the same class — `.text-<name>` as a font size AND as a colour. The
 * colour rule wins for `color`, so every element that only meant "set the font
 * size" silently gets repainted. `base` did exactly that: 107 icon glyphs on the
 * Dashboard alone were drawn in `--surface-base` on `--surface-raised`
 * (contrast 1.06:1, invisible). See `decisions/` and the `base-ink` token.
 */
import { describe, expect, it } from "vitest";
import config from "../../../tailwind.config.js";

const extend = config.theme.extend;

function leafKeys(palette: Record<string, unknown>, prefix = ""): string[] {
	return Object.entries(palette).flatMap(([key, value]) => {
		const name = key === "DEFAULT" ? prefix.replace(/-$/, "") : `${prefix}${key}`;
		return typeof value === "object" && value !== null
			? leafKeys(value as Record<string, unknown>, `${name}-`)
			: [name];
	});
}

describe("tailwind token namespace", () => {
	it("has no colour token that shadows a font-size rung", () => {
		const fontSizes = new Set(Object.keys(extend.fontSize));
		// Tailwind's own defaults are in play too — they are what `base` collided with.
		for (const builtin of ["xs", "sm", "base", "lg", "xl", "2xl", "3xl"]) fontSizes.add(builtin);

		const collisions = leafKeys(extend.colors as Record<string, unknown>).filter((name) => fontSizes.has(name));

		expect(collisions).toEqual([]);
	});

	it("keeps the base surface out of the colour palette and available where it is used", () => {
		expect(Object.keys(extend.colors)).not.toContain("base");
		expect(extend.backgroundColor).toHaveProperty("base");
		expect(extend.ringColor).toHaveProperty("base");
		// Text on a solid fill uses the explicitly named token instead.
		expect(extend.colors).toHaveProperty("base-ink");
	});
});
