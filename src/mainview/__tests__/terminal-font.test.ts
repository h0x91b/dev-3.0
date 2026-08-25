import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
	applyTerminalFontFamily,
	applyTerminalFontSize,
	bootstrapTerminalFont,
	BUNDLED_TERMINAL_FONTS,
	effectiveTerminalFontSize,
	REFERENCE_TERMINAL_FONT,
	terminalFontScale,
	DEFAULT_TERMINAL_FONT_SIZE,
	DEFAULT_TERMINAL_FONT_STACK,
	getTerminalFontFamily,
	getTerminalFontSize,
	isTerminalFontAvailable,
	MAX_TERMINAL_FONT_SIZE,
	MIN_TERMINAL_FONT_SIZE,
	terminalFontStack,
	TERMINAL_FONT_CHANGED_EVENT,
} from "../terminal-font";

beforeEach(() => {
	localStorage.clear();
	bootstrapTerminalFont();
});

afterEach(() => vi.restoreAllMocks());

describe("defaults are today's terminal", () => {
	it("an untouched install renders exactly the bundled stack at 14px", () => {
		expect(getTerminalFontFamily()).toBe("");
		expect(getTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);
		expect(terminalFontStack()).toBe(DEFAULT_TERMINAL_FONT_STACK);
	});
});

describe("terminalFontStack", () => {
	it("puts the user's family first and keeps the old stack as the fallback tail", () => {
		expect(terminalFontStack("Fira Code")).toBe(`'Fira Code', ${DEFAULT_TERMINAL_FONT_STACK}`);
	});

	it("falls back to the bundled stack for blank input", () => {
		expect(terminalFontStack("   ")).toBe(DEFAULT_TERMINAL_FONT_STACK);
	});

	it("cannot break out of the CSS font-family value", () => {
		// A family name reaches the terminal as a raw CSS token, so a quote or a
		// semicolon in it would end the declaration and let the rest be anything.
		const stack = terminalFontStack("Evil'; color: red; font-family: X");
		expect(stack.startsWith("'Evil color: red font-family: X'")).toBe(true);
		expect(stack).not.toContain(";");
	});
});

describe("persistence and clamping", () => {
	it("keeps a saved family and size across a reload", () => {
		applyTerminalFontFamily("Iosevka");
		applyTerminalFontSize(20);
		bootstrapTerminalFont();
		expect(getTerminalFontFamily()).toBe("Iosevka");
		expect(getTerminalFontSize()).toBe(20);
	});

	it("clamps a size out of range instead of shipping an unreadable terminal", () => {
		applyTerminalFontSize(999);
		expect(getTerminalFontSize()).toBe(MAX_TERMINAL_FONT_SIZE);
		applyTerminalFontSize(1);
		expect(getTerminalFontSize()).toBe(MIN_TERMINAL_FONT_SIZE);
	});

	it("falls back to the default when the stored size is garbage", () => {
		localStorage.setItem("dev3-terminal-font-size", "not-a-number");
		bootstrapTerminalFont();
		expect(getTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);
	});
});

describe("change event", () => {
	it("carries the family, the size and the ready-to-use stack", () => {
		const seen: unknown[] = [];
		const listener = (e: Event) => seen.push((e as CustomEvent).detail);
		window.addEventListener(TERMINAL_FONT_CHANGED_EVENT, listener);
		applyTerminalFontFamily("Hack");
		window.removeEventListener(TERMINAL_FONT_CHANGED_EVENT, listener);
		expect(seen).toEqual([
			{ family: "Hack", size: DEFAULT_TERMINAL_FONT_SIZE, stack: `'Hack', ${DEFAULT_TERMINAL_FONT_STACK}` },
		]);
	});
});

describe("availability", () => {
	/**
	 * A fake 2d context whose text width depends only on the FIRST family it can
	 * resolve — the same thing a real canvas does, which is what makes the probe work.
	 */
	function stubCanvas(installed: string[]) {
		const widths: Record<string, number> = { monospace: 100, serif: 130, "sans-serif": 160 };
		const ctx = {
			font: "",
			measureText: () => {
				const families = ctx.font.replace(/^\d+px\s*/, "").split(",").map((f) => f.trim().replace(/^'|'$/g, ""));
				const hit = families.find((f) => installed.includes(f) || f in widths);
				return { width: hit && hit in widths ? widths[hit] : 999 };
			},
		};
		vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
			tag === "canvas" ? { getContext: () => ctx } : document.body) as never);
	}

	it("reports a font this device lacks, so the fallback is never a mystery", () => {
		stubCanvas([]);
		expect(isTerminalFontAvailable("Nope Mono")).toBe(false);
	});

	it("reports a font this device does have", () => {
		stubCanvas(["Iosevka"]);
		expect(isTerminalFontAvailable("Iosevka")).toBe(true);
	});

	it("probes every generic — one alone cannot tell a missing font from a matching one", () => {
		// A family whose metrics happen to equal `monospace` is not proof of absence;
		// only agreeing with ALL THREE generics is. Checking one base would mislabel
		// a real font as missing the moment its width matched that base.
		const seen: string[] = [];
		const ctx = {
			font: "",
			measureText: () => { seen.push(ctx.font); return { width: 100 }; },
		};
		vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
			tag === "canvas" ? { getContext: () => ctx } : document.body) as never);
		isTerminalFontAvailable("Whatever Mono");
		for (const base of ["monospace", "serif", "sans-serif"]) {
			expect(seen.some((f) => f === `72px ${base}`)).toBe(true);
			expect(seen.some((f) => f === `72px 'Whatever Mono', ${base}`)).toBe(true);
		}
	});

	it("never warns about the bundled default or about a check it could not run", () => {
		vi.spyOn(document, "createElement").mockImplementation((() => ({ getContext: () => null })) as never);
		expect(isTerminalFontAvailable("")).toBe(true);
		expect(isTerminalFontAvailable("Anything")).toBe(true);
	});

	it("never warns about a bundled font — it ships with the app, the device is irrelevant", () => {
		stubCanvas([]); // this machine has nothing installed
		expect(isTerminalFontAvailable("IosevkaTerm Nerd Font Mono")).toBe(true);
	});
});

