import { useLayoutEffect, useState, type RefObject } from "react";

export interface ViewportPosition {
	top: number;
	left: number;
}

const EDGE_PAD = 8;

/**
 * Keeps an absolutely-positioned overlay inside the viewport.
 *
 * A portal anchored to a trigger's `getBoundingClientRect()` overflows as soon as
 * the trigger sits near an edge — which on a 390px phone is most of the time. The
 * overlay renders hidden for one frame, gets measured, then flips visible at a
 * clamped position, so it never paints off-screen.
 */
export function useViewportClamp(
	ref: RefObject<HTMLElement | null>,
	position: ViewportPosition,
	pad = EDGE_PAD,
): { position: ViewportPosition; visible: boolean } {
	const [clamped, setClamped] = useState(position);
	const [visible, setVisible] = useState(false);

	useLayoutEffect(() => {
		if (!ref.current) return;

		const box = ref.current.getBoundingClientRect();
		const maxTop = window.innerHeight - box.height - pad;
		const maxLeft = window.innerWidth - box.width - pad;

		setClamped({
			top: Math.max(pad, Math.min(position.top, maxTop)),
			left: Math.max(pad, Math.min(position.left, maxLeft)),
		});
		setVisible(true);
	}, [ref, position, pad]);

	return { position: clamped, visible };
}
