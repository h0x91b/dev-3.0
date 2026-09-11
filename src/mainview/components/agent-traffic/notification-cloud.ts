/**
 * The outline of a notification preview, as one closed path plus its trail.
 *
 * Geometry only: no colour, no text, no React. The shape is a single cubic-bezier
 * wave over a rounded box — deliberately NOT a union of circles. A row of equal
 * circles reads as machined scalloping the shorter it gets, and the preview is at
 * its shortest exactly where it matters (a one-line message on a zoomed-out
 * stage). A wave has no repeated primitive, and its amplitude is independent of
 * any corner radius, so a 50px-high preview still undulates.
 *
 * Chosen from six candidates measured side by side; the reference lives outside
 * the repo (Seq 1825, `silhouette-reference/`).
 */

/** Stroke allowance, so the outline is not clipped by its own SVG box. */
const RIM = 1.5;

/**
 * A fixed wave, never `Math.random`.
 *
 * The outline must be byte-identical on every repaint — a random one would redraw
 * a different cloud on a theme flip or a re-measure. Two different sequences
 * because a compact preview fits three crests where a full one fits four.
 */
const AMPLITUDES = {
	compact: [1, 0.6, 0.88],
	full: [0.94, 0.58, 1, 0.7],
} as const;

/**
 * One of the two puffs that tie the cloud to the card it belongs to.
 *
 * Ellipses, not circles, and they aim AT a point rather than drifting by a fixed
 * offset. The fixed-offset version shipped first and was wrong on screen: with
 * the cloud centred over its card the puffs drifted into the gap between two
 * neighbours and pointed at nothing. Two is the whole trail — a third adds
 * height without adding meaning at the sizes this preview lives at.
 */
export interface NotificationCloudPuff {
	cx: number;
	cy: number;
	rx: number;
	ry: number;
}

/** How big the trail is, relative to the full-size one. */
function trailScale(compact: boolean): number {
	return compact ? 0.72 : 1;
}

/**
 * The trail's own height, so the body can be offset by it when the cloud hangs
 * below its card and the puffs have to rise instead of fall.
 */
export function notificationTrailHeight(compact: boolean): number {
	return (22 + 5.5) * trailScale(compact) + RIM;
}

export interface NotificationCloudGeometry {
	/** One closed path in the geometry's own pixel space. Never a second subpath. */
	path: string;
	/** Total drawn size, trail and rim included. */
	width: number;
	height: number;
	/** Where the caller's content sits inside the outline. */
	content: { x: number; y: number; width: number; height: number };
	/** The body's outer edge on the side the card is — where the trail starts. */
	trailEdge: number;
	/** +1 when the trail falls out of the body, −1 when it rises out of it. */
	trailDirection: 1 | -1;
}

/**
 * The outline around a content box of `width` × `height` pixels.
 *
 * `compact` halves the wave and the corner radius rather than scaling the whole
 * shape: the height budget above a line of text is the entire problem here, and
 * a uniformly scaled cloud spends it on padding instead of on the wave.
 */
export function notificationCloud(
	width: number,
	height: number,
	compact: boolean,
	below = false,
): NotificationCloudGeometry {
	const trail = notificationTrailHeight(compact);
	// The trail always points AT the card, so hanging below its card flips it: the
	// body moves down by the trail's height and the puffs rise out of its crest.
	const shift = below ? trail : 0;
	const amplitude = compact ? 14 : 28;
	const radius = compact ? 9 : 16;
	// Padding INSIDE the outline, not around it. The wave's valley line and the
	// corner arcs are the box's own edges, so content laid out flush against them
	// reads as poking through the silhouette — measured in the browser, not
	// guessed. Horizontally it clears the corner arc; vertically it only has to
	// clear the line itself.
	const padX = radius * 0.55;
	const padY = 3;
	const box = width + padX * 2;
	const top = amplitude + RIM + 1;
	const bottom = (compact ? 4 : 8) + RIM;
	// The wave never leaves the outline box sideways, so the sides need only the rim.
	const x = RIM + 1;
	const y = top + shift;
	const amps = compact ? AMPLITUDES.compact : AMPLITUDES.full;
	// A crest cannot start inside a corner arc, so the wave spans the box minus
	// both radii — and a preview narrower than that gets one flat-ish crest rather
	// than a negative step.
	const step = Math.max(0, box - radius * 2) / amps.length;
	let path = `M${x},${y + radius}A${radius},${radius} 0 0,1 ${x + radius},${y}`;
	let at = x + radius;
	amps.forEach((ratio, index) => {
		const to = index === amps.length - 1 ? x + box - radius : at + step;
		const crest = y - amplitude * ratio;
		path += `C${at + (to - at) * 0.26},${crest} ${at + (to - at) * 0.74},${crest} ${to},${y}`;
		at = to;
	});
	const floor = y + height + padY * 2;
	path +=
		`A${radius},${radius} 0 0,1 ${x + box},${y + radius}` +
		`V${floor - radius}` +
		`A${radius},${radius} 0 0,1 ${x + box - radius},${floor}` +
		`H${x + radius}` +
		`A${radius},${radius} 0 0,1 ${x},${floor - radius}Z`;
	return {
		path,
		width: box + x * 2,
		height: top + height + padY * 2 + bottom + trail,
		content: { x: x + padX, y: y + padY, width, height },
		// Measured from the crest and not from the valley when it rises, or the
		// puffs would sit inside the wave.
		trailEdge: below ? y - top + RIM : floor + RIM,
		trailDirection: below ? -1 : 1,
	};
}

/**
 * The trail from the cloud's body to `targetX` — the card's own centre, in the
 * geometry's pixel space.
 *
 * Separate from `notificationCloud` on purpose: the target is only known after
 * the caller has clamped the cloud to its frame, and clamping needs the width
 * that `notificationCloud` is what computes. Aiming rather than drifting is what
 * makes the trail mean "this belongs to THAT card" — the puffs end over the card
 * whether the cloud sits above it, beside it, or shoved sideways by the frame.
 */
export function notificationCloudPuffs(
	cloud: NotificationCloudGeometry,
	targetX: number,
	compact: boolean,
): NotificationCloudPuff[] {
	const scale = trailScale(compact);
	// Starts under the body's middle and walks to the target, so a cloud leaning
	// off to one side gets a visibly diagonal trail and a centred one a straight
	// one. Both point at the card; only the angle differs.
	const from = cloud.width / 2;
	return [
		{ at: 0.45, dy: 8, rx: 13, ry: 8 },
		{ at: 1, dy: 22, rx: 7.5, ry: 5.5 },
	].map((puff) => ({
		cx: from + (targetX - from) * puff.at,
		cy: cloud.trailEdge + cloud.trailDirection * puff.dy * scale,
		rx: puff.rx * scale,
		ry: puff.ry * scale,
	}));
}