describe("the app's own monospace text follows the same font", () => {
	const stack = () => document.documentElement.style.getPropertyValue("--dev3-mono-stack");

	it("points the font-mono utility at the chosen family", () => {
		// `font-mono` resolves to this variable, so writing it is what makes branch
		// names, paths and seq numbers match the terminal.
		applyTerminalFontFamily("Hack Nerd Font Mono");
		expect(stack()).toBe(`'Hack Nerd Font Mono', ${DEFAULT_TERMINAL_FONT_STACK}`);
	});

	it("is already correct before React mounts, not one repaint later", () => {
		localStorage.setItem("dev3-terminal-font-family", "Iosevka Nerd Font Mono");
		document.documentElement.style.removeProperty("--dev3-mono-stack");
		bootstrapTerminalFont();
		expect(stack()).toBe(`'Iosevka Nerd Font Mono', ${DEFAULT_TERMINAL_FONT_STACK}`);
	});

	it("falls back to the historical stack when nothing was chosen", () => {
		applyTerminalFontFamily("");
		expect(stack()).toBe(DEFAULT_TERMINAL_FONT_STACK);
	});

	it("keeps the reference font in the tail so Nerd Font icons still resolve", () => {
		// UI icons pin the reference family inline, but any glyph missing from the
		// chosen font must still fall through to it rather than to a box.
		applyTerminalFontFamily("Some Font Without Icons");
		expect(stack()).toContain(REFERENCE_TERMINAL_FONT);
	});
});

describe("no bundled font is ever wider than the reference", () => {
	it("the reference font is itself unscaled", () => {
		expect(terminalFontScale(REFERENCE_TERMINAL_FONT)).toBe(1);
		expect(BUNDLED_TERMINAL_FONTS[0].family).toBe(REFERENCE_TERMINAL_FONT);
	});

	it("every bundled scale shrinks or leaves alone, never enlarges", () => {
		// Wider than the reference silently steals columns from a terminal the user
		// already sized by eye; narrower costs nothing. So the rule is one-directional.
		for (const font of BUNDLED_TERMINAL_FONTS) {
			expect(font.scale).toBeGreaterThan(0.9);
			expect(font.scale).toBeLessThanOrEqual(1);
		}
	});

	it("applies the scale to the size the renderer is actually given", () => {
		applyTerminalFontFamily("FiraCode Nerd Font Mono");
		applyTerminalFontSize(20);
		expect(effectiveTerminalFontSize()).toBeCloseTo(20 * 0.975, 5);
	});

	it("leaves a font that is already narrow at its nominal size", () => {
		applyTerminalFontFamily("Iosevka Nerd Font Mono");
		applyTerminalFontSize(16);
		expect(effectiveTerminalFontSize()).toBe(16);
	});

	it("measures a font the user typed and pulls it in when it renders wide", () => {
		// Not bundled, so there is no constant to read: the rule has to hold for a
		// locally installed font too, or "never wider" is only true for our own list.
		const ctx = {
			font: "",
			measureText: () => ({ width: ctx.font.includes("Fat Mono") ? 200 : 100 }),
		};
		vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
			tag === "canvas" ? { getContext: () => ctx } : document.body) as never);
		expect(terminalFontScale("Fat Mono")).toBeCloseTo(0.5, 5);
	});

	it("never ENLARGES a typed font that is already narrow", () => {
		// The rule is one-directional. Scaling a narrow font up to fill the reference
		// cell would be a second, unasked-for behaviour that changes what the user chose.
		const ctx = {
			font: "",
			measureText: () => ({ width: ctx.font.includes("Thin Mono") ? 50 : 100 }),
		};
		vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
			tag === "canvas" ? { getContext: () => ctx } : document.body) as never);
		expect(terminalFontScale("Thin Mono")).toBe(1);
	});

	it("never shrinks a typed font it could not measure", () => {
		vi.spyOn(document, "createElement").mockImplementation((() => ({ getContext: () => null })) as never);
		expect(terminalFontScale("Unmeasurable Mono")).toBe(1);
	});
});
