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
 *
 * Three things make it read as a cloud rather than as a bumpy rectangle, and all
 * three were measured against a render, not guessed:
 *
 * 1. A lobe has to be BIG relative to the box. At r=15 on a 300-wide cloud the
 *    lobes are 5% of the width and the eye reads a dented rectangle.
 * 2. The radii have to VARY. Uniform lobes read as machined scalloping; a short
 *    repeating pattern of ratios gives the undulating edge a real cloud has.
 * 3. The CORNERS need their own lobes. Lobe centres sit on the content box's
 *    edges, so the box's four corners stick out past every neighbouring circle —
 *    which is exactly the square shoulder the first version had.
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

/**
 * How wide a wrapping line inside the cloud may get.
 *
 * It caps the LINES, never the box the cloud is measured from: capping the box
 * leaves a line that cannot wrap — the type/level/time head — measured at the
 * cap and painted outside the silhouette. Measured in a browser, not reasoned
 * about: the clock and the outcome pill both sat outside the cloud that way.
 */
export const CLOUD_TEXT_MAX_WIDTH = 250;

/** Radius of the biggest lobe. Every other radius is a ratio of this. */
const LOBE_R = 29;
/**
 * The same, for a preview cloud on a crowded canvas.
 *
 * The overhang dominates a cloud's footprint, not the text: shrinking the lobe
 * is what makes the cloud fit between two rows of cards. Measured on the real
 * stage — at full size one cloud crossed six cards.
 */
export const COMPACT_LOBE_R = 13;
/** Roughly how much edge one lobe covers. Below ~1.5r the lobes stop reading apart. */
const LOBE_PITCH = 42;
/** How far the rim extends past the body. */
const RIM = 1.5;
/** Top lobes, left to right, as ratios of `LOBE_R` — the pattern repeats. */
const TOP_RATIOS = [1, 0.7, 0.88, 0.64, 0.95];
/** Bottom lobes: smaller, so the cloud is fluffy on top and settles underneath. */
const BOTTOM_RATIOS = [0.5, 0.62, 0.46];
const SIDE_RATIO = 0.68;
const CORNER_RATIO = 0.7;
/** Fraction of its own radius a top lobe rises above the box; the undulation. */
const LIFT = 0.22;
/** The same, downwards, for the bottom edge. Small — a cloud does not sag much. */
const SAG = 0.05;
/** Trail puffs as [sideways drift fraction, drop below the body, radius]. */
const PUFFS: readonly [number, number, number][] = [
	[0.24, 6, 11],
	[0.6, 23, 7],
	[0.9, 37, 4.2],
];

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
function spread(length: number, min: number, lobeR: number = LOBE_R): number[] {
	// The pitch scales with the lobe, or a small cloud grows lobes so sparse that
	// the rectangle shows between them.
	const count = Math.max(min, Math.round(length / (LOBE_PITCH * (lobeR / LOBE_R))));
	const step = length / count;
	return Array.from({ length: count }, (_, index) => step * (index + 0.5));
}

/**
 * Build the cloud around a content box of `contentWidth` × `contentHeight`.
 *
 * `tail` asks for the thought-trail; leave it off for a cloud rendered in
 * document flow, where there is nothing below it to point at.
 */
export function cloudGeometry(
	contentWidth: number,
	contentHeight: number,
	options: { tail?: boolean; lobe?: number } = {},
): CloudGeometry {
	const width = Math.max(40, contentWidth);
	const height = Math.max(24, contentHeight);
	// Smaller lobes make a smaller cloud, which is the only way a cloud fits a
	// crowded stage: the overhang is what dominates its footprint, not the text.
	const lobeR = options.lobe ?? LOBE_R;
	// The furthest anything reaches past the box: a full-size top lobe, lifted.
	const inset = lobeR * (1 + LIFT) + RIM;
	const lobes: Lobe[] = [];
	const columns = spread(width, TOP_RATIOS.length, lobeR);
	columns.forEach((cx, index) => {
		const r = lobeR * TOP_RATIOS[index % TOP_RATIOS.length];
		lobes.push({ cx: inset + cx, cy: inset - LIFT * r, r });
	});
	columns.forEach((cx, index) => {
		const r = lobeR * BOTTOM_RATIOS[index % BOTTOM_RATIOS.length];
		lobes.push({ cx: inset + cx, cy: inset + height + SAG * r, r });
	});
	for (const cy of spread(height, 1, lobeR)) {
		lobes.push({ cx: inset, cy: inset + cy, r: lobeR * SIDE_RATIO });
		lobes.push({ cx: inset + width, cy: inset + cy, r: lobeR * SIDE_RATIO });
	}
	// One lobe per corner. Without these the content box's corners poke out of the
	// silhouette and the cloud grows four square shoulders.
	for (const [cx, cy] of [
		[inset, inset],
		[inset + width, inset],
		[inset, inset + height],
		[inset + width, inset + height],
	]) {
		lobes.push({ cx, cy, r: lobeR * CORNER_RATIO });
	}
	const body = rect(inset, inset, width, height) + lobes.map(lobe => circle(lobe)).join("");
	const bodyRim = rect(inset, inset, width, height, RIM) + lobes.map(lobe => circle(lobe, RIM)).join("");

	if (!options.tail) {
		return { width: width + inset * 2, height: height + inset * 2, inset, body, bodyRim, tail: "", tailRim: "", tailHeight: 0 };
	}
	// Shrinking puffs walking down from the cloud to the card it belongs to. They
	// start near the centre, because the cloud is centred over that card, and drift
	// sideways so the trail reads as a thought rather than as a speech tail pointing
	// dead straight at it.
	const centre = inset + width / 2;
	const drift = Math.min(32, width * 0.15);
	const base = inset + height + lobeR * Math.min(...BOTTOM_RATIOS) * 0.9;
	// The trail scales with the cloud too, so a compact cloud does not trail a
	// full-size tail longer than its own body.
	const puffScale = lobeR / LOBE_R;
	const puffs: Lobe[] = PUFFS.map(([dx, dy, r]) => ({ cx: centre - drift * dx, cy: base + dy * puffScale, r: r * puffScale }));
	const last = puffs[puffs.length - 1];
	const tailHeight = last.cy + last.r + RIM - (inset + height + inset);
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
