import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

/** One trip, from where the card was to where the layout just put it. */
export const TRAVEL_MS = 560;

/** How far the path bows out, as a share of the trip, and its ceiling in pixels. */
const BOW = 0.5;
const BOW_CAP = 260;

export interface Travel {
	/** Alternating so two trips in a row restart the animation instead of merging. */
	slot: "a" | "b";
	style: CSSProperties;
}

/**
 * The mid-point of the arc, in the same space as the start offset.
 *
 * Cards heading left ride over the top, cards heading right dip under the
 * bottom; a vertical trip goes round the left on the way up and round the right
 * on the way down. Two cards trading places therefore pass on opposite sides
 * instead of through each other, and the side alone says which way it went.
 */
export function travelArc(dx: number, dy: number): { mx: number; my: number } {
	const bow = Math.min(Math.hypot(dx, dy) * BOW, BOW_CAP);
	const horizontal = Math.abs(dx) >= Math.abs(dy);
	// dx is where the card starts relative to its new home, so a positive dx
	// means it is travelling left.
	if (horizontal) return { mx: dx / 2, my: dy / 2 + (dx > 0 ? -bow : bow) };
	return { mx: dx / 2 + (dy > 0 ? -bow : bow), my: dy / 2 };
}

/**
 * Carries a card from its old slot to its new one along that arc.
 *
 * Nothing but `transform` moves, so the trip stays on the compositor: the layout
 * still puts the card straight into its new `left`/`top`, and the animation only
 * paints it on its way there (the FLIP trick). Returns nothing while motion is
 * off or the card has not moved.
 */
export function useCardTravel(x: number, y: number, enabled: boolean): Travel | null {
	const previous = useRef<{ x: number; y: number } | null>(null);
	const parity = useRef(0);
	// Held in state, not derived per render: the stage re-renders on every animation
	// frame, and a trip computed from the last render would be dropped one frame in,
	// killing the animation with it.
	const [travel, setTravel] = useState<Travel | null>(null);
	// Before paint: the card must never be seen in its new slot and then jump back
	// to the start of its trip.
	useLayoutEffect(() => {
		const from = previous.current;
		previous.current = { x, y };
		if (!from || (from.x === x && from.y === y)) return;
		if (!enabled) {
			setTravel(null);
			return;
		}
		const dx = from.x - x;
		const dy = from.y - y;
		const { mx, my } = travelArc(dx, dy);
		parity.current += 1;
		setTravel({
			slot: parity.current % 2 === 1 ? "a" : "b",
			style: {
				["--travel-x" as string]: `${Math.round(dx)}px`,
				["--travel-y" as string]: `${Math.round(dy)}px`,
				["--travel-mx" as string]: `${Math.round(mx)}px`,
				["--travel-my" as string]: `${Math.round(my)}px`,
			},
		});
	}, [x, y, enabled]);
	useEffect(() => {
		if (!travel) return;
		const timer = setTimeout(() => setTravel(null), TRAVEL_MS);
		return () => clearTimeout(timer);
	}, [travel]);
	return travel;
}
