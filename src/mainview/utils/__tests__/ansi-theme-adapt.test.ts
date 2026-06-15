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

const DARK_DIM = "38;2;112;120;150";
const LIGHT_DIM = "38;2;130;130;130";

describe("createAnsiThemeFilter — dim handling (both themes)", () => {
	// ghostty renders SGR dim as 50% alpha — too faint to read on dark, washed
	// out on white. Dropping dim makes muted text (ghost suggestions, select
	// descriptions, hints) look like typed input. Dim over the default fg is
	// emulated as an explicit muted gray: readable, yet clearly secondary.
	it("emulates a standalone dim over default fg as a muted gray", () => {
		expect(filterAll([`${ESC}[2mfoo`], "dark")).toBe(`${ESC}[${DARK_DIM}mfoo`);
		expect(filterAll([`${ESC}[2mfoo`], "light")).toBe(`${ESC}[${LIGHT_DIM}mfoo`);
	});

	it("emulates dim after a reset (Claude placeholder pattern)", () => {
		// Claude draws the input ghost text as `\x1b[0;2m<text>\x1b[0m`.
		expect(filterAll([`${ESC}[0;2mfoo`], "dark")).toBe(`${ESC}[0;${DARK_DIM}mfoo`);
		expect(filterAll([`${ESC}[0;2mfoo`], "light")).toBe(`${ESC}[0;${LIGHT_DIM}mfoo`);
	});

	it("integrates with reverse cursor + reset (full placeholder line)", () => {
		expect(filterAll([`${ESC}[7mп${ESC}[0;2mrest${ESC}[0m`], "dark")).toBe(
			`${ESC}[7mп${ESC}[0;${DARK_DIM}mrest${ESC}[0m`,
		);
	});

	it("drops dim when an explicit color overrides it (color wins)", () => {
		// `1;2;31` = bold + dim + red → the red takes over, dim is dropped.
		expect(filterAll([`${ESC}[1;2;31mbar`], "dark")).toBe(`${ESC}[1;31mbar`);
		expect(filterAll([`${ESC}[1;2;31mbar`], "light")).toBe(`${ESC}[1;31mbar`);
	});

	it("drops dim around an indexed fg in a later sequence (color wins)", () => {
		// dim then an explicit pale index: the index wins, so the leading dim
		// flushes a (harmless, overridden) gray and the color follows.
		expect(filterAll([`${ESC}[2m${ESC}[38;5;231m desc ${ESC}[0m`], "dark")).toBe(
			`${ESC}[${DARK_DIM}m${ESC}[38;5;231m desc ${ESC}[0m`,
		);
	});

	it("resets the emulated gray on SGR 22 (dim off)", () => {
		expect(filterAll([`${ESC}[2mfoo${ESC}[22mbar`], "dark")).toBe(
			`${ESC}[${DARK_DIM}mfoo${ESC}[22;39mbar`,
		);
	});

	it("does not confuse dim with the 2 in truecolor introducers (dark)", () => {
		const input = `${ESC}[38;2;10;20;30mx`;
		// 38;2;10;20;30 is below the dark brighten threshold, so it is rewritten,
		// but the introducer 2 must not be mistaken for dim.
		const out = filterAll([input], "dark");
		expect(out).toMatch(/^\x1b\[38;2;\d+;\d+;\d+mx$/);
		expect(out).not.toContain(DARK_DIM);
	});

	it("does not confuse dim with the 2 in truecolor introducers (light)", () => {
		const input = `${ESC}[38;2;10;20;30mx`;
		expect(filterAll([input], "light")).toBe(input);
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

	it("emulates dim as a muted gray in dark mode", () => {
		expect(filterAll([`${ESC}[2mfoo`], "dark")).toBe(`${ESC}[${DARK_DIM}mfoo`);
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

	it("brightens black fg on an explicit dark truecolor bg (dark)", () => {
		// Codex paints its whole UI on 48;2;30;30;46 and writes the model
		// name with 38;2;0;0;0 on top — black on dark must still be fixed.
		const out = filterAll([`${ESC}[48;2;30;30;46m${ESC}[38;2;0;0;0mgpt`], "dark");
		expect(out).toBe(`${ESC}[48;2;30;30;46m${ESC}[38;2;153;153;153mgpt`);
	});

	it("brightens indexed fg on an explicit dark indexed bg (dark)", () => {
		const out = filterAll([`${ESC}[48;5;16m${ESC}[38;5;16mfoo`], "dark");
		expect(out).toBe(`${ESC}[48;5;16m${ESC}[38;2;153;153;153mfoo`);
	});

	it("keeps dark fg on an explicit light truecolor bg (dark)", () => {
		const input = `${ESC}[48;2;180;190;254m${ESC}[38;2;0;0;0mfoo`;
		expect(filterAll([input], "dark")).toBe(input);
	});

	it("darkens pale fg on an explicit light truecolor bg (light)", () => {
		const out = filterAll([`${ESC}[48;2;255;255;230m${ESC}[38;2;255;255;0mfoo`], "light");
		expect(out).toMatch(/^\x1b\[48;2;255;255;230m\x1b\[38;2;\d+;\d+;0mfoo$/);
		expect(out).not.toContain("38;2;255;255;0");
	});

	it("keeps pale fg on an explicit dark truecolor bg (light)", () => {
		const input = `${ESC}[48;2;30;30;46m${ESC}[38;5;226mfoo`;
		expect(filterAll([input], "light")).toBe(input);
	});
});

describe("createAnsiThemeFilter — fg adjusted before a gating bg arrives", () => {
	// Claude Code's status-line branch pill emits fg *before* bg in separate
	// sequences: ESC[38;5;16m (pure black) then ESC[48;5;37m (teal). The fg
	// was already brightened by the time the gating bg arrives, leaving gray
	// on teal. The original fg must be restored when a bg that gates fg
	// adjustment opens with no text drawn in between.
	it("restores black indexed fg when a teal bg follows (Claude branch pill, dark)", () => {
		const out = filterAll([`${ESC}[38;5;16m${ESC}[48;5;37m pill `], "dark");
		expect(out).toBe(`${ESC}[38;2;153;153;153m${ESC}[48;5;37;38;5;16m pill `);
	});

	it("restores fg when fg and bg sit in the same compound sequence", () => {
		const out = filterAll([`${ESC}[38;5;16;48;5;37mfoo`], "dark");
		expect(out).toBe(`${ESC}[38;2;153;153;153;48;5;37;38;5;16mfoo`);
	});

	it("restores fg across a chunk boundary", () => {
		const out = filterAll([`${ESC}[38;5;16m`, `${ESC}[48;5;37mfoo`], "dark");
		expect(out).toBe(`${ESC}[38;2;153;153;153m${ESC}[48;5;37;38;5;16mfoo`);
	});

	it("restores truecolor fg before a named ANSI bg", () => {
		const out = filterAll([`${ESC}[38;2;0;0;0m${ESC}[44mfoo`], "dark");
		expect(out).toBe(`${ESC}[38;2;153;153;153m${ESC}[44;38;2;0;0;0mfoo`);
	});

	it("restores fg before reverse video opens", () => {
		const out = filterAll([`${ESC}[38;5;16m${ESC}[7mfoo`], "dark");
		expect(out).toBe(`${ESC}[38;2;153;153;153m${ESC}[7;38;5;16mfoo`);
	});

	it("does not restore when text was drawn between fg and bg", () => {
		const out = filterAll([`${ESC}[38;5;16mfoo${ESC}[48;5;37mbar`], "dark");
		expect(out).toBe(`${ESC}[38;2;153;153;153mfoo${ESC}[48;5;37mbar`);
	});

	it("does not restore when text intervenes across a chunk boundary", () => {
		const out = filterAll([`${ESC}[38;5;16mfoo`, `${ESC}[48;5;37mbar`], "dark");
		expect(out).toBe(`${ESC}[38;2;153;153;153mfoo${ESC}[48;5;37mbar`);
	});

	it("keeps the adjusted fg when a same-polarity bg follows (Codex, dark)", () => {
		const out = filterAll([`${ESC}[38;2;0;0;0m${ESC}[48;2;30;30;46mfoo`], "dark");
		expect(out).toBe(`${ESC}[38;2;153;153;153m${ESC}[48;2;30;30;46mfoo`);
	});

	it("keeps the adjusted fg when a remapped white bar follows (dark)", () => {
		const out = filterAll([`${ESC}[38;2;0;0;0m${ESC}[47mfoo`], "dark");
		expect(out).toBe(`${ESC}[38;2;153;153;153m${ESC}[48;2;55;55;55mfoo`);
	});

	it("restores pale fg before a dark bg (light mode mirror)", () => {
		const out = filterAll([`${ESC}[38;5;226m${ESC}[48;2;30;30;46mfoo`], "light");
		expect(out).toMatch(
			/^\x1b\[38;2;\d+;\d+;0m\x1b\[48;2;30;30;46;38;5;226mfoo$/,
		);
	});

	it("does not restore after a newer fg replaced the adjusted one", () => {
		const out = filterAll([`${ESC}[38;5;16m${ESC}[39m${ESC}[48;5;37mfoo`], "dark");
		expect(out).toBe(`${ESC}[38;2;153;153;153m${ESC}[39m${ESC}[48;5;37mfoo`);
	});

	it("does not restore after a reset", () => {
		const out = filterAll([`${ESC}[38;5;16m${ESC}[0m${ESC}[48;5;37mfoo`], "dark");
		expect(out).toBe(`${ESC}[38;2;153;153;153m${ESC}[0m${ESC}[48;5;37mfoo`);
	});
});

describe("createAnsiThemeFilter — chunk boundaries", () => {
	it("rewrites a sequence split across two chunks", () => {
		const out = filterAll([`${ESC}[38;5;2`, `26mfoo`]);
		expect(out).toMatch(/^\x1b\[38;2;\d+;\d+;\d+mfoo$/);
	});

	it("holds back a bare trailing ESC across the chunk boundary", () => {
		// The ESC split from its `[2m` is reassembled, then the dim is emulated.
		const out = filterAll([`foo${ESC}`, `[2mbar`]);
		expect(out).toBe(`foo${ESC}[${LIGHT_DIM}mbar`);
	});

	it("passes through unrelated escape sequences", () => {
		const input = `${ESC}[2J${ESC}[H${ESC}]0;title\x07foo`;
		expect(filterAll([input])).toBe(input);
	});
});
