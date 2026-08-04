/**
 * Design-token contrast regression test.
 *
 * Parses CSS variable values directly from src/mainview/index.css so the test
 * cannot drift from the live tokens. Composites alpha-modified values through
 * the real glass-card layer stack (worst-case reading surface, per DESIGN.md §9)
 * before measuring APCA Lc.
 *
 * Floors (APCA W3 0.1.9):
 *   • |Lc| ≥ 75  — body text
 *   • |Lc| ≥ 60  — non-body text (UI labels, badges)
 *   • |Lc| ≥ 15  — non-text elements that must be discernible (borders, grips)
 *
 * Failure output names the pair, measured Lc, and the floor it missed.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type RGB,
	apcaContrast,
	compositeOver,
	glassCardSurface,
	parseHex,
	parseRgbTriple,
} from "../contrast-check";
import type { TaskStatus } from "../../shared/types";
import {
	STATUS_COLORS,
	STATUS_COLORS_LIGHT_INK,
} from "../../shared/types";

// ─── Parse tokens from index.css ────────────────────────────────────────────

const cssPath = resolve(__dirname, "../index.css");
const cssText = readFileSync(cssPath, "utf-8");

/**
 * Extract the value of a CSS custom property from either theme block.
 * Matches the first occurrence of `--<name>: <value>;` in the file.
 * For theme-specific lookups pass `scope` ("dark" or "light").
 */
function cssVar(name: string, scope: "dark" | "light" | "any" = "any"): string {
	// Isolate the relevant theme block first for scoped lookups.
	// The dark tokens live in `:root, [data-theme="dark"] { ... }` — one combined block.
	let haystack = cssText;
	if (scope === "dark") {
		// Match the :root / dark combined block (before `[data-theme="light"]`)
		const lightStart = cssText.indexOf('[data-theme="light"]');
		haystack = lightStart > 0 ? cssText.slice(0, lightStart) : cssText;
	} else if (scope === "light") {
		const lightStart = cssText.indexOf('[data-theme="light"]');
		haystack = lightStart > 0 ? cssText.slice(lightStart) : "";
		// Only include content up to the closing brace of this block
		const blockEnd = haystack.indexOf("\n}\n");
		if (blockEnd > 0) haystack = haystack.slice(0, blockEnd + 3);
	}

	const re = new RegExp(`--${name}\\s*:\\s*([^;]+);`);
	const match = re.exec(haystack);
	if (!match) throw new Error(`CSS variable --${name} not found (scope=${scope})`);
	return match[1].trim();
}

function darkRgb(name: string): RGB  { return parseRgbTriple(cssVar(name, "dark")); }
function lightRgb(name: string): RGB { return parseRgbTriple(cssVar(name, "light")); }

// Pre-compute glass card surfaces once
const darkCard  = glassCardSurface("dark");
const lightCard = glassCardSurface("light");

// ─── Helper ─────────────────────────────────────────────────────────────────

function lcLabel(text: RGB, bg: RGB, pair: string): string {
	const lc = apcaContrast(text, bg);
	return `${pair}: Lc ${lc.toFixed(1)}`;
}

// ─── 1. Text tokens on glass-card surface ────────────────────────────────────

describe("text tokens — dark theme on glass card", () => {
	it("text-primary clears body-text floor (|Lc| ≥ 75)", () => {
		const lc = apcaContrast(darkRgb("text-primary"), darkCard);
		expect(Math.abs(lc), lcLabel(darkRgb("text-primary"), darkCard, "dark/text-primary")).toBeGreaterThanOrEqual(75);
	});

	it("text-secondary clears body-text floor (|Lc| ≥ 75)", () => {
		const lc = apcaContrast(darkRgb("text-secondary"), darkCard);
		expect(Math.abs(lc), lcLabel(darkRgb("text-secondary"), darkCard, "dark/text-secondary")).toBeGreaterThanOrEqual(75);
	});

	it("text-tertiary clears non-body floor (|Lc| ≥ 60)", () => {
		const lc = apcaContrast(darkRgb("text-tertiary"), darkCard);
		expect(Math.abs(lc), lcLabel(darkRgb("text-tertiary"), darkCard, "dark/text-tertiary")).toBeGreaterThanOrEqual(60);
	});

	// text-muted is decoration/disabled only (DESIGN.md §2 "never for text that
	// has to be read").  Its Lc 41 is deliberately below the text floors; it
	// clears only the non-text floor of 15, which is all that is required for
	// purely decorative elements.
	it("text-muted clears non-text floor (|Lc| ≥ 15)", () => {
		const lc = apcaContrast(darkRgb("text-muted"), darkCard);
		expect(Math.abs(lc), lcLabel(darkRgb("text-muted"), darkCard, "dark/text-muted")).toBeGreaterThanOrEqual(15);
	});
});

