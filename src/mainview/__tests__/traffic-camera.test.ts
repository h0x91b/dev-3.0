import {
	followView,
	frameExchange,
	frameRecipient,
} from "../components/agent-traffic/traffic-camera";
import type { PlacedNode } from "../components/agent-traffic/nodes-layout";

const viewport = { width: 1400, height: 640 };
const sender = { x: 0, y: 0, width: 300, height: 222 } as PlacedNode;
const recipient = { x: 704, y: 720, width: 300, height: 222 } as PlacedNode;
const route = [
	{ x: 150, y: 222 },
	{ x: -26, y: 250 },
	{ x: -26, y: 680 },
	{ x: 854, y: 680 },
	{ x: 854, y: 720 },
];

it("frames the detour, then visibly zooms to the recipient instead of holding the pair", () => {
	const wide = frameExchange(viewport, [sender, recipient], route);
	const close = frameRecipient(viewport, recipient);
	expect(close.scale).toBeGreaterThan(wide.scale * 1.5);
	expect(followView(close, wide, close, 0.5)).toEqual(wide);
	expect(followView(close, wide, close, 1)).toEqual(close);
	for (const point of route) {
		expect(wide.x + point.x * wide.scale).toBeGreaterThan(0);
		expect(wide.x + point.x * wide.scale).toBeLessThan(viewport.width);
		expect(wide.y + point.y * wide.scale).toBeGreaterThan(0);
		expect(wide.y + point.y * wide.scale).toBeLessThan(viewport.height);
	}
});

it("reversing a reply changes its final camera position even for the same pair", () => {
	const a = frameRecipient(viewport, sender),
		b = frameRecipient(viewport, recipient);
	expect(a).not.toEqual(b);
	for (const [node, camera] of [
		[sender, a],
		[recipient, b],
	] as const) {
		expect(camera.x + (node.x + node.width / 2) * camera.scale).toBeCloseTo(
			viewport.width / 2,
		);
		expect(camera.y + (node.y + node.height / 2) * camera.scale).toBeCloseTo(
			viewport.height / 2,
		);
	}
});

it("held and failed flights can finish at their stop point without claiming arrival", () => {
	const stopped = { x: -26, y: 680 };
	const camera = frameRecipient(viewport, recipient, stopped);
	expect(camera.x + stopped.x * camera.scale).toBeCloseTo(viewport.width / 2);
	expect(camera.y + stopped.y * camera.scale).toBeCloseTo(viewport.height / 2);
});
