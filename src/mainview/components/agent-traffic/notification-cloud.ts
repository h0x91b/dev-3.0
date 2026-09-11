/**
 * The outline of a notification preview, as one closed path.
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

export interface NotificationCloudGeometry {
	/** One closed path in the geometry's own pixel space. Never a second subpath. */
	path: string;
	/** Total drawn size, rim included. */
	width: number;
	height: number;
	/** Where the caller's content sits inside the outline. */
	content: { x: number; y: number; width: number; height: number };
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
): NotificationCloudGeometry {
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
	const y = top;
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
		height: top + height + padY * 2 + bottom,
		content: { x: x + padX, y: y + padY, width, height },
	};
}
