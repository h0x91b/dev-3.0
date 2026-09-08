import { frameExchange } from "../components/agent-traffic/traffic-camera";
import type { PlacedNode } from "../components/agent-traffic/nodes-layout";

const sender = { x: 0, y: 0, width: 370, height: 183 } as PlacedNode;
const recipient = { x: 1408, y: 720, width: 300, height: 222 } as PlacedNode;
const route = [
	{ x: 185, y: 183 },
	{ x: -26, y: 250 },
	{ x: -26, y: 680 },
	{ x: 1558, y: 680 },
	{ x: 1558, y: 720 },
];

it.each([{ width: 1400, height: 640 }, { width: 430, height: 550 }, { width: 320, height: 300 }])(
	"centers the pair and keeps both cards and the detour visible at $width px",
	(viewport) => {
		const camera = frameExchange(viewport, [sender, recipient], route);
		const center = {
			x: (sender.x + sender.width / 2 + recipient.x + recipient.width / 2) / 2,
			y: (sender.y + sender.height / 2 + recipient.y + recipient.height / 2) / 2,
		};
		expect(camera.x + center.x * camera.scale).toBeCloseTo(viewport.width / 2);
		expect(camera.y + center.y * camera.scale).toBeCloseTo(viewport.height / 2);
		const points = [...route, ...[sender, recipient].flatMap(node => [
			{ x: node.x, y: node.y },
			{ x: node.x + node.width, y: node.y + node.height },
		])];
		for (const point of points) {
			expect(camera.x + point.x * camera.scale).toBeGreaterThan(0);
			expect(camera.x + point.x * camera.scale).toBeLessThan(viewport.width);
			expect(camera.y + point.y * camera.scale).toBeGreaterThan(0);
			expect(camera.y + point.y * camera.scale).toBeLessThan(viewport.height);
		}
	},
);

it("keeps the same framing for a reciprocal reply", () => {
	const viewport = { width: 1400, height: 640 };
	expect(frameExchange(viewport, [sender, recipient], route)).toEqual(
		frameExchange(viewport, [recipient, sender], [...route].reverse()),
	);
});
