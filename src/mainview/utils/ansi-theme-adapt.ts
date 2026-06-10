/**
 * Theme readability filter for the terminal PTY stream.
 *
 * Terminal apps emit colors tuned for the *opposite* background:
 * - Claude Code (tuned for dark): pale 256-color indexes (38;5;226 yellow,
 *   38;5;183 plum, …) and SGR dim — unreadable on a white background.
 * - Codex (tuned for light): GitHub-light syntax truecolors (#333333,
 *   #183691, …) — unreadable on a dark background.
 * ghostty-web resolves 256-color indexes inside WASM — the 16-color theme
 * palette cannot remap them — and renders dim as globalAlpha 0.5, which on a
 * white background washes any color into unreadable gray.
 *
 * The filter rewrites the stream before term.write():
 * - light mode: standalone SGR `2` (dim) is dropped; pale foregrounds
 *   (indexed N>=16 and truecolor) are darkened to a luminance-capped
 *   truecolor; white backgrounds (47/107, 48;5;7, 48;5;15) become light
 *   gray. The light palette maps `white` to a dark gray so it stays legible
 *   as 37 *text*, but Claude Code's light-ansi theme paints message bars
 *   with "ansi:white" as a *background* and dark fg on top — a dark-on-dark
 *   bar without this remap.
 * - dark mode: too-dark foregrounds are brightened by blending toward white.
 *   Dim is kept (fine on dark backgrounds).
 * Foreground adjustment is gated: while an explicit background (40-47,
 * 100-107, 48;…) or reverse video (SGR 7) is active, foregrounds pass
 * through untouched — the app picked that fg *for that bg* (vim themes,
 * highlight bars), so "fixing" it would break intentional contrast.
 */

export type ThemeMode = "light" | "dark";

// Light mode: darken if relative luminance exceeds this (pale on white)
const LIGHT_LUMINANCE_THRESHOLD = 0.55;
// Scale pale colors down to roughly this luminance
const LIGHT_LUMINANCE_TARGET = 0.42;
// Dark mode: brighten if relative luminance is below this (ink on dark)
const DARK_LUMINANCE_THRESHOLD = 0.25;
// Blend dark colors toward white up to roughly this luminance
const DARK_LUMINANCE_TARGET = 0.38;

