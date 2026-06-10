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
		expect(brightenDarkRgb(51, 51, 51)).toEqual([97, 97, 97]);
	});

	it("brightens pure black without division issues", () => {
		const result = brightenDarkRgb(0, 0, 0);
		expect(result).not.toBeNull();
		const [r, g, b] = result!;
		expect(r).toBe(g);
		expect(g).toBe(b);
		expect(r).toBeGreaterThan(80);
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
			`${ESC}[38;2;97;97;97mfoo`,
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

	it("keeps white backgrounds untouched in dark mode", () => {
		expect(filterAll([`${ESC}[47mfoo`], "dark")).toBe(`${ESC}[47mfoo`);
		expect(filterAll([`${ESC}[48;5;7mfoo`], "dark")).toBe(`${ESC}[48;5;7mfoo`);
	});

	it("keeps theme-mapped indices (0-15) untouched", () => {
		const input = `${ESC}[38;5;0mfoo`;
		expect(filterAll([input], "dark")).toBe(input);
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
		expect(out).toBe(`${ESC}[44m${ESC}[0m${ESC}[38;2;97;97;97mfoo`);
	});

	it("resumes adjusting after bg-clear (49) and reverse-off (27)", () => {
		const out = filterAll(
			[`${ESC}[44;49m${ESC}[7;27m${ESC}[38;2;51;51;51mfoo`],
			"dark",
		);
		expect(out).toBe(`${ESC}[44;49m${ESC}[7;27m${ESC}[38;2;97;97;97mfoo`);
	});

	it("gates fg within the same compound sequence", () => {
		const input = `${ESC}[44;38;2;51;51;51mfoo`;
		expect(filterAll([input], "dark")).toBe(input);
	});

	it("persists gate state across chunks", () => {
		const out = filterAll([`${ESC}[44mfoo`, `${ESC}[38;2;51;51;51mbar`], "dark");
		expect(out).toBe(`${ESC}[44mfoo${ESC}[38;2;51;51;51mbar`);
	});

	it("empty SGR (ESC[m) resets the gate", () => {
		const out = filterAll([`${ESC}[44m${ESC}[m${ESC}[38;2;51;51;51mfoo`], "dark");
		expect(out).toBe(`${ESC}[44m${ESC}[m${ESC}[38;2;97;97;97mfoo`);
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
