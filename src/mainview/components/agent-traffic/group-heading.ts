import { SCENE_PAD_Y } from "./traffic-camera";

/** Screen height of the heading line plus the gap it keeps above the frame. */
const HEADING_LIFT = 22;
/** Screen width a project name gets even when its group is narrower than that. */
const MIN_HEADING_WIDTH = 150;

/**
 * Where a project name sits, in scene units, above its group frame.
 *
 * The heading renders at a fixed screen size (it carries the inverse zoom), so
 * in scene units it grows as the stage shrinks: left inside the frame it swallows
 * the top padding and lands on the cards. It hangs above the frame instead, and
 * never higher than the padding the scene bounds already reserve — beyond that
 * the camera clamp would cut it off at the top of the viewport.
 */
export function headingTop(scale: number): number {
	return -Math.min(HEADING_LIFT / scale, SCENE_PAD_Y);
}

/**
 * Screen width the heading may use. A group zoomed down to 35px wide would clip
 * its own name to two letters, which is the same as having no name at all, so a
 * short name is allowed to overhang the frame it belongs to.
 */
export function headingWidth(groupWidth: number, scale: number): number {
	return Math.max(MIN_HEADING_WIDTH, (groupWidth - 48) * scale);
}