function luminance(r: number, g: number, b: number): number {
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Returns a darkened [r, g, b] if the color is too pale for a light background, else null. */
export function darkenPaleRgb(r: number, g: number, b: number): [number, number, number] | null {
	const lum = luminance(r, g, b);
	if (lum <= LIGHT_LUMINANCE_THRESHOLD) return null;
	const factor = LIGHT_LUMINANCE_TARGET / lum;
	return [Math.round(r * factor), Math.round(g * factor), Math.round(b * factor)];
}

/** Returns a brightened [r, g, b] if the color is too dark for a dark background, else null. */
export function brightenDarkRgb(r: number, g: number, b: number): [number, number, number] | null {
	const lum = luminance(r, g, b);
	if (lum >= DARK_LUMINANCE_THRESHOLD) return null;
	// Blend toward white: works for pure black too (no division by lum).
	const t = (DARK_LUMINANCE_TARGET - lum) / (1 - lum);
	return [
		Math.round(r + t * (255 - r)),
		Math.round(g + t * (255 - g)),
		Math.round(b + t * (255 - b)),
	];
}

function adjustFgRgb(
	r: number,
	g: number,
	b: number,
	mode: ThemeMode,
): [number, number, number] | null {
	return mode === "light" ? darkenPaleRgb(r, g, b) : brightenDarkRgb(r, g, b);
}

/** xterm 256-color index → [r, g, b] (only meaningful for N >= 16). */
function color256ToRgb(n: number): [number, number, number] {
	if (n < 232) {
		const idx = n - 16;
		const channel = (v: number) => (v === 0 ? 0 : 55 + v * 40);
		return [
			channel(Math.floor(idx / 36)),
			channel(Math.floor((idx % 36) / 6)),
			channel(idx % 6),
		];
	}
	const level = 8 + (n - 232) * 10;
	return [level, level, level];
}

// Replacement backgrounds for "white" bars in light mode (matches Claude
// Code's own non-ansi light theme bar colors: rgb(220,220,220) / rgb(240,240,240)).
const WHITE_BG = ["48", "2", "220", "220", "220"];
const BRIGHT_WHITE_BG = ["48", "2", "240", "240", "240"];

interface GateState {
	bgActive: boolean;
	reverseActive: boolean;
}

/**
 * Rewrites a single SGR parameter string for the given mode, updating the
 * cross-sequence gate state as it walks the tokens. Returns the new parameter
 * string, or null if the whole sequence should be dropped (every parameter
 * was removed).
 */
function transformSgrParams(raw: string, mode: ThemeMode, gate: GateState): string | null {
	if (raw === "") {
		gate.bgActive = false;
		gate.reverseActive = false;
		return raw;
	}
	// Normalize colon sub-parameter form (38:5:226) to semicolons so the
	// token walk below handles both encodings uniformly.
	const tokens = raw.replaceAll(":", ";").split(";");
	const out: string[] = [];
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token === "" || token === "0") {
			gate.bgActive = false;
			gate.reverseActive = false;
			out.push(token);
			i++;
			continue;
		}
		if (token === "7") {
			gate.reverseActive = true;
			out.push(token);
			i++;
			continue;
		}
		if (token === "27") {
			gate.reverseActive = false;
			out.push(token);
			i++;
			continue;
		}
		if (token === "49") {
			gate.bgActive = false;
			out.push(token);
			i++;
			continue;
		}
		if (token === "2") {
			// SGR dim — ghostty renders it as 50% alpha, unreadable on white.
			// On dark backgrounds dim is fine, keep it.
			if (mode === "light") {
				i++;
				continue;
			}
			out.push(token);
			i++;
			continue;
		}
		const code = Number(token);
		if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
			gate.bgActive = true;
			if (mode === "light" && code === 47) {
				out.push(...WHITE_BG);
				i++;
				continue;
			}
			if (mode === "light" && code === 107) {
				out.push(...BRIGHT_WHITE_BG);
				i++;
				continue;
			}
			out.push(token);
			i++;
			continue;
		}
		if (token === "38" || token === "48" || token === "58") {
			const introducer = tokens[i + 1];
			if (introducer === "5" && tokens[i + 2] !== undefined) {
				const index = Number(tokens[i + 2]);
				if (token === "48") {
					gate.bgActive = true;
					if (mode === "light" && (index === 7 || index === 15)) {
						out.push(...(index === 7 ? WHITE_BG : BRIGHT_WHITE_BG));
						i += 3;
						continue;
					}
				}
				if (
					token === "38" &&
					index >= 16 &&
					index <= 255 &&
					!gate.bgActive &&
					!gate.reverseActive
				) {
					const [r, g, b] = color256ToRgb(index);
					const adjusted = adjustFgRgb(r, g, b, mode);
					if (adjusted) {
						out.push("38", "2", String(adjusted[0]), String(adjusted[1]), String(adjusted[2]));
						i += 3;
						continue;
					}
				}
				out.push(token, tokens[i + 1], tokens[i + 2]);
				i += 3;
				continue;
			}
			if (introducer === "2" && tokens[i + 4] !== undefined) {
				if (token === "48") gate.bgActive = true;
				if (token === "38" && !gate.bgActive && !gate.reverseActive) {
					const r = Number(tokens[i + 2]);
					const g = Number(tokens[i + 3]);
					const b = Number(tokens[i + 4]);
					const adjusted = adjustFgRgb(r, g, b, mode);
					if (adjusted) {
						out.push("38", "2", String(adjusted[0]), String(adjusted[1]), String(adjusted[2]));
						i += 5;
						continue;
					}
				}
				out.push(token, tokens[i + 1], tokens[i + 2], tokens[i + 3], tokens[i + 4]);
				i += 5;
				continue;
			}
		}
		out.push(token);
		i++;
	}
	if (out.length === 0) return null;
	return out.join(";");
}

const SGR_RE = /\x1b\[([0-9;:]*)m/g;
// A trailing ESC, or ESC[ followed only by parameter bytes (no final byte yet)
const INCOMPLETE_CSI_RE = /\x1b(?:\[[0-9;:]*)?$/;
const MAX_CARRY = 64;

/**
 * Creates a stateful chunk filter. Escape sequences split across chunk
 * boundaries are carried over to the next call, and the bg/reverse gate
 * state persists across chunks, so rewriting never misses a fragmented
 * SGR sequence or mis-gates a foreground set in a later chunk.
 */
export function createAnsiThemeFilter(): (chunk: string, mode: ThemeMode) => string {
	let carry = "";
	const gate: GateState = { bgActive: false, reverseActive: false };
	return (chunk, mode) => {
		let data = carry + chunk;
		carry = "";
		const match = INCOMPLETE_CSI_RE.exec(data);
		if (match && data.length - match.index <= MAX_CARRY) {
			carry = data.slice(match.index);
			data = data.slice(0, match.index);
		}
		if (!data) return data;
		return data.replace(SGR_RE, (full, params: string) => {
			const next = transformSgrParams(params, mode, gate);
			if (next === null) return "";
			if (next === params) return full;
			return `\x1b[${next}m`;
		});
	};
}
