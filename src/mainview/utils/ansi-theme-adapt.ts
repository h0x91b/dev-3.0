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
 * SGR `2` (dim) over the default fg is emulated as an explicit muted gray in
 * *both* modes: ghostty renders dim as 50% alpha, which on white washes any
 * color out and on dark drops the default fg to a low-contrast gray (Claude
 * Code's select-prompt descriptions/hints use Ink dimColor). Dropping dim
 * entirely instead made muted text — the input ghost/placeholder suggestion —
 * look like typed input, so dim now becomes a readable-but-secondary gray.
 * When an explicit fg color accompanies the dim, the color wins and dim is
 * dropped (preserving the colored text). The substitution is resolved at the
 * end of each SGR sequence and reset by SGR 0/22.
 *
 * The filter rewrites the stream before term.write():
 * - light mode: pale foregrounds (indexed N>=16 and truecolor) are darkened
 *   to a luminance-capped truecolor; white backgrounds (47/107, 48;5;7,
 *   48;5;15) become light gray. The light palette maps `white` to a dark gray
 *   so it stays legible as 37 *text*, but Claude Code's light-ansi theme
 *   paints message bars with "ansi:white" as a *background* and dark fg on
 *   top — a dark-on-dark bar without this remap.
 * - dark mode: too-dark foregrounds are brightened by blending toward white.
 *   White backgrounds become dark
 *   gray: Claude Code paints message bars and the history-select highlight
 *   with "ansi:white"/"ansi:whiteBright", which the dark palette resolves to
 *   pale lavender — default-fg text on it is unreadable. The remap targets
 *   Claude Code's own dark theme bar colors (55/70), and explicit dark ANSI
 *   foregrounds (30/90) on those bars are flipped to light grays so
 *   dark-text-on-white bars stay legible as light-text-on-dark bars. Diff
 *   backgrounds emitted for the opposite terminal polarity are remapped in
 *   both directions. This covers Codex's GitHub-light palette and Claude
 *   Code's regular and colorblind-friendly /theme previews; the remapped
 *   backgrounds then use the normal contrast path for their foregrounds.
 * Foreground adjustment is gated by the *luminance* of the active explicit
 * background: a fg chosen for an opposite-polarity bg (vim themes, highlight
 * bars) passes through untouched, but a bad-contrast fg on a same-polarity
 * bg is still fixed — Codex paints its whole UI on an explicit dark truecolor
 * bg (48;2;30;30;46) and writes pure-black text on top of it. Named ANSI
 * backgrounds (40-46, 100-106) resolve theme-side, so their luminance is
 * unknown and they gate fg adjustment off entirely, as does reverse video
 * (SGR 7). White backgrounds are exempt: after remapping they sit close to
 * the theme background, so the normal fg adjustment stays correct.
 *
 * Apps emit fg *before* bg (Claude Code's status-line branch pill:
 * 38;5;16 black, then 48;5;37 teal), so a fg can get adjusted before the
 * gating bg is known — gray-on-teal instead of black-on-teal. The original
 * params of an adjusted fg are therefore kept until text is drawn; if a bg
 * that gates fg adjustment opens first, the original fg is re-emitted.
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
// Near-black colors lose chroma when brightened (gray on dark reads worse
// than a color of equal luminance), so the target ramps up as the input
// approaches pure black: lum 0 → target 0.60 (#999 gray), lum at
// threshold → 0.38.
const DARK_NEAR_BLACK_BOOST = 0.22;

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
	const target =
		DARK_LUMINANCE_TARGET + DARK_NEAR_BLACK_BOOST * (1 - lum / DARK_LUMINANCE_THRESHOLD);
	// Blend toward white: works for pure black too (no division by lum).
	const t = (target - lum) / (1 - lum);
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
	oppositeDiffBg = false,
): [number, number, number] | null {
	if (oppositeDiffBg) {
		const lum = luminance(r, g, b);
		if (mode === "light") {
			if (lum <= 0.3) return null;
			const factor = 0.3 / lum;
			return [Math.round(r * factor), Math.round(g * factor), Math.round(b * factor)];
		}
		if (lum >= 0.68) return null;
		const blend = (0.68 - lum) / (1 - lum);
		return [
			Math.round(r + blend * (255 - r)),
			Math.round(g + blend * (255 - g)),
			Math.round(b + blend * (255 - b)),
		];
	}
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

// Replacement backgrounds for "white" bars (matches Claude Code's own
// non-ansi theme bar colors: light rgb(220,220,220)/rgb(240,240,240),
// dark rgb(55,55,55)/rgb(70,70,70)).
const LIGHT_WHITE_BG = ["48", "2", "220", "220", "220"];
const LIGHT_BRIGHT_WHITE_BG = ["48", "2", "240", "240", "240"];
const DARK_WHITE_BG = ["48", "2", "55", "55", "55"];
const DARK_BRIGHT_WHITE_BG = ["48", "2", "70", "70", "70"];
// Light replacements for dark ANSI fg (30/90) on a dark-remapped white bar
const DARK_BAR_FG_30 = ["38", "2", "220", "220", "220"];
const DARK_BAR_FG_90 = ["38", "2", "160", "160", "160"];

// Claude Code's /theme preview and live diff rows use fixed truecolor
// backgrounds. A user may deliberately choose a light Claude theme inside a
// dark dev3 terminal (or the reverse), so adapt the known diff colors without
// changing unrelated app-owned highlights. The two shades in each family are
// the row background and the stronger changed-word highlight.
type Rgb = readonly [number, number, number];
type DiffBgPair = readonly [source: Rgb, target: Rgb];

const LIGHT_DIFF_TO_DARK: readonly DiffBgPair[] = [
	// Removal — Codex GitHub-light, then Claude regular/colorblind.
	[[255, 221, 221], [63, 37, 42]],
	[[255, 220, 220], [63, 37, 42]],
	[[255, 199, 199], [92, 45, 52]],
	// Addition — Codex GitHub-light and Claude regular.
	[[221, 255, 221], [36, 61, 46]],
	[[220, 255, 220], [36, 61, 46]],
	[[178, 255, 178], [34, 82, 49]],
	// Addition — Claude colorblind-friendly.
	[[219, 237, 255], [35, 54, 78]],
	[[179, 217, 255], [35, 73, 108]],
];

const DARK_DIFF_TO_LIGHT: readonly DiffBgPair[] = [
	// Removal — Claude regular/colorblind.
	[[61, 1, 0], [255, 220, 220]],
	[[92, 2, 0], [255, 199, 199]],
	// Addition — Claude regular.
	[[2, 40, 0], [220, 255, 220]],
	[[4, 71, 0], [178, 255, 178]],
	// Addition — Claude colorblind-friendly.
	[[0, 27, 41], [219, 237, 255]],
	[[0, 48, 71], [179, 217, 255]],
];

function oppositeThemeDiffBgReplacement(
	r: number,
	g: number,
	b: number,
	mode: ThemeMode,
): string[] | null {
	const pairs = mode === "dark" ? LIGHT_DIFF_TO_DARK : DARK_DIFF_TO_LIGHT;
	for (const [source, target] of pairs) {
		if (r === source[0] && g === source[1] && b === source[2]) {
			return ["48", "2", String(target[0]), String(target[1]), String(target[2])];
		}
	}
	return null;
}

// Emulated dim foreground. ghostty renders SGR dim as 50% alpha, which is too
// faint to read on dark and washes out on white; full intensity (dropping dim)
// makes muted text — placeholder/ghost suggestions, select-prompt descriptions
// and hints — look like typed input. We substitute an explicit muted gray:
// readable, yet clearly dimmer than the default fg. Dark is a Tokyo-Night-ish
// slate (lum ~0.47), light a neutral mid gray.
const DARK_DIM_FG = ["38", "2", "112", "120", "150"];
const LIGHT_DIM_FG = ["38", "2", "130", "130", "130"];

function dimFgReplacement(mode: ThemeMode): string[] {
	return mode === "light" ? LIGHT_DIM_FG : DARK_DIM_FG;
}

function whiteBgReplacement(bright: boolean, mode: ThemeMode): string[] {
	if (mode === "light") return bright ? LIGHT_BRIGHT_WHITE_BG : LIGHT_WHITE_BG;
	return bright ? DARK_BRIGHT_WHITE_BG : DARK_WHITE_BG;
}

// Explicit backgrounds below this luminance count as "dark" (fg brightening
// stays on in dark mode), above BG_LIGHT_MIN as "light" (fg darkening stays
// on in light mode); mid-tones and named ANSI bgs gate fg adjustment off.
const BG_DARK_MAX_LUMINANCE = 0.35;
const BG_LIGHT_MIN_LUMINANCE = 0.55;

type BgClass = "none" | "white" | "dark" | "light" | "unknown";

function classifyBgRgb(r: number, g: number, b: number): BgClass {
	const lum = luminance(r, g, b);
	if (lum < BG_DARK_MAX_LUMINANCE) return "dark";
	if (lum > BG_LIGHT_MIN_LUMINANCE) return "light";
	return "unknown";
}

interface GateState {
	// "white" = a remapped white bar (fg adjustment stays on); "dark"/"light" =
	// explicit bg of known luminance (fg adjustment stays on only for the
	// matching mode); "unknown" = named ANSI or mid-tone bg (gated off)
	bg: BgClass;
	// True only while a known Claude/Codex diff background has been remapped
	// from the opposite terminal polarity. Foregrounds on these rows need a
	// stronger contrast target than ordinary terminal ink.
	oppositeDiffBgActive: boolean;
	reverseActive: boolean;
	// Last explicit dark ANSI fg (30/90) — needed when a white bar opens
	// *after* the fg was set (Claude emits fg first, then bg)
	darkFg: "30" | "90" | null;
	// Original params of the last *adjusted* extended fg, with no text drawn
	// since. Apps emit fg before bg (Claude's status-line branch pill:
	// 38;5;16 then 48;5;37), so the fg gets adjusted before the gating bg is
	// known — when such a bg opens, the original fg is re-emitted to undo it.
	pendingFg: string[] | null;
	// SGR dim seen in the current sequence, not yet resolved: flushed as an
	// emulated muted-gray fg at sequence end iff no explicit fg overrides it.
	dimPending: boolean;
	// An emulated dim gray is the active fg, so SGR 22 (dim off) must reset it.
	dimActive: boolean;
	// An explicit fg color (not the default, not our emulated gray) is active —
	// dim is then dropped (the color shows full), matching prior behavior.
	fgExplicit: boolean;
}

/**
 * Rewrites a single SGR parameter string for the given mode, updating the
 * cross-sequence gate state as it walks the tokens. Returns the new parameter
 * string, or null if the whole sequence should be dropped (every parameter
 * was removed).
 */
function transformSgrParams(raw: string, mode: ThemeMode, gate: GateState): string | null {
	if (raw === "") {
		gate.bg = "none";
		gate.oppositeDiffBgActive = false;
		gate.reverseActive = false;
		gate.darkFg = null;
		gate.pendingFg = null;
		gate.dimPending = false;
		gate.dimActive = false;
		gate.fgExplicit = false;
		return raw;
	}
	// Normalize colon sub-parameter form (38:5:226) to semicolons so the
	// token walk below handles both encodings uniformly.
	const tokens = raw.replaceAll(":", ";").split(";");
	const out: string[] = [];
	// In dark mode a white bar becomes dark gray; if a dark ANSI fg (set now
	// or earlier) sits on it, append/replace it with a light gray.
	const pushWhiteBg = (bright: boolean) => {
		gate.bg = "white";
		gate.oppositeDiffBgActive = false;
		out.push(...whiteBgReplacement(bright, mode));
		if (mode === "dark" && gate.darkFg !== null) {
			out.push(...(gate.darkFg === "30" ? DARK_BAR_FG_30 : DARK_BAR_FG_90));
		}
	};
	const fgAdjustable = () =>
		!gate.reverseActive &&
		(gate.bg === "none" ||
			gate.bg === "white" ||
			gate.bg === (mode === "dark" ? "dark" : "light"));
	// A bg (or reverse video) just opened that gates fg adjustment off, with
	// no text drawn since the fg was adjusted — re-emit the original fg.
	const restorePendingFg = () => {
		if (gate.pendingFg !== null && !fgAdjustable()) {
			out.push(...gate.pendingFg);
			gate.pendingFg = null;
		}
	};
	// The fg often arrives before the bg. It was therefore adjusted using the
	// ordinary terminal target; once we recognize a remapped diff row, emit the
	// same source color again using the stronger diff contrast target.
	const upgradePendingFgForDiff = () => {
		const pending = gate.pendingFg;
		if (pending === null) return;
		let rgb: [number, number, number] | null = null;
		if (pending[0] === "38" && pending[1] === "2" && pending.length >= 5) {
			rgb = [Number(pending[2]), Number(pending[3]), Number(pending[4])];
		} else if (pending[0] === "38" && pending[1] === "5" && pending[2] !== undefined) {
			const index = Number(pending[2]);
			if (index >= 16 && index <= 255) rgb = color256ToRgb(index);
		}
		if (rgb !== null) {
			const adjusted = adjustFgRgb(rgb[0], rgb[1], rgb[2], mode, true);
			if (adjusted !== null) {
				out.push("38", "2", String(adjusted[0]), String(adjusted[1]), String(adjusted[2]));
			}
		}
		gate.pendingFg = null;
	};
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token === "" || token === "0") {
			gate.bg = "none";
			gate.oppositeDiffBgActive = false;
			gate.reverseActive = false;
			gate.darkFg = null;
			gate.pendingFg = null;
			gate.dimPending = false;
			gate.dimActive = false;
			gate.fgExplicit = false;
			out.push(token);
			i++;
			continue;
		}
		if (token === "7") {
			gate.reverseActive = true;
			out.push(token);
			restorePendingFg();
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
			gate.bg = "none";
			gate.oppositeDiffBgActive = false;
			out.push(token);
			i++;
			continue;
		}
		if (token === "2") {
			// SGR dim — resolved at sequence end (flushed as an emulated muted
			// gray unless an explicit fg overrides it). Don't emit the dim token.
			gate.dimPending = true;
			i++;
			continue;
		}
		if (token === "22") {
			// Dim off. If we emulated dim with a gray fg, also reset the fg.
			gate.dimPending = false;
			out.push(token);
			if (gate.dimActive) {
				out.push("39");
				gate.dimActive = false;
				gate.fgExplicit = false;
			}
			i++;
			continue;
		}
		if (token === "30" || token === "90") {
			gate.darkFg = token;
			gate.pendingFg = null;
			gate.dimPending = false;
			gate.dimActive = false;
			gate.fgExplicit = true;
			if (mode === "dark" && gate.bg === "white" && !gate.reverseActive) {
				out.push(...(token === "30" ? DARK_BAR_FG_30 : DARK_BAR_FG_90));
				i++;
				continue;
			}
			out.push(token);
			i++;
			continue;
		}
		const code = Number(token);
		if ((code >= 31 && code <= 39) || (code >= 91 && code <= 97)) {
			// Any other explicit fg (incl. 39 default) clears the dark-fg track;
			// 38-extended is handled below.
			if (token !== "38") {
				gate.darkFg = null;
				gate.pendingFg = null;
				gate.dimPending = false;
				gate.dimActive = false;
				// 39 restores the default fg (not an explicit color); 31-37/91-97
				// are explicit colors that take over and drop dim.
				gate.fgExplicit = token !== "39";
			}
		}
		if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
			if (code === 47 || code === 107) {
				pushWhiteBg(code === 107);
				i++;
				continue;
			}
			gate.bg = "unknown";
			gate.oppositeDiffBgActive = false;
			out.push(token);
			restorePendingFg();
			i++;
			continue;
		}
		if (token === "38" || token === "48" || token === "58") {
			const introducer = tokens[i + 1];
			if (introducer === "5" && tokens[i + 2] !== undefined) {
				const index = Number(tokens[i + 2]);
				if (token === "48") {
					if (index === 7 || index === 15) {
						pushWhiteBg(index === 15);
						i += 3;
						continue;
					}
					if (index >= 16 && index <= 255) {
						const [r, g, b] = color256ToRgb(index);
						gate.bg = classifyBgRgb(r, g, b);
					} else {
						gate.bg = "unknown";
					}
					gate.oppositeDiffBgActive = false;
					out.push(token, tokens[i + 1], tokens[i + 2]);
					restorePendingFg();
					i += 3;
					continue;
				}
				if (token === "38") {
					gate.darkFg = null;
					gate.pendingFg = null;
					gate.dimPending = false;
					gate.dimActive = false;
					gate.fgExplicit = true;
					if (index >= 16 && index <= 255 && fgAdjustable()) {
						const [r, g, b] = color256ToRgb(index);
						const adjusted = adjustFgRgb(r, g, b, mode, gate.oppositeDiffBgActive);
						if (adjusted) {
							gate.pendingFg = ["38", "5", tokens[i + 2]];
							out.push("38", "2", String(adjusted[0]), String(adjusted[1]), String(adjusted[2]));
							i += 3;
							continue;
						}
					}
				}
				out.push(token, tokens[i + 1], tokens[i + 2]);
				i += 3;
				continue;
			}
			if (introducer === "2" && tokens[i + 4] !== undefined) {
				if (token === "48") {
					const r = Number(tokens[i + 2]);
					const g = Number(tokens[i + 3]);
					const b = Number(tokens[i + 4]);
					const diffBg = oppositeThemeDiffBgReplacement(r, g, b, mode);
					if (diffBg !== null) {
						gate.bg = mode === "dark" ? "dark" : "light";
						gate.oppositeDiffBgActive = true;
						out.push(...diffBg);
						upgradePendingFgForDiff();
					} else {
						gate.bg = classifyBgRgb(r, g, b);
						gate.oppositeDiffBgActive = false;
						out.push(token, tokens[i + 1], tokens[i + 2], tokens[i + 3], tokens[i + 4]);
					}
					restorePendingFg();
					i += 5;
					continue;
				}
				if (token === "38") {
					gate.darkFg = null;
					gate.pendingFg = null;
					gate.dimPending = false;
					gate.dimActive = false;
					gate.fgExplicit = true;
					if (fgAdjustable()) {
						const r = Number(tokens[i + 2]);
						const g = Number(tokens[i + 3]);
						const b = Number(tokens[i + 4]);
						const adjusted = adjustFgRgb(r, g, b, mode, gate.oppositeDiffBgActive);
						if (adjusted) {
							gate.pendingFg = ["38", "2", tokens[i + 2], tokens[i + 3], tokens[i + 4]];
							out.push("38", "2", String(adjusted[0]), String(adjusted[1]), String(adjusted[2]));
							i += 5;
							continue;
						}
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
	// Resolve a dim seen in this sequence: if no explicit fg overrode it, the
	// dimmed text is over the default fg — emit an emulated muted gray so it
	// stays readable yet visibly secondary (placeholder/ghost text, hints).
	if (gate.dimPending) {
		gate.dimPending = false;
		if (!gate.fgExplicit) {
			out.push(...dimFgReplacement(mode));
			gate.dimActive = true;
		}
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
	const gate: GateState = {
		bg: "none",
		oppositeDiffBgActive: false,
		reverseActive: false,
		darkFg: null,
		pendingFg: null,
		dimPending: false,
		dimActive: false,
		fgExplicit: false,
	};
	return (chunk, mode) => {
		let data = carry + chunk;
		carry = "";
		const match = INCOMPLETE_CSI_RE.exec(data);
		if (match && data.length - match.index <= MAX_CARRY) {
			carry = data.slice(match.index);
			data = data.slice(0, match.index);
		}
		if (!data) return data;
		// Anything between SGR sequences (text, other escapes) means the
		// adjusted fg was already used for output — drop the restore candidate.
		let cursor = 0;
		const result = data.replace(SGR_RE, (full, params: string, offset: number) => {
			if (offset > cursor) gate.pendingFg = null;
			cursor = offset + full.length;
			const next = transformSgrParams(params, mode, gate);
			if (next === null) return "";
			if (next === params) return full;
			return `\x1b[${next}m`;
		});
		if (cursor < data.length) gate.pendingFg = null;
		return result;
	};
}
