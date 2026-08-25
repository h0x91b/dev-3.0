// ── Terminal font module ──
// The family and size the task terminals render in. Same species as zoom.ts and
// scroll-speed.ts: a per-device rendering preference, so it lives in localStorage
// and applies live through a change event — no backend RPC, and a phone reaching
// the app over remote keeps its own font, which is right because font availability
// is a property of the device.

const FAMILY_KEY = "dev3-terminal-font-family";
const SIZE_KEY = "dev3-terminal-font-size";

/**
 * The reference font. Every width in this module is measured against it, and no
 * other font is ever allowed to render wider — see `terminalFontScale`.
 */
export const REFERENCE_TERMINAL_FONT = "JetBrainsMono Nerd Font Mono";

/** The stack every terminal has always rendered in; also the fallback tail. */
export const DEFAULT_TERMINAL_FONT_STACK = `'${REFERENCE_TERMINAL_FONT}', 'SF Mono', 'Menlo', monospace`;
/** Empty means "the reference font" — nothing the user chose. */
export const DEFAULT_TERMINAL_FONT_FAMILY = "";
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 32;
export const TERMINAL_FONT_CHANGED_EVENT = "terminal-font-changed" as const;

export interface BundledTerminalFont {
	/** CSS family name, declared by the `@font-face` block in index.css. */
	family: string;
	/** What the font is called outside Nerd Fonts' naming scheme. */
	label: string;
	/**
	 * Size multiplier that brings this font's cell to at most the reference cell.
	 * `referenceAdvancePerEm / ownAdvancePerEm`, clamped to 1 — a font narrower
	 * than the reference is left alone, only a wider one is pulled in.
	 *
	 * Measured from the shipped woff2 files (advance width of `M` over unitsPerEm).
	 * Replacing a font file means re-measuring; the guard test in
	 * `__tests__/terminal-font.test.ts` only proves the numbers are self-consistent,
	 * not that they still match the bytes on disk.
	 */
	scale: number;
}

/**
 * The fonts shipped inside the app, in descending order of real-world popularity
 * (Homebrew cask installs, 30 days to 2026-08-25). Every one of them is a
 * `NerdFontMono` face — the fixed-advance variant — because the proportional and
 * `Propo` variants do not hold a terminal grid.
 */
export const BUNDLED_TERMINAL_FONTS: readonly BundledTerminalFont[] = [
	{ family: REFERENCE_TERMINAL_FONT, label: "JetBrains Mono", scale: 1 },
	{ family: "MesloLGS Nerd Font Mono", label: "Meslo LG S", scale: 0.9966 },
	{ family: "Hack Nerd Font Mono", label: "Hack", scale: 0.9966 },
	{ family: "FiraCode Nerd Font Mono", label: "Fira Code", scale: 0.975 },
	{ family: "BlexMono Nerd Font Mono", label: "IBM Plex Mono", scale: 1 },
	{ family: "SauceCodePro Nerd Font Mono", label: "Source Code Pro", scale: 1 },
	{ family: "0xProto Nerd Font Mono", label: "0xProto", scale: 0.9677 },
	{ family: "CaskaydiaMono Nerd Font Mono", label: "Cascadia Mono", scale: 1 },
	{ family: "DroidSansM Nerd Font Mono", label: "Droid Sans Mono", scale: 0.9998 },
	{ family: "GoMono Nerd Font Mono", label: "Go Mono", scale: 0.9998 },
	{ family: "ComicShannsMono Nerd Font Mono", label: "Comic Shanns Mono", scale: 1 },
	{ family: "CaskaydiaCove Nerd Font Mono", label: "Cascadia Code", scale: 1 },
	{ family: "Iosevka Nerd Font Mono", label: "Iosevka", scale: 1 },
	{ family: "IosevkaTerm Nerd Font Mono", label: "Iosevka Term", scale: 1 },
	{ family: "FiraMono Nerd Font Mono", label: "Fira Mono", scale: 1 },
];

let currentFamily = DEFAULT_TERMINAL_FONT_FAMILY;
let currentSize = DEFAULT_TERMINAL_FONT_SIZE;

function clampSize(size: number): number {
	if (!Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;
	return Math.round(Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, size)));
}

/** A family name is a raw CSS token, so quote it and drop anything that could end it. */
function quoteFamily(family: string): string {
	return `'${family.replace(/['"\\;{}]/g, "").trim()}'`;
}

export function bundledTerminalFont(family: string): BundledTerminalFont | undefined {
	return BUNDLED_TERMINAL_FONTS.find((font) => font.family === family);
}

/**
 * The full CSS font-family value to hand the terminal. The user's family LEADS and
 * the historical stack follows, so a family this machine does not have falls back to
 * exactly what the terminal looked like before — never to an unstyled default.
 */
