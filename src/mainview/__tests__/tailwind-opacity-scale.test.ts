import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import defaultTheme from "tailwindcss/defaultTheme";
import { describe, expect, it } from "vitest";
import config from "../../../tailwind.config.js";

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
 * Tailwind v3 silently drops a colour opacity modifier that is not in
 * `theme.opacity`: `hover:bg-fg/8` compiled to nothing on 13 controls before
 * 8 and 12 joined the scale. No warning, no build error — only this test.
 */
const SCALE = new Set([...Object.keys(defaultTheme.opacity), ...Object.keys(config.theme.extend.opacity ?? {})]);

const MODIFIER =
	/(?<![\w-])(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|divide|fill|stroke|from|via|to|shadow|decoration|caret|accent|placeholder)-[a-z][a-z0-9-]*\/(\d+)(?![\w.\]])/g;

// v3 cannot put an alpha on a keyword colour: `border-current/30` emits nothing.
// Use `border-[color-mix(in_srgb,currentColor_30%,transparent)]` or a real token.
const KEYWORD_ALPHA =
	/(?<![\w-])(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|divide|fill|stroke|from|via|to|shadow|decoration|caret|accent|placeholder)-(?:current|inherit|transparent)\/\d+(?![\w.\]])/g;

function offScale(source: string): string[] {
	return [...source.matchAll(MODIFIER)].filter((m) => !SCALE.has(m[1])).map((m) => m[0]);
}

describe("tailwind opacity scale", () => {
	const files = walk(SRC);

	it("scans a meaningful number of source files", () => {
		expect(files.length).toBeGreaterThan(100);
	});

	it("keeps 8 and 12 in the configured scale", () => {
		expect(SCALE.has("8")).toBe(true);
		expect(SCALE.has("12")).toBe(true);
	});

	// Built at runtime: the content glob covers this directory, so a literal would emit CSS.
	it("flags an off-scale modifier and accepts on-scale ones", () => {
		const join = (...parts: string[]) => parts.join("/");
		expect(offScale(`hover:${join("bg-fg", "7")} ${join("ring-accent", "33")}`)).toEqual([join("bg-fg", "7"), join("ring-accent", "33")]);
		expect(offScale(`${join("bg-fg", "8")} ${join("bg-accent", "12")} ${join("border-edge", "40")} w-1/2 ${join("bg-fg", "[.07]")}`)).toEqual([]);
	});

	it("uses no colour opacity modifier outside the scale", () => {
		const offenders = files.flatMap((file) =>
			offScale(readFileSync(file, "utf8")).map((cls) => `${path.relative(SRC, file)}: ${cls}`),
		);
		expect(offenders).toEqual([]);
	});

	it("puts no opacity modifier on a keyword colour", () => {
		const offenders = files.flatMap((file) =>
			[...readFileSync(file, "utf8").matchAll(KEYWORD_ALPHA)].map((m) => `${path.relative(SRC, file)}: ${m[0]}`),
		);
		expect(offenders).toEqual([]);
	});
});
