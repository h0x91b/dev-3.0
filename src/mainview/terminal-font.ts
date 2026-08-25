// ── Terminal font module ──
// The family and size the task terminals render in. Same species as zoom.ts and
// scroll-speed.ts: a per-device rendering preference, so it lives in localStorage
// and applies live through a change event — no backend RPC, and a phone reaching
// the app over remote keeps its own font, which is right because font availability
// is a property of the device.

const FAMILY_KEY = "dev3-terminal-font-family";
const SIZE_KEY = "dev3-terminal-font-size";

/** The stack every terminal has always rendered in; also the fallback tail. */
export const DEFAULT_TERMINAL_FONT_STACK = "'JetBrainsMono Nerd Font Mono', 'SF Mono', 'Menlo', monospace";
/** Empty means "the bundled font" — nothing the user typed. */
export const DEFAULT_TERMINAL_FONT_FAMILY = "";
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 32;
export const TERMINAL_FONT_CHANGED_EVENT = "terminal-font-changed" as const;

/**
 * Families offered in the picker. A curated shortlist, not a claim about what is
 * installed — the control is `allowCustom`, so anything the machine has can be typed.
 */
export const SUGGESTED_TERMINAL_FONTS: readonly string[] = [
	"JetBrainsMono Nerd Font Mono",
	"JetBrains Mono",
	"SF Mono",
	"Menlo",
	"Monaco",
	"Fira Code",
	"Cascadia Code",
	"Hack",
	"Source Code Pro",
	"IBM Plex Mono",
	"Iosevka",
	"Consolas",
	"Ubuntu Mono",
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

export function getTerminalFontFamily(): string {
	return currentFamily;
}

export function getTerminalFontSize(): number {
	return currentSize;
}

/** Wide enough that one missing glyph cannot make two fonts measure the same. */
const PROBE_TEXT = "mmmmmmmmmmlli0OW@";
const PROBE_PX = 72;
/** Three unrelated generics: a real font beats all three, a missing one beats none. */
const PROBE_BASES = ["monospace", "serif", "sans-serif"] as const;

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
	try {
		const ctx = document.createElement("canvas").getContext("2d");
		if (!ctx) return true;
		const width = (font: string) => {
			ctx.font = font;
			return ctx.measureText(PROBE_TEXT).width;
		};
		return PROBE_BASES.some(
			(base) => width(`${PROBE_PX}px ${quoteFamily(trimmed)}, ${base}`) !== width(`${PROBE_PX}px ${base}`),
		);
	} catch {
		return true;
	}
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
