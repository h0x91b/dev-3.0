/**
 * The seq number a card carries at the `cell` tier, where the body is hidden and
 * the card is a bare coloured rectangle. Without it a zoomed-out stage is a wall
 * of anonymous blocks.
 */

/** Width one digit takes at font-size 1, plus the side room left around the label. */
const DIGIT_ADVANCE = 0.62;
const USABLE_WIDTH = 0.72;
/** Ceiling for a one-digit seq, which the width alone would let grow past the card. */
const USABLE_HEIGHT = 0.78;

/**
 * Font size, in scene units, that keeps `label` inside a `width`×`height` card.
 * A one-digit seq is height-bound and huge; each extra character makes the width
 * bind harder, so `1883` and `49-1` shrink to roughly half of `4`.
 */
export function cellSeqFontSize(
	label: string,
	width: number,
	height: number,
): number {
	const chars = Math.max(1, label.length);
	return Math.round(
		Math.min(
			height * USABLE_HEIGHT,
			(width * USABLE_WIDTH) / (chars * DIGIT_ADVANCE),
		),
	);
}

/**
 * Ink that reads on a card filled with `background`. At this tier the fill is the
 * raw status colour — bright pastels in dark theme, saturated mid-darks in light
 * — so the choice is made per card from its own luminance, not from the theme.
 */
export function cellSeqInk(background: string | undefined): string {
	const hex = /^#([0-9a-f]{6})$/i.exec(background?.trim() ?? "");
	if (!hex) return "rgb(var(--text-primary))";
	const value = Number.parseInt(hex[1], 16);
	const channel = (shift: number) => {
		const srgb = ((value >> shift) & 0xff) / 255;
		return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
	};
	const luminance =
		0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
	return luminance > 0.36 ? "rgba(0, 0, 0, 0.72)" : "rgba(255, 255, 255, 0.86)";
}
