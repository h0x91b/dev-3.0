import type { PlacedNode } from "./nodes-layout";

export interface CameraView {
	x: number;
	y: number;
	scale: number;
}
type Point = { x: number; y: number };
type Viewport = { width: number; height: number };

/** Highest zoom the stage ever reaches, framed or hand-driven. */
export const MAX_SCALE = 2.2;

/** Scene padding above and below the content — framing and the bounds share it. */
export const SCENE_PAD_Y = 86;

/** The scene's outer edge, padding included — what a camera may never overshoot. */
export interface SceneBounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/**
 * Stage the overview ceiling was calibrated on. The ceiling is an absolute scale,
 * so on a 4K stage it pins the whole graph to its laptop size in a viewport twice
 * as wide and leaves most of the stage empty. Scaling it with the stage keeps a
 * card the same *share* of the screen instead. Never below 1: on a smaller stage
 * the fit arithmetic binds long before the ceiling does, so the calibrated
 * framing is untouched there.
 */
const REFERENCE_STAGE = { width: 1600, height: 900 };

export function stageCeiling(viewport: Viewport, calibrated: number): number {
	const factor = Math.max(
		1,
		Math.min(
			viewport.width / REFERENCE_STAGE.width,
			viewport.height / REFERENCE_STAGE.height,
		),
	);
	return Math.min(MAX_SCALE, calibrated * factor);
}

/**
 * Lowest zoom at which a card still carries its identity — seq, title, status.
 * Below it every card is a bare coloured rectangle: `.traffic-nodes[data-detail="cell"]`
 * hides the whole card body, so the tier boundary and this floor are one number.
 */
export const IDENTITY_SCALE = 0.36;

/** Above this a card shows every row it has, not just the compact three. */
export const FULL_DETAIL_SCALE = 0.7;

export function detailTier(scale: number): "cell" | "compact" | "full" {
	return scale < IDENTITY_SCALE
		? "cell"
		: scale < FULL_DETAIL_SCALE
			? "compact"
			: "full";
}

/**
 * Zoom the overview opens at, for a scene of `content` on a stage of `viewport`.
 *
 * `floor` is what keeps a phone out of the `cell` tier. A 390px stage fits the
 * whole graph only at ~18%, where the stage is nine blank rectangles and the
 * screen carries no information at all; framing a centred, legible part of it
 * instead leaves pan and zoom to reach the rest. Passed as 0 when the user asked
 * for the whole graph by hand, which stays a true fit.
 */
export function overviewScale(
	viewport: Viewport,
	content: Viewport,
	calibrated: number,
	floor = 0,
): number {
	return Math.max(
		floor,
		Math.min(
			stageCeiling(viewport, calibrated),
			(viewport.width - 52) / content.width,
			(viewport.height - 80) / content.height,
		),
	);
}

/**
 * Pull a camera back inside the scene so it never frames emptiness.
 *
 * Framing a pair centres on that pair, which is right on a stage the scene
 * overflows. On a stage wider than the whole graph it is not: the camera spends
 * the extra room on blank canvas above and beside the pair while the rest of the
 * graph sits outside the viewport — the two halves of the reported 4K symptom, in
 * one frame. The clamp only ever removes margin, so the framed pair stays visible
 * either way; an axis the scene does not fill is centred on the scene instead.
 */
export function clampToBounds(
	view: CameraView,
	viewport: Viewport,
	bounds: SceneBounds,
): CameraView {
	const axis = (
		offset: number,
		size: number,
		near: number,
		far: number,
	): number => {
		if ((far - near) * view.scale <= size)
			return size / 2 - ((near + far) / 2) * view.scale;
		return Math.min(
			-near * view.scale,
			Math.max(size - far * view.scale, offset),
		);
	};
	return {
		scale: view.scale,
		x: axis(view.x, viewport.width, bounds.left, bounds.right),
		y: axis(view.y, viewport.height, bounds.top, bounds.bottom),
	};
}

export function frameExchange(
	viewport: Viewport,
	// Rectangles, not cards: the transient speaker is framed the same way and has
	// no node behind it.
	nodes: Pick<PlacedNode, "x" | "y" | "width" | "height">[],
	route: Point[],
	bounds?: SceneBounds,
): CameraView {
	const points = [
		...route,
		...nodes.flatMap((node) => [
			{ x: node.x, y: node.y },
			{ x: node.x + node.width, y: node.y + node.height },
		]),
	];
	const center = {
		x: nodes.reduce((sum, node) => sum + node.x + node.width / 2, 0) / nodes.length,
		y: nodes.reduce((sum, node) => sum + node.y + node.height / 2, 0) / nodes.length,
	};
	const width = 2 * (Math.max(...points.map((p) => Math.abs(p.x - center.x))) + 70);
	const height = 2 * (Math.max(...points.map((p) => Math.abs(p.y - center.y))) + 86);
	// The pair keeps its calibrated size on every stage: a card carries no more
	// information magnified, and 1.03 is already its natural, legible scale. What
	// a big stage buys is context, and the clamp below is what spends it.
	const scale = Math.min(
		1.03,
		(viewport.width - 52) / width,
		(viewport.height - 80) / height,
	);
	const framed = {
		scale,
		x: viewport.width / 2 - center.x * scale,
		y: viewport.height / 2 - center.y * scale,
	};
	return bounds ? clampToBounds(framed, viewport, bounds) : framed;
}
