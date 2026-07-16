import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	generateThemeSwift,
	parseCssTheme,
	parseThemeSources,
	readThemeSources,
	THEME_OUTPUT_PATH,
} from "./gen-theme";

describe("native theme generator", () => {
	test("extracts the complete matching dark and light CSS token sets", () => {
		const source = readThemeSources();
		const dark = parseCssTheme(source.css, "dark");
		const light = parseCssTheme(source.css, "light");

		expect(Object.keys(dark).length).toBeGreaterThan(50);
		expect(Object.keys(light)).toEqual(Object.keys(dark));
		expect(dark["surface-base"]).toBe("6 9 21");
		expect(light["surface-base"]).toBe("240 242 250");
		expect(dark["shadow-column"]).toContain("rgb(0 0 0 / 0.3)");
	});

	test("ports status, label, terminal, composite glass, and scalar tokens", () => {
		const parsed = parseThemeSources(readThemeSources());

		expect(parsed.statuses).toHaveLength(8);
		expect(parsed.labels).toHaveLength(12);
		expect(parsed.terminal.dark).toHaveLength(20);
		expect(parsed.terminal.light).toHaveLength(20);
		expect(parsed.semanticColors.find(color => color.caseName === "glassCard")?.dark.opacity).toBe(0.04);
		expect(parsed.semanticColors.find(color => color.caseName === "glassCard")?.light.opacity).toBe(0.72);
		expect(parsed.metrics.find(metric => metric.name === "glassBlurColumn")?.dark).toBe(12);
	});

	test("emits deterministic semantic SwiftUI APIs and Nerd Font glyphs", () => {
		const first = generateThemeSwift(readThemeSources());
		const second = generateThemeSwift(readThemeSources());

		expect(first).toBe(second);
		expect(first).toContain("public var surfaceBase: Color");
		expect(first).toContain("public func statusColor(_ status: Dev3StatusToken) -> Color");
		expect(first).toContain("public let terminal: Dev3TerminalPalette");
		expect(first).toContain('public static let fileTree = "\\u{F0645}"');
		expect(first).toContain('"shadow-card-hover":');
	});

	test("checked-in Theme.swift exactly matches regeneration", () => {
		const generated = generateThemeSwift(readThemeSources());
		const checkedIn = readFileSync(THEME_OUTPUT_PATH, "utf8");
		expect(checkedIn).toBe(generated);
	});

	test("rejects drift when a theme loses a token", () => {
		const source = readThemeSources();
		const brokenCss = source.css.replace("--warning: 202 138 4;", "");
		expect(() => parseThemeSources({ ...source, css: brokenCss })).toThrow("Theme token mismatch");
	});
});
