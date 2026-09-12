import { SCENE_PAD_Y } from "./traffic-camera";

/** Screen height of the heading line plus the gap it keeps above the frame. */
const HEADING_LIFT = 22;
/** Screen width a project name gets even when its group is narrower than that. */
const MIN_HEADING_WIDTH = 150;
/** Screen gap kept between one project's name and the next name on its row. */
const HEADING_GUTTER = 14;
/** Screen width below which a clipped name carries nothing and is dropped. */
const LEGIBLE_HEADING_WIDTH = 28;

/** A group frame on the stage, in scene units — what a heading hangs above. */
export interface HeadingFrame {
	x: number;
	y: number;
	width: number;
	height: number;
}

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
 * Scene distance from this group's name to the next name that could collide with
 * it: the nearest group to the right whose frame shares any of its vertical band.
 * `Infinity` when nothing stands to the right — the heading is then free to
 * overhang into empty canvas.
 */
export function headingRoom(group: HeadingFrame, groups: HeadingFrame[]): number {
	let room = Number.POSITIVE_INFINITY;
	for (const other of groups) {
		if (other === group || other.x <= group.x) continue;
		const sameBand =
			other.y < group.y + group.height && other.y + other.height > group.y;
		if (sameBand) room = Math.min(room, other.x - group.x);
	}
	return room;
}

/**
 * Screen width the heading may use. A group zoomed down to 35px wide would clip
 * its own name to two letters, which is the same as having no name at all, so a
 * short name is allowed to overhang the frame it belongs to — but never as far as
 * its neighbour's name. Both headings are screen-sized while the gap between two
 * groups is scene-sized, so zooming out shrinks the gap and not the labels: past
 * some zoom a narrow group's name runs straight through the next one and both
 * become unreadable. `room` (from [[headingRoom]]) is the ceiling that prevents it.
 */
export function headingWidth(
	groupWidth: number,
	scale: number,
	room = Number.POSITIVE_INFINITY,
): number {
	const natural = Math.max(MIN_HEADING_WIDTH, (groupWidth - 48) * scale);
	const allowed = Math.min(natural, room * scale - HEADING_GUTTER);
	// Two or three glyph columns are a smudge, not a name; nothing reads better
	// than a fragment of one letter sitting on the frame's corner.
	return allowed < LEGIBLE_HEADING_WIDTH ? 0 : allowed;
}
