import type { PlacedNode } from "./nodes-layout";

export interface CameraView {
	x: number;
	y: number;
	scale: number;
}
type Point = { x: number; y: number };
type Viewport = { width: number; height: number };

export function frameExchange(
	viewport: Viewport,
	nodes: PlacedNode[],
	route: Point[],
): CameraView {
	const points = [
		...route,
		...nodes.flatMap((node) => [
			{ x: node.x, y: node.y },
			{ x: node.x + node.width, y: node.y + node.height },
		]),
	];
	const left = Math.min(...points.map((p) => p.x)) - 50;
	const top = Math.min(...points.map((p) => p.y)) - 60;
	const width = Math.max(...points.map((p) => p.x)) + 50 - left;
	const height = Math.max(...points.map((p) => p.y)) + 60 - top;
	const scale = Math.max(
		0.14,
		Math.min(
			1.03,
			(viewport.width - 52) / width,
			(viewport.height - 80) / height,
		),
	);
	return {
		scale,
		x: viewport.width / 2 - (left + width / 2) * scale,
		y: viewport.height / 2 - (top + height / 2) * scale,
	};
}

export function frameRecipient(
	viewport: Viewport,
	node: PlacedNode,
	stop?: Point,
): CameraView {
	const scale = Math.max(
		0.14,
		Math.min(
			1.12,
			(viewport.width - 100) / node.width,
			(viewport.height - 120) / node.height,
		),
	);
	const center = stop ?? {
		x: node.x + node.width / 2,
		y: node.y + node.height / 2,
	};
	return {
		scale,
		x: viewport.width / 2 - center.x * scale,
		y: viewport.height / 2 - center.y * scale,
	};
}

/** Show the route during flight, then settle close to the actual destination. */
export function followView(
	from: CameraView,
	exchange: CameraView,
	recipient: CameraView,
	progress: number,
): CameraView {
	const phase = Math.max(0, Math.min(1, progress));
	if (phase >= 1) return recipient;
	if (phase >= 1 / 3 && phase <= 2 / 3) return exchange;
	const start = phase < 1 / 3 ? from : exchange;
	const end = phase < 1 / 3 ? exchange : recipient;
	const t = phase < 1 / 3 ? phase * 3 : (phase - 2 / 3) * 3;
	const eased = t * t * (3 - 2 * t);
	return {
		x: start.x + (end.x - start.x) * eased,
		y: start.y + (end.y - start.y) * eased,
		scale: start.scale + (end.scale - start.scale) * eased,
	};
}
