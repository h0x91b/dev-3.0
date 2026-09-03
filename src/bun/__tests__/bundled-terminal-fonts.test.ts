/**
 * `BUNDLED_TERMINAL_FONTS` names CSS families as plain strings, and `index.css` declares
 * them in a separate `@font-face` block. Nothing tied the two together: a family the list
 * names but the CSS never declares does not fail, it silently renders the fallback — with
 * that entry's `scale` still applied, so the text also comes out the wrong size.
 *
 * The bundled/system distinction is what makes it invisible. `isTerminalFontAvailable`
 * short-circuits to `true` for anything in this list precisely because it ships with the
 * app, so a typo'd family gets no "this device does not have that font" warning either.
 * That reasoning is only sound while every listed family really is on disk — which is what
 * this file asserts. See issue #1625 and the width-clamp decision record.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUNDLED_TERMINAL_FONTS, REFERENCE_TERMINAL_FONT } from "../../mainview/terminal-font";

const MAINVIEW = fileURLToPath(new URL("../../mainview/", import.meta.url));
const css = readFileSync(`${MAINVIEW}index.css`, "utf8");

/** Every `@font-face` in index.css, as family name → the url it loads. */
function declaredFaces(): Map<string, string[]> {
	const faces = new Map<string, string[]>();
	for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
		const family = block.match(/font-family:\s*'([^']+)'/)?.[1];
		const url = block.match(/url\('([^']+)'\)/)?.[1];
		if (!family || !url) continue;
		faces.set(family, [...(faces.get(family) ?? []), url]);
	}
	return faces;
}

describe("bundled terminal fonts", () => {
	const faces = declaredFaces();

	it.each(BUNDLED_TERMINAL_FONTS.map((f) => [f.label, f.family] as const))(
		"%s declares an @font-face and ships the file it points at",
		(_label, family) => {
			const urls = faces.get(family);
			expect(urls, `no @font-face declares font-family '${family}'`).toBeDefined();
			for (const url of urls ?? []) {
				const path = `${MAINVIEW}${url.replace(/^\.\//, "")}`;
				expect(existsSync(path), `${family} points at a missing file: ${url}`).toBe(true);
			}
		},
	);

	it("the reference font is the first entry and is itself unscaled", () => {
		// `terminalFontScale` measures every other font against this one, so it has to be
		// present and untouched or the whole width clamp is relative to nothing.
		expect(BUNDLED_TERMINAL_FONTS[0].family).toBe(REFERENCE_TERMINAL_FONT);
		expect(BUNDLED_TERMINAL_FONTS[0].scale).toBe(1);
		expect(faces.has(REFERENCE_TERMINAL_FONT)).toBe(true);
	});

	it("no two entries share a family or a label", () => {
		// A duplicate family makes one entry unreachable; a duplicate label makes the picker
		// ambiguous AND swallows a typed custom value, which is the #1625 complaint —
		// "JetBrains Mono" used to be the label of the Nerd Font face, so asking for the
		// unpatched typeface silently selected the patched one.
		const families = BUNDLED_TERMINAL_FONTS.map((f) => f.family);
		const labels = BUNDLED_TERMINAL_FONTS.map((f) => f.label);
		expect(new Set(families).size, `duplicate family in ${families.join(", ")}`).toBe(families.length);
		expect(new Set(labels).size, `duplicate label in ${labels.join(", ")}`).toBe(labels.length);
	});

	it("a label never names a different entry's family", () => {
		// The picker commits a typed value that matches no option, so a label colliding with
		// another entry's family name would route the user to the wrong face.
		const families = new Set(BUNDLED_TERMINAL_FONTS.map((f) => f.family));
		for (const font of BUNDLED_TERMINAL_FONTS) {
			if (font.label === font.family) continue;
			expect(families.has(font.label), `label '${font.label}' is another entry's family`).toBe(false);
		}
	});
});