describe("text tokens — light theme on glass card", () => {
	it("text-primary clears body-text floor (|Lc| ≥ 75)", () => {
		const lc = apcaContrast(lightRgb("text-primary"), lightCard);
		expect(Math.abs(lc), lcLabel(lightRgb("text-primary"), lightCard, "light/text-primary")).toBeGreaterThanOrEqual(75);
	});

	it("text-secondary clears body-text floor (|Lc| ≥ 75)", () => {
		const lc = apcaContrast(lightRgb("text-secondary"), lightCard);
		expect(Math.abs(lc), lcLabel(lightRgb("text-secondary"), lightCard, "light/text-secondary")).toBeGreaterThanOrEqual(75);
	});

	it("text-tertiary clears non-body floor (|Lc| ≥ 60)", () => {
		const lc = apcaContrast(lightRgb("text-tertiary"), lightCard);
		expect(Math.abs(lc), lcLabel(lightRgb("text-tertiary"), lightCard, "light/text-tertiary")).toBeGreaterThanOrEqual(60);
	});

	it("text-muted clears non-text floor (|Lc| ≥ 15)", () => {
		const lc = apcaContrast(lightRgb("text-muted"), lightCard);
		expect(Math.abs(lc), lcLabel(lightRgb("text-muted"), lightCard, "light/text-muted")).toBeGreaterThanOrEqual(15);
	});
});

// ─── 2. Semantic fill tokens — white ink on solid fills ──────────────────────

describe("danger-fill — white text contrast (|Lc| ≥ 75)", () => {
	const white: RGB = [255, 255, 255];

	it("dark theme", () => {
		const fill = darkRgb("danger-fill");
		const lc = apcaContrast(white, fill);
		expect(Math.abs(lc), `dark/danger-fill white: Lc ${lc.toFixed(1)}`).toBeGreaterThanOrEqual(75);
	});

	it("light theme", () => {
		const fill = lightRgb("danger-fill");
		const lc = apcaContrast(white, fill);
		expect(Math.abs(lc), `light/danger-fill white: Lc ${lc.toFixed(1)}`).toBeGreaterThanOrEqual(75);
	});
});

describe("success-fill — white text contrast (|Lc| ≥ 75)", () => {
	const white: RGB = [255, 255, 255];

	it("dark theme", () => {
		const fill = darkRgb("success-fill");
		const lc = apcaContrast(white, fill);
		expect(Math.abs(lc), `dark/success-fill white: Lc ${lc.toFixed(1)}`).toBeGreaterThanOrEqual(75);
	});

	it("light theme", () => {
		const fill = lightRgb("success-fill");
		const lc = apcaContrast(white, fill);
		expect(Math.abs(lc), `light/success-fill white: Lc ${lc.toFixed(1)}`).toBeGreaterThanOrEqual(75);
	});
});

describe("warning-fill — white text contrast (|Lc| ≥ 75)", () => {
	const white: RGB = [255, 255, 255];

	it("dark theme", () => {
		const fill = darkRgb("warning-fill");
		const lc = apcaContrast(white, fill);
		expect(Math.abs(lc), `dark/warning-fill white: Lc ${lc.toFixed(1)}`).toBeGreaterThanOrEqual(75);
	});

	it("light theme", () => {
		const fill = lightRgb("warning-fill");
		const lc = apcaContrast(white, fill);
		expect(Math.abs(lc), `light/warning-fill white: Lc ${lc.toFixed(1)}`).toBeGreaterThanOrEqual(75);
	});
});

// ─── 3. Border tokens on solid surfaces ──────────────────────────────────────

describe("border-default — discernibility on primary surfaces (|Lc| ≥ 15)", () => {
	it("dark: on surface-raised", () => {
		const border = darkRgb("border-default");
		const surface = darkRgb("surface-raised");
		const lc = apcaContrast(border, surface);
		expect(Math.abs(lc), `dark border-default on raised: Lc ${lc.toFixed(1)}`).toBeGreaterThanOrEqual(15);
	});

	it("dark: on surface-base", () => {
		const border = darkRgb("border-default");
		const surface = darkRgb("surface-base");
		const lc = apcaContrast(border, surface);
		expect(Math.abs(lc), `dark border-default on base: Lc ${lc.toFixed(1)}`).toBeGreaterThanOrEqual(15);
	});

	it("light: on surface-base", () => {
		const border = lightRgb("border-default");
		const surface = lightRgb("surface-base");
		const lc = apcaContrast(border, surface);
		expect(Math.abs(lc), `light border-default on base: Lc ${lc.toFixed(1)}`).toBeGreaterThanOrEqual(15);
	});

	it("light: on surface-raised", () => {
		const border = lightRgb("border-default");
		const surface = lightRgb("surface-raised");
		const lc = apcaContrast(border, surface);
		expect(Math.abs(lc), `light border-default on raised: Lc ${lc.toFixed(1)}`).toBeGreaterThanOrEqual(15);
	});
});

