/**
 * Shared anchored-popover positioning.
 *
 * Every floating surface in the app (tooltips, help cards, ad-hoc popovers)
 * needs the same computation: place a box next to an anchor rect on a preferred
 * side, flip to the opposite side when it would overflow the viewport, and
 * clamp the final position inside the viewport with a small padding. Before
 * this util each popover re-implemented the logic inline (SiblingPopover,
 * StuckPreparationPopover, TerminalPreviewPopover all differ subtly); new
 * floating UI should use this instead.
 */

export type PopoverPlacement = "top" | "bottom" | "left" | "right";

export interface RectLike {
	top: number;
	left: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

export interface SizeLike {
	width: number;
	height: number;
}

export interface AnchoredPositionOptions {
	/** Preferred side of the anchor. Default: "bottom". */
	placement?: PopoverPlacement;
	/** Align the popover's cross-axis edge with the anchor's. Default: "start". */
	align?: "start" | "center" | "end";
	/** Gap between anchor and popover in px. Default: 6. */
	gap?: number;
	/** Minimum distance from the viewport edges in px. Default: 8. */
	pad?: number;
	/** Viewport size override (for tests). Defaults to window dimensions. */
	viewport?: SizeLike;
}

export interface AnchoredPosition {
	top: number;
	left: number;
	/** The side actually used after flipping. */
	placement: PopoverPlacement;
}

function viewportSize(override?: SizeLike): SizeLike {
	if (override) return override;
	return { width: window.innerWidth, height: window.innerHeight };
}

function mainAxisPosition(
	placement: PopoverPlacement,
	anchor: RectLike,
	pop: SizeLike,
	gap: number,
): { top: number; left: number } {
	switch (placement) {
		case "top":
			return { top: anchor.top - pop.height - gap, left: anchor.left };
		case "bottom":
			return { top: anchor.bottom + gap, left: anchor.left };
		case "left":
			return { top: anchor.top, left: anchor.left - pop.width - gap };
		case "right":
			return { top: anchor.top, left: anchor.right + gap };
	}
}

function crossAxisAlign(
	placement: PopoverPlacement,
	align: "start" | "center" | "end",
	anchor: RectLike,
	pop: SizeLike,
	pos: { top: number; left: number },
): { top: number; left: number } {
	const vertical = placement === "top" || placement === "bottom";
	if (vertical) {
		if (align === "center") return { ...pos, left: anchor.left + anchor.width / 2 - pop.width / 2 };
		if (align === "end") return { ...pos, left: anchor.right - pop.width };
		return pos;
	}
	if (align === "center") return { ...pos, top: anchor.top + anchor.height / 2 - pop.height / 2 };
	if (align === "end") return { ...pos, top: anchor.bottom - pop.height };
	return pos;
}

function overflows(
	placement: PopoverPlacement,
	pos: { top: number; left: number },
	pop: SizeLike,
	vp: SizeLike,
	pad: number,
): boolean {
	switch (placement) {
		case "top":
			return pos.top < pad;
		case "bottom":
			return pos.top + pop.height > vp.height - pad;
		case "left":
			return pos.left < pad;
		case "right":
			return pos.left + pop.width > vp.width - pad;
	}
}

const OPPOSITE: Record<PopoverPlacement, PopoverPlacement> = {
	top: "bottom",
	bottom: "top",
	left: "right",
	right: "left",
};

/**
 * Compute a fixed-position (viewport-relative) placement for a popover box next
 * to an anchor rect: preferred side → flip when it overflows → clamp into the
 * viewport. Pure — safe to unit-test without a DOM.
 */
export function computeAnchoredPosition(
	anchor: RectLike,
	pop: SizeLike,
	options: AnchoredPositionOptions = {},
): AnchoredPosition {
	const { placement = "bottom", align = "start", gap = 6, pad = 8 } = options;
	const vp = viewportSize(options.viewport);

	let used = placement;
	let pos = crossAxisAlign(used, align, anchor, pop, mainAxisPosition(used, anchor, pop, gap));

	if (overflows(used, pos, pop, vp, pad)) {
		const flipped = OPPOSITE[used];
		const flippedPos = crossAxisAlign(flipped, align, anchor, pop, mainAxisPosition(flipped, anchor, pop, gap));
		if (!overflows(flipped, flippedPos, pop, vp, pad)) {
			used = flipped;
			pos = flippedPos;
		}
	}

	// Final clamp on both axes — flipping handles the main axis, this handles
	// the cross axis (and degenerate cases where both sides overflow).
	let { top, left } = pos;
	if (left + pop.width > vp.width - pad) left = vp.width - pop.width - pad;
	if (left < pad) left = pad;
	if (top + pop.height > vp.height - pad) top = vp.height - pop.height - pad;
	if (top < pad) top = pad;

	return { top, left, placement: used };
}
