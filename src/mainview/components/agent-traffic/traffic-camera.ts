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
	const center = {
		x: nodes.reduce((sum, node) => sum + node.x + node.width / 2, 0) / nodes.length,
		y: nodes.reduce((sum, node) => sum + node.y + node.height / 2, 0) / nodes.length,
	};
	const width = 2 * (Math.max(...points.map((p) => Math.abs(p.x - center.x))) + 70);
	const height = 2 * (Math.max(...points.map((p) => Math.abs(p.y - center.y))) + 86);
	const scale = Math.min(
		1.03,
		(viewport.width - 52) / width,
		(viewport.height - 80) / height,
	);
	return {
		scale,
		x: viewport.width / 2 - center.x * scale,
		y: viewport.height / 2 - center.y * scale,
	};
}