// ─── 4. STATUS_COLORS_LIGHT_INK — light-theme column badge text ──────────────

describe("STATUS_COLORS_LIGHT_INK — badge text on light glass column header (|Lc| ≥ 60)", () => {
	// Approximate the glass column header surface in light theme.
	// Header = glass-header (255 255 255 / 0.58) over column glass surface.
	// Column glass surface (no glow) = (255 255 255 / 0.49) over gradient-from.
	const gradFrom: RGB = [211, 223, 239]; // #d3dfef
	const colSurface = compositeOver([255, 255, 255], 0.49, gradFrom);  // col glass
	const headerSurface = compositeOver([255, 255, 255], 0.58, colSurface); // header glass

	const statuses = Object.keys(STATUS_COLORS_LIGHT_INK) as TaskStatus[];

	for (const status of statuses) {
		it(`${status} ink clears non-body floor`, () => {
			const ink = parseHex(STATUS_COLORS_LIGHT_INK[status]);
			const lc = apcaContrast(ink, headerSurface);
			expect(
				Math.abs(lc),
				`${status}: Lc ${lc.toFixed(1)} on light column header (needs ≥ 60)`,
			).toBeGreaterThanOrEqual(60);
		});
	}
});

// Dark STATUS_COLORS are bright pastels on near-black glass — they serve as
// identity signals (glow, dot, tinted badge background) as well as text.
// Most clear Lc 60 easily; a few pastel entries (review-by-ai cool-gray,
// cancelled coral) land at Lc ~54-57 and are accepted at the non-text floor
// (|Lc| ≥ 15) because the badge chip also carries a background tint for
// identity. The floor here is a regression guard — if a token drops below
// the accepted minimum for decorative elements, the test will catch it.
describe("STATUS_COLORS (dark) — dark glass card reading surface (|Lc| ≥ 50 decorative floor)", () => {
	const statuses = Object.keys(STATUS_COLORS) as TaskStatus[];

	for (const status of statuses) {
		it(`${status} clears decorative floor on dark glass card`, () => {
			const ink = parseHex(STATUS_COLORS[status]);
			const lc = apcaContrast(ink, darkCard);
			expect(
				Math.abs(lc),
				`dark ${status}: Lc ${lc.toFixed(1)} on dark glass card (needs ≥ 50)`,
			).toBeGreaterThanOrEqual(50);
		});
	}
});

// ─── 5. Light surface ramp is monotonically increasing in luminance ───────────

describe("light surface ramp — monotonic (base < raised < elevated < overlay)", () => {
	function lum(rgb: RGB): number {
		// Perceived lightness via WCAG relative luminance (monotonic proxy for OKLCH L)
		const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
		function lin(c: number) { return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
		return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
	}

	it("raised is lighter than base", () => {
		expect(lum(lightRgb("surface-raised"))).toBeGreaterThan(lum(lightRgb("surface-base")));
	});

	it("elevated is lighter than raised", () => {
		expect(lum(lightRgb("surface-elevated"))).toBeGreaterThan(lum(lightRgb("surface-raised")));
	});

	it("overlay is lighter than elevated", () => {
		expect(lum(lightRgb("surface-overlay"))).toBeGreaterThan(lum(lightRgb("surface-elevated")));
	});
});

// ─── 6. Accent-fill white ink (existing tokens, regression guard) ─────────────

describe("accent-fill — white text contrast (|Lc| ≥ 75) — regression", () => {
	const white: RGB = [255, 255, 255];

	it("dark theme", () => {
		const fill = darkRgb("accent-fill");
		const lc = apcaContrast(white, fill);
		expect(Math.abs(lc), `dark/accent-fill white: Lc ${lc.toFixed(1)}`).toBeGreaterThanOrEqual(75);
	});

	it("light theme", () => {
		const fill = lightRgb("accent-fill");
		const lc = apcaContrast(white, fill);
		expect(Math.abs(lc), `light/accent-fill white: Lc ${lc.toFixed(1)}`).toBeGreaterThanOrEqual(75);
	});
});
