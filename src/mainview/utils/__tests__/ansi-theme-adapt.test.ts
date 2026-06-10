import { describe, expect, it } from "vitest";
import {
	brightenDarkRgb,
	createAnsiThemeFilter,
	darkenPaleRgb,
	type ThemeMode,
} from "../ansi-theme-adapt";

const ESC = "\x1b";

function filterAll(chunks: string[], mode: ThemeMode = "light"): string {
	const filter = createAnsiThemeFilter();
	return chunks.map((c) => filter(c, mode)).join("");
}

describe("darkenPaleRgb", () => {
	it("darkens pure yellow to an olive tone", () => {
		const result = darkenPaleRgb(255, 255, 0);
		expect(result).not.toBeNull();
		const [r, g, b] = result!;
		expect(r).toBeLessThan(160);
		expect(g).toBeLessThan(160);
		expect(b).toBe(0);
		expect(r).toBe(g);
	});

	it("keeps dark colors untouched", () => {
		expect(darkenPaleRgb(88, 88, 88)).toBeNull();
		expect(darkenPaleRgb(0, 0, 0)).toBeNull();
		expect(darkenPaleRgb(36, 41, 47)).toBeNull();
	});

	it("darkens pale cyan", () => {
		const result = darkenPaleRgb(0, 255, 255);
		expect(result).not.toBeNull();
		const [, g, b] = result!;
		expect(g).toBeLessThan(180);
		expect(b).toBeLessThan(180);
	});
});

describe("brightenDarkRgb", () => {
	it("brightens GitHub-light ink gray (#333333)", () => {
		expect(brightenDarkRgb(51, 51, 51)).toEqual([108, 108, 108]);
	});

	it("brightens pure black extra (near-black boost, no division issues)", () => {
		// Pure black gets the highest target — Codex paints its model name
		// with #000000, which must stay clearly visible on a dark background.
		expect(brightenDarkRgb(0, 0, 0)).toEqual([153, 153, 153]);
	});

	it("brightens GitHub-light navy (#183691) keeping hue order", () => {
		const result = brightenDarkRgb(24, 54, 145);
		expect(result).not.toBeNull();
		const [r, g, b] = result!;
		expect(b).toBeGreaterThan(g);
		expect(g).toBeGreaterThan(r);
		expect(b).toBeGreaterThan(145);
	});

	it("keeps already-readable colors untouched", () => {
		expect(brightenDarkRgb(0, 134, 179)).toBeNull();
		expect(brightenDarkRgb(169, 177, 214)).toBeNull();
		expect(brightenDarkRgb(255, 255, 0)).toBeNull();
	});
});

describe("createAnsiThemeFilter — dim handling (light)", () => {
	it("drops a standalone dim sequence", () => {
		expect(filterAll([`${ESC}[2mfoo`])).toBe("foo");
	});

	it("removes dim from compound params but keeps the rest", () => {
		expect(filterAll([`${ESC}[0;2mfoo`])).toBe(`${ESC}[0mfoo`);
		expect(filterAll([`${ESC}[1;2;31mbar`])).toBe(`${ESC}[1;31mbar`);
	});

	it("does not confuse dim with the 2 in truecolor introducers", () => {
		const input = `${ESC}[38;2;10;20;30mx`;
		expect(filterAll([input])).toBe(input);
	});

	it("keeps reset and bold-off sequences", () => {
		expect(filterAll([`${ESC}[0mfoo`])).toBe(`${ESC}[0mfoo`);
		expect(filterAll([`${ESC}[22mfoo`])).toBe(`${ESC}[22mfoo`);
		expect(filterAll([`${ESC}[mfoo`])).toBe(`${ESC}[mfoo`);
	});
});