export function terminalFontStack(family: string = currentFamily): string {
	const trimmed = family.trim();
	if (!trimmed) return DEFAULT_TERMINAL_FONT_STACK;
	return `${quoteFamily(trimmed)}, ${DEFAULT_TERMINAL_FONT_STACK}`;
}

/** Wide enough that one missing glyph cannot make two fonts measure the same. */
const PROBE_TEXT = "mmmmmmmmmmlli0OW@";
const PROBE_PX = 72;
/** Three unrelated generics: a real font beats all three, a missing one beats none. */
const PROBE_BASES = ["monospace", "serif", "sans-serif"] as const;

function measureWidth(font: string): number | null {
	try {
		const ctx = document.createElement("canvas").getContext("2d");
		if (!ctx) return null;
		ctx.font = font;
		return ctx.measureText(PROBE_TEXT).width;
	} catch {
		return null;
	}
}

/**
 * Whether this device can actually render `family`. False means the terminal will
 * silently fall back — the caller is expected to say so rather than let it be a
 * mystery. Unknown (no canvas) counts as available: never warn on a guess.
 *
 * `document.fonts.check()` cannot answer this. It reports whether the fonts needed
 * are LOADED, and an unknown family simply falls through to the system stack, so
 * Chromium answers `true` for a name nobody has ever installed — verified in
 * headless Chromium 2026-08-25, where it said yes to "Definitely Not Installed Mono".
 * Measuring the same string against three generics is the test that actually works:
 * if the family resolves, its own metrics win and at least one width shifts.
 */
export function isTerminalFontAvailable(family: string = currentFamily): boolean {
	const trimmed = family.trim();
	if (!trimmed) return true;
	if (bundledTerminalFont(trimmed)) return true;
	const quoted = quoteFamily(trimmed);
	return PROBE_BASES.some((base) => {
		const own = measureWidth(`${PROBE_PX}px ${quoted}, ${base}`);
		const plain = measureWidth(`${PROBE_PX}px ${base}`);
		if (own === null || plain === null) return true;
		return own !== plain;
	});
}

const customScaleCache = new Map<string, number>();

/**
 * How much to shrink `family` so one of its cells is never wider than a cell of the
 * reference font at the same nominal size. A font narrower than the reference is
 * left alone — narrower costs nothing, wider silently steals columns from every
 * terminal the user already sized by eye.
 *
 * Bundled fonts carry a measured constant. A font the user typed is measured here
 * against the reference and cached, so the rule covers locally installed fonts too;
 * when it cannot be measured the answer is 1, never a guess that shrinks text.
 */
export function terminalFontScale(family: string = currentFamily): number {
	const trimmed = family.trim();
	if (!trimmed) return 1;
	const bundled = bundledTerminalFont(trimmed);
	if (bundled) return bundled.scale;
	const cached = customScaleCache.get(trimmed);
	if (cached !== undefined) return cached;
	const own = measureWidth(`${PROBE_PX}px ${quoteFamily(trimmed)}, monospace`);
	const reference = measureWidth(`${PROBE_PX}px '${REFERENCE_TERMINAL_FONT}', monospace`);
	const scale = own && reference && own > reference ? reference / own : 1;
	customScaleCache.set(trimmed, scale);
	return scale;
}

export function getTerminalFontFamily(): string {
	return currentFamily;
}

export function getTerminalFontSize(): number {
	return currentSize;
}

/** The size the renderer actually gets: the user's number, never rendered wider. */
export function effectiveTerminalFontSize(
	family: string = currentFamily,
	size: number = currentSize,
): number {
	return size * terminalFontScale(family);
}

function emit() {
	window.dispatchEvent(
		new CustomEvent(TERMINAL_FONT_CHANGED_EVENT, {
			detail: { family: currentFamily, size: currentSize, stack: terminalFontStack() },
		}),
	);
}

export function applyTerminalFontFamily(family: string) {
	currentFamily = family.trim();
	try {
		localStorage.setItem(FAMILY_KEY, currentFamily);
	} catch {
		// localStorage unavailable — the in-memory value still applies this session.
	}
	emit();
}

export function applyTerminalFontSize(size: number) {
	currentSize = clampSize(size);
	try {
		localStorage.setItem(SIZE_KEY, String(currentSize));
	} catch {
		// localStorage unavailable — the in-memory value still applies this session.
	}
	emit();
}

/** Call once before React mounts so the first terminal is built with the saved font. */
export function bootstrapTerminalFont() {
	try {
		currentFamily = (localStorage.getItem(FAMILY_KEY) ?? DEFAULT_TERMINAL_FONT_FAMILY).trim();
	} catch {
		currentFamily = DEFAULT_TERMINAL_FONT_FAMILY;
	}
	try {
		currentSize = clampSize(parseFloat(localStorage.getItem(SIZE_KEY) ?? ""));
	} catch {
		currentSize = DEFAULT_TERMINAL_FONT_SIZE;
	}
}
