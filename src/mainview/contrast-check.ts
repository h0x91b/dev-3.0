/**
 * Contrast measurement utilities for the dev-3.0 design token test.
 *
 * Implements:
 *   • APCA W3 0.1.9 — the authoritative algorithm for the `Lc` values cited in
 *     DESIGN.md. Returns a signed value in the range ~−108 … +106; negative =
 *     light ink on dark surface (WoB), positive = dark ink on light surface (BoW).
 *   • WCAG 2.x relative luminance + contrast ratio — retained for WCAG 1.4.3
 *     / 1.4.11 references in the codebase.
 *   • src-over alpha compositing — required to measure contrast on the real
 *     glass-card reading surface rather than against an opaque fallback.
 *
 * No external dependencies; runs in Vitest / happy-dom.
 */

/** sRGB triplet [0..255, 0..255, 0..255] */
export type RGB = [number, number, number];

// ─── APCA W3 0.1.9 constants ────────────────────────────────────────────────

const SA98G = {
	mainTRC: 2.4,
	sRco: 0.2126729,
	sGco: 0.7151522,
	sBco: 0.0721750,
	normBG: 0.56,
	normTXT: 0.57,
	revTXT: 0.62,
	revBG: 0.65,
	blkThrs: 0.022,
	blkClmp: 1.414,
	scaleBoW: 1.14,
	scaleWoB: 1.14,
	loBoWoffset: 0.027,
	loWoBoffset: 0.027,
	deltaYmin: 0.0005,
	loClip: 0.1,
} as const;

/** Linearise one sRGB channel (0–255 → linear light 0–1) */
function linearise(channel: number): number {
	const v = channel / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** SA98G.mainTRC;
}

/** APCA perceived luminance Y (0–1) from an sRGB triplet */
export function apcaLuminance(rgb: RGB): number {
	return SA98G.sRco * linearise(rgb[0])
		+ SA98G.sGco * linearise(rgb[1])
		+ SA98G.sBco * linearise(rgb[2]);
}

/**
 * APCA W3 0.1.9 contrast — returns signed Lc value.
 *
 * • Negative → light text on dark background (WoB / "night-mode").
 * • Positive → dark text on light background (BoW / "day-mode").
 * • |Lc| 75 → body text floor, |Lc| 60 → non-body text, |Lc| 15 → non-text.
 *
 * @param text  foreground colour (the ink)
 * @param bg    background colour (the surface)
 */
export function apcaContrast(text: RGB, bg: RGB): number {
	let Ytxt = apcaLuminance(text);
	let Ybg  = apcaLuminance(bg);

	// Black soft-clamp — prevents tiny near-black values from dominating
	if (Ytxt < SA98G.blkThrs) Ytxt += (SA98G.blkThrs - Ytxt) ** SA98G.blkClmp;
	if (Ybg  < SA98G.blkThrs) Ybg  += (SA98G.blkThrs - Ybg)  ** SA98G.blkClmp;

	if (Math.abs(Ybg - Ytxt) < SA98G.deltaYmin) return 0;

	let Sapc: number;
	if (Ybg > Ytxt) {
		// Dark text on light background (BoW)
		Sapc = (Ybg ** SA98G.normBG - Ytxt ** SA98G.normTXT) * SA98G.scaleBoW;
		if (Sapc < SA98G.loClip) return 0;
		return (Sapc - SA98G.loBoWoffset) * 100;
	} else {
		// Light text on dark background (WoB)
		Sapc = (Ybg ** SA98G.revBG - Ytxt ** SA98G.revTXT) * SA98G.scaleWoB;
		if (Sapc > -SA98G.loClip) return 0;
		return (Sapc + SA98G.loWoBoffset) * 100;
	}
}

// ─── WCAG 2.x ────────────────────────────────────────────────────────────────

/** WCAG 2.x relative luminance (IEC 61966-2-1 piecewise) */
export function wcagLuminance(rgb: RGB): number {
	function chan(c: number) {
		const v = c / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	}
	return 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2]);
}

/** WCAG 2.x contrast ratio (always ≥ 1) */
export function wcagRatio(c1: RGB, c2: RGB): number {
	const L1 = wcagLuminance(c1);
	const L2 = wcagLuminance(c2);
	const lighter = Math.max(L1, L2);
	const darker  = Math.min(L1, L2);
	return (lighter + 0.05) / (darker + 0.05);
}

// ─── Alpha compositing ───────────────────────────────────────────────────────

/**
 * src-over alpha composite: place `fg` (with `alpha` 0–1) over opaque `bg`.
 * Returns the resulting opaque sRGB colour.
 */
export function compositeOver(fg: RGB, alpha: number, bg: RGB): RGB {
	return [
		Math.round(alpha * fg[0] + (1 - alpha) * bg[0]),
		Math.round(alpha * fg[1] + (1 - alpha) * bg[1]),
		Math.round(alpha * fg[2] + (1 - alpha) * bg[2]),
	];
}

// ─── Kanban glass-card surface (worst-case reading surface) ──────────────────

/**
 * Compute the opaque effective background colour of a kanban card in the
 * given theme.  The stack is:
 *
 *   Dark:  gradient-from (#060916)
 *          → glass-column (12 16 23 / 0.7)
 *          → glass-card   (255 255 255 / 0.04)   ← text sits here
 *
 *   Light: gradient-from (#d3dfef)
 *          → glass-column (255 255 255 / 0.49)
 *          → glass-card   (255 255 255 / 0.66)   ← text sits here
 *
 * No status-colour glow is included; glow shifts the surface toward the
 * column's accent hue but its contribution to luminance is second-order
 * and status-specific — omitting it gives the test a stable, conservative
 * baseline.  Tests that need to check a specific glow should call
 * compositeOver() directly.
 */
export function glassCardSurface(theme: "dark" | "light"): RGB {
	if (theme === "dark") {
		const gradFrom: RGB  = [6,   9,  22];
		const colRgb:  RGB   = [12, 16,  23];
		const colAlpha       = 0.7;
		const cardRgb: RGB   = [255, 255, 255];
		const cardAlpha      = 0.04;

		const afterCol  = compositeOver(colRgb,  colAlpha,  gradFrom);
		return compositeOver(cardRgb, cardAlpha, afterCol);
	} else {
		const gradFrom: RGB  = [211, 223, 239];   // #d3dfef
		const colRgb:  RGB   = [255, 255, 255];
		const colAlpha       = 0.49;
		const cardRgb: RGB   = [255, 255, 255];
		const cardAlpha      = 0.66;

		const afterCol  = compositeOver(colRgb,  colAlpha,  gradFrom);
		return compositeOver(cardRgb, cardAlpha, afterCol);
	}
}

/**
 * Parse a CSS variable value of the form "R G G" (space-separated sRGB
 * integers, as used in index.css) into an RGB tuple.
 */
export function parseRgbTriple(value: string): RGB {
	const parts = value.trim().split(/\s+/).map(Number);
	if (parts.length !== 3 || parts.some(isNaN)) {
		throw new Error(`Invalid RGB triple: "${value}"`);
	}
	return [parts[0], parts[1], parts[2]];
}

/**
 * Parse a hex colour string ("#rrggbb") into an RGB tuple.
 */
export function parseHex(hex: string): RGB {
	const h = hex.replace("#", "");
	return [
		parseInt(h.slice(0, 2), 16),
		parseInt(h.slice(2, 4), 16),
		parseInt(h.slice(4, 6), 16),
	];
}