describe("createAnsiThemeFilter — 256-color foregrounds (light)", () => {
	it("rewrites pale indexed foreground to a darker truecolor", () => {
		const out = filterAll([`${ESC}[38;5;226mfoo`]);
		expect(out).toMatch(/^\x1b\[38;2;\d+;\d+;\d+mfoo$/);
		const [r, g, b] = out.match(/38;2;(\d+);(\d+);(\d+)/)!.slice(1).map(Number);
		expect(r).toBeLessThan(160);
		expect(g).toBeLessThan(160);
		expect(b).toBe(0);
	});

	it("keeps dark indexed foregrounds untouched", () => {
		const input = `${ESC}[38;5;240mfoo`;
		expect(filterAll([input])).toBe(input);
	});

	it("keeps theme-mapped indices (0-15) untouched", () => {
		const input = `${ESC}[38;5;7mfoo`;
		expect(filterAll([input])).toBe(input);
	});

	it("does not touch indexed backgrounds", () => {
		const input = `${ESC}[48;5;226mfoo`;
		expect(filterAll([input])).toBe(input);
	});

	it("darkens pale truecolor foregrounds", () => {
		const out = filterAll([`${ESC}[38;2;215;175;255mfoo`]);
		expect(out).toMatch(/^\x1b\[38;2;\d+;\d+;\d+mfoo$/);
		expect(out).not.toBe(`${ESC}[38;2;215;175;255mfoo`);
	});

	it("preserves surrounding params when rewriting", () => {
		const out = filterAll([`${ESC}[1;38;5;226;4mfoo`]);
		expect(out).toMatch(/^\x1b\[1;38;2;\d+;\d+;\d+;4mfoo$/);
	});

	it("handles colon-form indexed colors", () => {
		const out = filterAll([`${ESC}[38:5:226mfoo`]);
		expect(out).toMatch(/^\x1b\[38;2;\d+;\d+;\d+mfoo$/);
	});
});

describe("createAnsiThemeFilter — white backgrounds (light)", () => {
	// Claude Code's light-ansi theme paints message bars with "ansi:white"
	// (SGR 47) and dark fg (30/90) on top. Our palette `white` is a dark gray
	// (legible as 37 text), so as a background it must become light gray.
	it("rewrites SGR 47 to a light gray truecolor background", () => {
		expect(filterAll([`${ESC}[47mfoo`])).toBe(`${ESC}[48;2;220;220;220mfoo`);
	});

	it("rewrites SGR 107 to a near-white truecolor background", () => {
		expect(filterAll([`${ESC}[107mfoo`])).toBe(`${ESC}[48;2;240;240;240mfoo`);
	});

	it("rewrites indexed white backgrounds (48;5;7 and 48;5;15)", () => {
		expect(filterAll([`${ESC}[48;5;7mfoo`])).toBe(`${ESC}[48;2;220;220;220mfoo`);
		expect(filterAll([`${ESC}[48;5;15mfoo`])).toBe(`${ESC}[48;2;240;240;240mfoo`);
	});

	it("preserves surrounding params (Claude message bar pattern)", () => {
		expect(filterAll([`${ESC}[90m${ESC}[47mbar`])).toBe(
			`${ESC}[90m${ESC}[48;2;220;220;220mbar`,
		);
	});

	it("leaves other background codes untouched", () => {
		expect(filterAll([`${ESC}[40mfoo`])).toBe(`${ESC}[40mfoo`);
		expect(filterAll([`${ESC}[44mfoo`])).toBe(`${ESC}[44mfoo`);
		expect(filterAll([`${ESC}[48;5;28mfoo`])).toBe(`${ESC}[48;5;28mfoo`);
	});
});

describe("createAnsiThemeFilter — dark foregrounds (dark)", () => {
	it("brightens Codex ink-gray truecolor foreground", () => {
		expect(filterAll([`${ESC}[38;2;51;51;51mfoo`], "dark")).toBe(
			`${ESC}[38;2;108;108;108mfoo`,
		);
	});

	it("brightens pure black truecolor foreground", () => {
		const out = filterAll([`${ESC}[38;2;0;0;0mfoo`], "dark");
		expect(out).toMatch(/^\x1b\[38;2;(\d+);\1;\1mfoo$/);
		expect(out).not.toBe(`${ESC}[38;2;0;0;0mfoo`);
	});

	it("brightens dark indexed foregrounds (grayscale ramp)", () => {
		const out = filterAll([`${ESC}[38;5;232mfoo`], "dark");
		expect(out).toMatch(/^\x1b\[38;2;\d+;\d+;\d+mfoo$/);
	});

	it("keeps readable foregrounds untouched", () => {
		const input = `${ESC}[38;2;0;134;179mfoo`;
		expect(filterAll([input], "dark")).toBe(input);
	});

	it("keeps pale foregrounds untouched in dark mode", () => {
		const input = `${ESC}[38;5;226mfoo`;
		expect(filterAll([input], "dark")).toBe(input);
	});

	it("keeps dim sequences in dark mode", () => {
		const input = `${ESC}[2mfoo`;
		expect(filterAll([input], "dark")).toBe(input);
	});

	it("keeps theme-mapped indices (0-15) untouched", () => {
		const input = `${ESC}[38;5;0mfoo`;
		expect(filterAll([input], "dark")).toBe(input);
	});
});

describe("createAnsiThemeFilter — white backgrounds (dark)", () => {
	// Claude Code paints message bars and the history-select highlight with
	// "ansi:white"/"ansi:whiteBright"; the dark palette resolves those to pale
	// lavender, so default-fg text on them washes out. Remap to Claude Code's
	// own dark theme bar colors.
	it("rewrites SGR 47 to a dark gray truecolor background", () => {
		expect(filterAll([`${ESC}[47mfoo`], "dark")).toBe(`${ESC}[48;2;55;55;55mfoo`);
	});

	it("rewrites SGR 107 to a slightly lighter dark gray", () => {
		expect(filterAll([`${ESC}[107mfoo`], "dark")).toBe(`${ESC}[48;2;70;70;70mfoo`);
	});

	it("rewrites indexed white backgrounds (48;5;7 and 48;5;15)", () => {
		expect(filterAll([`${ESC}[48;5;7mfoo`], "dark")).toBe(`${ESC}[48;2;55;55;55mfoo`);
		expect(filterAll([`${ESC}[48;5;15mfoo`], "dark")).toBe(`${ESC}[48;2;70;70;70mfoo`);
	});

	it("flips a dark fg set before the bar (Claude fg-then-bg pattern)", () => {
		expect(filterAll([`${ESC}[90m${ESC}[47mbar`], "dark")).toBe(
			`${ESC}[90m${ESC}[48;2;55;55;55;38;2;160;160;160mbar`,
		);
	});

	it("flips a dark fg set after the bar opens", () => {
		expect(filterAll([`${ESC}[47m${ESC}[30mfoo`], "dark")).toBe(
			`${ESC}[48;2;55;55;55m${ESC}[38;2;220;220;220mfoo`,
		);
	});

	it("still brightens too-dark truecolor fg on the remapped bar", () => {
		expect(filterAll([`${ESC}[47m${ESC}[38;2;51;51;51mfoo`], "dark")).toBe(
			`${ESC}[48;2;55;55;55m${ESC}[38;2;108;108;108mfoo`,
		);
	});

	it("does not flip fg after a reset cleared the dark-fg track", () => {
		expect(filterAll([`${ESC}[90m${ESC}[0m${ESC}[47mfoo`], "dark")).toBe(
			`${ESC}[90m${ESC}[0m${ESC}[48;2;55;55;55mfoo`,
		);
	});

	it("tracks the dark fg across chunk boundaries", () => {
		const out = filterAll([`${ESC}[90mfoo`, `${ESC}[47mbar`], "dark");
		expect(out).toBe(`${ESC}[90mfoo${ESC}[48;2;55;55;55;38;2;160;160;160mbar`);
	});
});

describe("createAnsiThemeFilter — bg/reverse gating", () => {
	it("does not adjust fg while an explicit background is active (dark)", () => {
		const input = `${ESC}[44m${ESC}[38;2;51;51;51mfoo`;
		expect(filterAll([input], "dark")).toBe(input);
	});

	it("does not adjust fg while an explicit background is active (light)", () => {
		const input = `${ESC}[48;5;28m${ESC}[38;5;226mfoo`;
		expect(filterAll([input], "light")).toBe(input);
	});

	it("does not adjust fg while reverse video is active", () => {
		const input = `${ESC}[7m${ESC}[38;2;51;51;51mfoo`;
		expect(filterAll([input], "dark")).toBe(input);
	});

	it("resumes adjusting after SGR 0 reset", () => {
		const out = filterAll([`${ESC}[44m${ESC}[0m${ESC}[38;2;51;51;51mfoo`], "dark");
		expect(out).toBe(`${ESC}[44m${ESC}[0m${ESC}[38;2;108;108;108mfoo`);
	});

	it("resumes adjusting after bg-clear (49) and reverse-off (27)", () => {
		const out = filterAll(
			[`${ESC}[44;49m${ESC}[7;27m${ESC}[38;2;51;51;51mfoo`],
			"dark",
		);
		expect(out).toBe(`${ESC}[44;49m${ESC}[7;27m${ESC}[38;2;108;108;108mfoo`);
	});

	it("gates fg within the same compound sequence", () => {
		const input = `${ESC}[44;38;2;51;51;51mfoo`;
		expect(filterAll([input], "dark")).toBe(input);
	});

	it("white bars do not gate fg adjustment (light)", () => {
		const out = filterAll([`${ESC}[47m${ESC}[38;5;226mfoo`], "light");
		expect(out).toMatch(/^\x1b\[48;2;220;220;220m\x1b\[38;2;\d+;\d+;\d+mfoo$/);
	});

	it("persists gate state across chunks", () => {
		const out = filterAll([`${ESC}[44mfoo`, `${ESC}[38;2;51;51;51mbar`], "dark");
		expect(out).toBe(`${ESC}[44mfoo${ESC}[38;2;51;51;51mbar`);
	});

	it("empty SGR (ESC[m) resets the gate", () => {
		const out = filterAll([`${ESC}[44m${ESC}[m${ESC}[38;2;51;51;51mfoo`], "dark");
		expect(out).toBe(`${ESC}[44m${ESC}[m${ESC}[38;2;108;108;108mfoo`);
	});
});

describe("createAnsiThemeFilter — chunk boundaries", () => {
	it("rewrites a sequence split across two chunks", () => {
		const out = filterAll([`${ESC}[38;5;2`, `26mfoo`]);
		expect(out).toMatch(/^\x1b\[38;2;\d+;\d+;\d+mfoo$/);
	});

	it("holds back a bare trailing ESC", () => {
		const out = filterAll([`foo${ESC}`, `[2mbar`]);
		expect(out).toBe("foobar");
	});

	it("passes through unrelated escape sequences", () => {
		const input = `${ESC}[2J${ESC}[H${ESC}]0;title\x07foo`;
		expect(filterAll([input])).toBe(input);
	});
});
