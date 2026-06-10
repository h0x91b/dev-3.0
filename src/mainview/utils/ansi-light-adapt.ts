/**
 * Light-theme readability filter for the terminal PTY stream.
 *
 * Terminal apps (notably Claude Code) emit colors tuned for dark backgrounds:
 * pale 256-color indexes (38;5;226 yellow, 38;5;183 plum, …) and SGR dim.
 * ghostty-web resolves 256-color indexes inside WASM — the 16-color theme
 * palette cannot remap them — and renders dim as globalAlpha 0.5, which on a
 * white background washes any color into unreadable gray.
 *
 * In light mode this filter rewrites the stream before term.write():
 * - standalone SGR `2` (dim) is dropped
 * - pale indexed (38;5;N, N>=16) and truecolor (38;2;R;G;B) foregrounds are
 *   darkened to a luminance-capped truecolor equivalent
 * Backgrounds and theme-mapped indexes (0-15) are left untouched.
 */

// Darken if relative luminance exceeds this (pale on white = unreadable)
const LUMINANCE_THRESHOLD = 0.55;
// Scale pale colors down to roughly this luminance
const LUMINANCE_TARGET = 0.42;

function luminance(r: number, g: number, b: number): number {
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Returns a darkened [r, g, b] if the color is too pale for a light background, else null. */
export function darkenPaleRgb(r: number, g: number, b: number): [number, number, number] | null {
	const lum = luminance(r, g, b);
	if (lum <= LUMINANCE_THRESHOLD) return null;
	const factor = LUMINANCE_TARGET / lum;
	return [Math.round(r * factor), Math.round(g * factor), Math.round(b * factor)];
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

/**
 * Rewrites a single SGR parameter string for light mode.
 * Returns the new parameter string, or null if the whole sequence
 * should be dropped (every parameter was removed).
 */
function transformSgrParams(raw: string): string | null {
	if (raw === "") return raw;
	// Normalize colon sub-parameter form (38:5:226) to semicolons so the
	// token walk below handles both encodings uniformly.
	const tokens = raw.replaceAll(":", ";").split(";");
	const out: string[] = [];
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token === "2") {
			// SGR dim — ghostty renders it as 50% alpha, unreadable on white
			i++;
			continue;
		}
		if (token === "38" || token === "48" || token === "58") {
			const mode = tokens[i + 1];
			if (mode === "5" && tokens[i + 2] !== undefined) {
				const index = Number(tokens[i + 2]);
				if (token === "38" && index >= 16 && index <= 255) {
					const [r, g, b] = color256ToRgb(index);
					const darker = darkenPaleRgb(r, g, b);
					if (darker) {
						out.push("38", "2", String(darker[0]), String(darker[1]), String(darker[2]));
						i += 3;
						continue;
					}
				}
				out.push(token, tokens[i + 1], tokens[i + 2]);
				i += 3;
				continue;
			}
			if (mode === "2" && tokens[i + 4] !== undefined) {
				if (token === "38") {
					const r = Number(tokens[i + 2]);
					const g = Number(tokens[i + 3]);
					const b = Number(tokens[i + 4]);
					const darker = darkenPaleRgb(r, g, b);
					if (darker) {
						out.push("38", "2", String(darker[0]), String(darker[1]), String(darker[2]));
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
 * boundaries are carried over to the next call so rewriting never misses
 * a fragmented SGR sequence. When `light` is false the chunk passes
 * through unmodified (carry management still applies).
 */
export function createAnsiLightFilter(): (chunk: string, light: boolean) => string {
	let carry = "";
	return (chunk, light) => {
		let data = carry + chunk;
		carry = "";
		const match = INCOMPLETE_CSI_RE.exec(data);
		if (match && data.length - match.index <= MAX_CARRY) {
			carry = data.slice(match.index);
			data = data.slice(0, match.index);
		}
		if (!light || !data) return data;
		return data.replace(SGR_RE, (full, params: string) => {
			const next = transformSgrParams(params);
			if (next === null) return "";
			if (next === params) return full;
			return `\x1b[${next}m`;
		});
	};
}
