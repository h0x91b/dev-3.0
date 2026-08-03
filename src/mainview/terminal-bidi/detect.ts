import type { GhosttyCell } from "ghostty-web";

/**
 * Codepoints whose Bidi_Class can make a row's visual order differ from its
 * logical order: R, AL, AN, and every explicit directional formatting character
 * (RLE/LRE/RLO/LRO/PDF, RLI/LRI/FSI/PDI, RLM). Ordered [lo, hi] pairs.
 *
 * Derived from bidi-js's own character tables — `rtl-detection-conformance.test.ts`
 * re-derives the set over all of Unicode and fails if this table drifts.
 */
const RANGES = new Int32Array([
	0x590, 0x590,
	0x5be, 0x5be,
	0x5c0, 0x5c0,
	0x5c3, 0x5c3,
	0x5c6, 0x5c6,
	0x5c8, 0x605,
	0x608, 0x608,
	0x60b, 0x60b,
	0x60d, 0x60d,
	0x61b, 0x64a,
	0x660, 0x669,
	0x66b, 0x66f,
	0x671, 0x6d5,
	0x6dd, 0x6dd,
	0x6e5, 0x6e6,
	0x6ee, 0x6ef,
	0x6fa, 0x710,
	0x712, 0x72f,
	0x74b, 0x7a5,
	0x7b1, 0x7ea,
	0x7f4, 0x7f5,
	0x7fa, 0x7fc,
	0x7fe, 0x815,
	0x81a, 0x81a,
	0x824, 0x824,
	0x828, 0x828,
	0x82e, 0x858,
	0x85c, 0x8d2,
	0x8e2, 0x8e2,
	0x200f, 0x200f,
	0x202a, 0x202e,
	0x2066, 0x2069,
	0xfb1d, 0xfb1d,
	0xfb1f, 0xfb28,
	0xfb2a, 0xfd3d,
	0xfd40, 0xfdcf,
	0xfdf0, 0xfdfc,
	0xfdfe, 0xfdff,
	0xfe70, 0xfefe,
	0x10800, 0x1091e,
	0x10920, 0x10a00,
	0x10a04, 0x10a04,
	0x10a07, 0x10a0b,
	0x10a10, 0x10a37,
	0x10a3b, 0x10a3e,
	0x10a40, 0x10ae4,
	0x10ae7, 0x10b38,
	0x10b40, 0x10d23,
	0x10d28, 0x10eaa,
	0x10ead, 0x10f45,
	0x10f51, 0x10fff,
	0x1e800, 0x1e8cf,
	0x1e8d7, 0x1e943,
	0x1e94b, 0x1eeef,
	0x1eef2, 0x1efff,
]);

/** Lowest codepoint in RANGES — lets the common ASCII/Latin case exit on one compare. */
const FIRST = RANGES[0];
/** Highest codepoint in RANGES. */
const LAST = RANGES[RANGES.length - 1];

export function codepointNeedsBidi(codepoint: number): boolean {
	if (codepoint < FIRST || codepoint > LAST) return false;
	let lo = 0;
	let hi = RANGES.length / 2 - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (codepoint < RANGES[mid * 2]) hi = mid - 1;
		else if (codepoint > RANGES[mid * 2 + 1]) lo = mid + 1;
		else return true;
	}
	return false;
}

/**
 * The fast-path gate: a row with no bidi-relevant codepoint renders identically
 * whether or not the reorder layer is installed, so it is skipped entirely.
 */
export function rowNeedsBidi(cells: readonly GhosttyCell[]): boolean {
	for (let i = 0; i < cells.length; i++) {
		if (codepointNeedsBidi(cells[i].codepoint)) return true;
	}
	return false;
}
