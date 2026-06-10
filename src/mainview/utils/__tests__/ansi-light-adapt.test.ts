import { describe, expect, it } from "vitest";
import { createAnsiLightFilter, darkenPaleRgb } from "../ansi-light-adapt";

const ESC = "\x1b";

function filterAll(chunks: string[], light = true): string {
	const filter = createAnsiLightFilter();
	return chunks.map((c) => filter(c, light)).join("");
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

describe("createAnsiLightFilter — dim handling (light)", () => {
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

describe("createAnsiLightFilter — 256-color foregrounds (light)", () => {
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

describe("createAnsiLightFilter — chunk boundaries", () => {
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

describe("createAnsiLightFilter — dark mode passthrough", () => {
	it("leaves everything untouched in dark mode", () => {
		const input = `${ESC}[2m${ESC}[38;5;226mfoo`;
		expect(filterAll([input], false)).toBe(input);
	});

	it("still joins sequences split across chunks in dark mode", () => {
		const out = filterAll([`${ESC}[38;5;2`, `26mfoo`], false);
		expect(out).toBe(`${ESC}[38;5;226mfoo`);
	});
});
