/**
 * Geometry for a classic thought cloud that fits whatever text is inside it.
 *
 * A notification is the agent thinking out loud at the human, so it is drawn as a
 * thought cloud rather than a speech bubble — lobed edges and a trail of shrinking
 * puffs down to the card that sent it. That shape cannot be a `border-radius`: the
 * lobes have to be recomputed every time the text changes size, so the outline is
 * built here from the measured content box and handed to one SVG path.
 *
 * How the silhouette is made without boolean geometry: every lobe is a circle and
 * the middle is a rectangle, all wound the SAME direction and filled
 * `fill-rule="nonzero"`, which unions them. Stroking that would draw every
 * internal arc, so the rim is a SECOND copy of the same silhouette, grown by a
 * hair and painted behind — a clean outline with no inner lines.
 */

/** One circle of the silhouette. */
interface Lobe {
	cx: number;
	cy: number;
	r: number;
}

export interface CloudGeometry {
	/** Viewport the caller must give the `<svg>`, content box plus lobe overhang. */
	width: number;
	height: number;
	/** Where the content box sits inside that viewport. */
	inset: number;
	/** `d` for the filled silhouette. */
	body: string;
	/** `d` for the same silhouette grown by `rim`, drawn behind the body. */
	bodyRim: string;
	/** `d` for the trail of puffs, or "" when the cloud is not anchored. */
	tail: string;
	tailRim: string;
	/** Height the tail occupies below the cloud. 0 without a tail. */
	tailHeight: number;
}

/** Radius of an edge lobe. Big enough to read as a cloud, small enough to stay tidy. */
const LOBE_R = 15;
/** Roughly how much edge one lobe covers; fewer, fatter lobes on a small cloud. */
const LOBE_PITCH = 46;
/** How far the rim extends past the body. */
const RIM = 1.25;

function circle(lobe: Lobe, grow = 0): string {
	const r = lobe.r + grow;
	// Clockwise in SVG's y-down space, matching the rectangle below so the
	// nonzero fill unions instead of punching holes.
	return `M${lobe.cx - r},${lobe.cy}A${r},${r} 0 0,1 ${lobe.cx + r},${lobe.cy}A${r},${r} 0 0,1 ${lobe.cx - r},${lobe.cy}Z`;
}

function rect(x: number, y: number, width: number, height: number, grow = 0): string {
	const left = x - grow;
	const top = y - grow;
	const right = x + width + grow;
	const bottom = y + height + grow;
	return `M${left},${top}H${right}V${bottom}H${left}Z`;
}

/** Evenly spaced lobe centres along an edge of `length`, at least `min` of them. */
function spread(length: number, min: number): number[] {
	const count = Math.max(min, Math.round(length / LOBE_PITCH));
	const step = length / count;
	return Array.from({ length: count }, (_, index) => step * (index + 0.5));
}

/**
 * Build the cloud around a content box of `contentWidth` × `contentHeight`.
 *
 * `tail` asks for the thought-trail; leave it off for a cloud rendered in
 * document flow, where there is nothing below it to point at.
 */
export function cloudGeometry(contentWidth: number, contentHeight: number, options: { tail?: boolean } = {}): CloudGeometry {
	const width = Math.max(40, contentWidth);
	const height = Math.max(24, contentHeight);
	const inset = LOBE_R + RIM;
	const lobes: Lobe[] = [];
	// Top and bottom edges carry most of the lobes; the sides get fewer, so a wide
	// cloud does not turn into a lumpy circle.
	for (const cx of spread(width, 3)) {
		lobes.push({ cx: inset + cx, cy: inset, r: LOBE_R });
		lobes.push({ cx: inset + cx, cy: inset + height, r: LOBE_R });
	}
	for (const cy of spread(height, 1)) {
		lobes.push({ cx: inset, cy: inset + cy, r: LOBE_R });
		lobes.push({ cx: inset + width, cy: inset + cy, r: LOBE_R });
	}
	const middle = rect(inset, inset, width, height);
	const middleRim = rect(inset, inset, width, height, RIM);
	const body = middle + lobes.map(lobe => circle(lobe)).join("");
	const bodyRim = middleRim + lobes.map(lobe => circle(lobe, RIM)).join("");

	if (!options.tail) {
		return { width: width + inset * 2, height: height + inset * 2, inset, body, bodyRim, tail: "", tailRim: "", tailHeight: 0 };
	}
	// Three shrinking puffs walking down from the cloud to the card it belongs to.
	// They start near the centre, because the cloud is centred over that card, and
	// drift only slightly sideways so the trail reads as a thought rather than as a
	// speech tail pointing dead straight at it.
	const centre = inset + width / 2;
	const drift = Math.min(26, width * 0.12);
	const base = inset + height + LOBE_R;
	const puffs: Lobe[] = [
		{ cx: centre - drift * 0.35, cy: base + 3, r: 7.5 },
		{ cx: centre - drift * 0.75, cy: base + 16, r: 5 },
		{ cx: centre - drift, cy: base + 26, r: 3 },
	];
	const tailHeight = puffs[puffs.length - 1].cy + puffs[puffs.length - 1].r + RIM - (inset + height + inset);
	return {
		width: width + inset * 2,
		height: height + inset * 2 + Math.max(0, tailHeight),
		inset,
		body,
		bodyRim,
		tail: puffs.map(puff => circle(puff)).join(""),
		tailRim: puffs.map(puff => circle(puff, RIM)).join(""),
		tailHeight: Math.max(0, tailHeight),
	};
}
