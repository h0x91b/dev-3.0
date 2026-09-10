import {
	FULL_DETAIL_SCALE,
	IDENTITY_SCALE,
	MAX_SCALE,
	clampToBounds,
	detailTier,
	frameExchange,
	overviewScale,
	stageCeiling,
} from "../components/agent-traffic/traffic-camera";
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

describe("stage ceiling", () => {
	it("leaves the calibrated ceiling alone on a reference stage or smaller", () => {
		expect(stageCeiling({ width: 1600, height: 900 }, 0.85)).toBeCloseTo(0.85);
		expect(stageCeiling({ width: 1440, height: 900 }, 0.85)).toBeCloseTo(0.85);
		expect(stageCeiling({ width: 1024, height: 768 }, 0.85)).toBeCloseTo(0.85);
	});

	it("grows with the stage so a card keeps its share of a 4K screen", () => {
		// 3840×1894 is the stage a maximised 4K window leaves once the traffic
		// chrome is subtracted — the configuration the framing bug was reported on.
		expect(stageCeiling({ width: 3840, height: 1894 }, 0.85)).toBeCloseTo(0.85 * (1894 / 900));
	});

	it("follows the smaller of the two axes, so a wide short stage does not balloon", () => {
		expect(stageCeiling({ width: 3840, height: 900 }, 0.85)).toBeCloseTo(0.85);
	});

	it("never exceeds the manual zoom ceiling", () => {
		expect(stageCeiling({ width: 7680, height: 4320 }, 0.85)).toBe(MAX_SCALE);
	});
});

describe("clamping the framed pair to the scene", () => {
	// A two-project board: the pair lives in the left group, the right group is the
	// context a big stage has room for and the old camera pushed out of view.
	const bounds = { left: -70, top: -86, right: 3300, bottom: 1100 };
	const fourK = { width: 3840, height: 1894 };
	const laptop = { width: 1400, height: 640 };

	function visible(camera: { x: number; y: number; scale: number }, viewport: { width: number; height: number }) {
		return {
			left: bounds.left * camera.scale + camera.x,
			top: bounds.top * camera.scale + camera.y,
			right: bounds.right * camera.scale + camera.x,
			bottom: bounds.bottom * camera.scale + camera.y,
			viewport,
		};
	}

	it("keeps the pair at its calibrated scale on every stage", () => {
		// A card carries no more information magnified; what a big stage buys is
		// context, which the clamp spends it on.
		expect(frameExchange(fourK, [sender, recipient], route, bounds).scale).toBeCloseTo(1.03);
		expect(frameExchange(laptop, [sender, recipient], route).scale).toBeLessThanOrEqual(1.03);
	});

	it("shows the whole scene once it fits, instead of empty canvas beside the pair", () => {
		const camera = frameExchange(fourK, [sender, recipient], route, bounds);
		const box = visible(camera, fourK);
		// The reported 4K frame had ~40% of the stage height blank above the graph
		// while the second project sat off the right edge. Both are gone.
		expect(box.left).toBeGreaterThan(0);
		expect(box.right).toBeLessThan(fourK.width);
		expect(box.top).toBeGreaterThan(0);
		expect(box.bottom).toBeLessThan(fourK.height);
	});

	it("never frames past the scene edge when the scene overflows the stage", () => {
		const camera = frameExchange(laptop, [sender, recipient], route, bounds);
		const box = visible(camera, laptop);
		expect(box.left).toBeLessThanOrEqual(0);
		expect(box.right).toBeGreaterThanOrEqual(laptop.width);
	});

	it("still frames the pair itself, clamped or not", () => {
		for (const [viewport, passed] of [
			[fourK, bounds],
			[laptop, bounds],
			[laptop, undefined],
		] as const) {
			const camera = frameExchange(viewport, [sender, recipient], route, passed);
			for (const node of [sender, recipient]) {
				expect(camera.x + node.x * camera.scale).toBeGreaterThanOrEqual(0);
				expect(camera.x + (node.x + node.width) * camera.scale).toBeLessThanOrEqual(viewport.width);
				expect(camera.y + node.y * camera.scale).toBeGreaterThanOrEqual(0);
				expect(camera.y + (node.y + node.height) * camera.scale).toBeLessThanOrEqual(viewport.height);
			}
		}
	});

	it("centres the scene on an axis it does not fill", () => {
		const flat = { left: 0, top: 0, right: 400, bottom: 300 };
		const camera = clampToBounds({ x: -9999, y: 9999, scale: 1 }, fourK, flat);
		expect(camera.x + 200).toBeCloseTo(fourK.width / 2);
		expect(camera.y + 150).toBeCloseTo(fourK.height / 2);
	});
});

describe("overview framing floor", () => {
	// The graph the phone report was measured on: nine cards in three rows.
	const graph = { width: 1852, height: 1074 };
	const phone = { width: 390, height: 419 };
	const laptop = { width: 1440, height: 603 };
	const fourK = { width: 3840, height: 1863 };

	it("opens a phone stage in a tier where a card still has its identity", () => {
		expect(overviewScale(phone, graph, 0.85)).toBeLessThan(IDENTITY_SCALE);
		expect(detailTier(overviewScale(phone, graph, 0.85))).toBe("cell");
		const floored = overviewScale(phone, graph, 0.85, IDENTITY_SCALE);
		expect(floored).toBe(IDENTITY_SCALE);
		expect(detailTier(floored)).not.toBe("cell");
	});

	it("leaves a stage that already fits legibly untouched", () => {
		for (const stage of [laptop, fourK]) {
			const plain = overviewScale(stage, graph, 0.85);
			expect(plain).toBeGreaterThan(IDENTITY_SCALE);
			expect(overviewScale(stage, graph, 0.85, IDENTITY_SCALE)).toBe(plain);
		}
	});

	it("keeps a hand-asked fit a true fit, floor or not", () => {
		expect(overviewScale(phone, graph, 0.85, 0)).toBe(overviewScale(phone, graph, 0.85));
	});

	it("puts the tier boundary exactly where the card body appears", () => {
		expect(detailTier(IDENTITY_SCALE - 0.001)).toBe("cell");
		expect(detailTier(IDENTITY_SCALE)).toBe("compact");
		expect(detailTier(FULL_DETAIL_SCALE - 0.001)).toBe("compact");
		expect(detailTier(FULL_DETAIL_SCALE)).toBe("full");
	});
});
