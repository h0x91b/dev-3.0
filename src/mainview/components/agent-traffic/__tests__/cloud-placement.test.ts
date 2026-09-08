import { describe, expect, it } from "vitest";
import { type CloudToPlace, type Rect, placeClouds } from "../cloud-placement";

/** Seq 1823's measured stage, at the fit zoom the screen opens on (report 09 §2). */
const CANVAS = { width: 1280, height: 355 };
const CARDS: Rect[] = [
	{ left: 593, top: 62, width: 93, height: 46 },   // #101, alone in the top row
	{ left: 425, top: 147, width: 75, height: 56 },  // #102
	{ left: 514, top: 147, width: 75, height: 56 },  // #103
	{ left: 602, top: 147, width: 75, height: 56 },  // #104
	{ left: 691, top: 147, width: 75, height: 56 },  // #105
	{ left: 779, top: 147, width: 75, height: 56 },  // #106
	{ left: 425, top: 238, width: 75, height: 56 },  // #107
];
/** A compact cloud, as it actually measures in a browser. */
const SIZE = { width: 255, height: 67 };

function cloud(key: string, card: Rect, size = SIZE): CloudToPlace {
	return { key, anchor: { x: card.left + card.width / 2, y: card.top, height: card.height }, size };
}

function rect(placement: { left: number; top: number }, size = SIZE): Rect {
	return { ...placement, ...size };
}

function overlaps(a: Rect, b: Rect): boolean {
	return a.left < b.left + b.width && b.left < a.left + a.width
		&& a.top < b.top + b.height && b.top < a.top + a.height;
}

describe("placeClouds", () => {
	it("hangs a cloud above its card when that space is free", () => {
		const [middle] = [CARDS[2]];
		const placed = placeClouds({ canvas: CANVAS, obstacles: CARDS, clouds: [cloud("a", middle)] });
		const spot = placed.get("a")!;
		expect(spot.side).toBe("above");
		expect(spot.overlap).toBe(0);
	});

	it("gives up the preferred side rather than cover a card", () => {
		// #104 has a card 39px overhead — less than the cloud — and open space below.
		const placed = placeClouds({ canvas: CANVAS, obstacles: CARDS, clouds: [cloud("a", CARDS[3])] });
		expect(placed.get("a")!.side).toBe("below");
		expect(placed.get("a")!.overlap).toBe(0);
	});

	it("slides sideways instead of giving up a clean placement", () => {
		// One obstacle directly overhead, narrow enough to step around.
		const card: Rect = { left: 500, top: 200, width: 75, height: 56 };
		const overhead: Rect = { left: 480, top: 110, width: 75, height: 56 };
		const placed = placeClouds({ canvas: CANVAS, obstacles: [card, overhead], clouds: [cloud("a", card)] });
		const spot = placed.get("a")!;
		expect(spot.overlap).toBe(0);
		expect(overlaps(rect(spot), overhead)).toBe(false);
		// Still visibly its own card's thought: the slide is bounded.
		const centred = card.left + card.width / 2 - SIZE.width / 2;
		expect(Math.abs(spot.left - centred)).toBeLessThanOrEqual(SIZE.width * 0.34 + 1);
	});

	it("keeps two clouds off each other, which no single cloud can do alone", () => {
		// Two senders side by side in the same row: centred, their clouds would
		// occupy nearly the same pixels.
		const placed = placeClouds({
			canvas: CANVAS,
			obstacles: CARDS,
			clouds: [cloud("a", CARDS[2]), cloud("b", CARDS[4])],
		});
		expect(overlaps(rect(placed.get("a")!), rect(placed.get("b")!))).toBe(false);
	});

	it("keeps a burst of five apart, on the measured stage", () => {
		const clouds = [CARDS[1], CARDS[2], CARDS[3], CARDS[4], CARDS[5]].map((card, index) => cloud(`c${index}`, card));
		const placed = placeClouds({ canvas: CANVAS, obstacles: CARDS, clouds });
		const spots = clouds.map(item => rect(placed.get(item.key)!));
		for (let i = 0; i < spots.length; i += 1)
			for (let j = i + 1; j < spots.length; j += 1)
				expect(overlaps(spots[i], spots[j])).toBe(false);
	});

	it("never leaves the canvas, in either axis", () => {
		const edges: Rect[] = [
			{ left: 0, top: 0, width: 75, height: 56 },
			{ left: CANVAS.width - 75, top: 0, width: 75, height: 56 },
			{ left: 0, top: CANVAS.height - 56, width: 75, height: 56 },
			{ left: CANVAS.width - 75, top: CANVAS.height - 56, width: 75, height: 56 },
		];
		for (const [index, card] of edges.entries()) {
			const placed = placeClouds({ canvas: CANVAS, obstacles: [card], clouds: [cloud(`e${index}`, card)] });
			const spot = placed.get(`e${index}`)!;
			expect(spot.left).toBeGreaterThanOrEqual(0);
			expect(spot.top).toBeGreaterThanOrEqual(0);
			expect(spot.left + SIZE.width).toBeLessThanOrEqual(CANVAS.width);
			expect(spot.top + SIZE.height).toBeLessThanOrEqual(CANVAS.height);
		}
	});

	it("does not treat the cloud's own card as something to avoid", () => {
		// The trail reaches down to it on purpose, so a placement that dodged it
		// would push every cloud away from the card it belongs to.
		const lone: Rect = { left: 600, top: 180, width: 75, height: 56 };
		const placed = placeClouds({ canvas: CANVAS, obstacles: [lone], clouds: [cloud("a", lone)] });
		const spot = placed.get("a")!;
		expect(spot.overlap).toBe(0);
		expect(Math.abs(spot.left - (lone.left + lone.width / 2 - SIZE.width / 2))).toBeLessThan(1);
	});

	it("reports the overlap it could not avoid instead of pretending it is zero", () => {
		// A canvas barely bigger than the cloud, walled in. No honest zero exists.
		const canvas = { width: 300, height: 120 };
		const card: Rect = { left: 110, top: 50, width: 75, height: 20 };
		const walls: Rect[] = [
			card,
			{ left: 0, top: 0, width: 300, height: 45 },
			{ left: 0, top: 75, width: 300, height: 45 },
		];
		const placed = placeClouds({ canvas, obstacles: walls, clouds: [cloud("a", card)] });
		expect(placed.get("a")!.overlap).toBeGreaterThan(0);
		// And it still stays on the canvas rather than escaping the problem.
		expect(placed.get("a")!.top).toBeGreaterThanOrEqual(0);
	});

	it("serves the newest cloud first when the room runs out", () => {
		// One free pocket, two clouds wanting it: the newest is the one the reader
		// is looking for, so it gets the clean spot.
		const card: Rect = { left: 500, top: 200, width: 75, height: 56 };
		const other: Rect = { left: 520, top: 200, width: 75, height: 56 };
		const placed = placeClouds({
			canvas: { width: 640, height: 360 },
			obstacles: [card, other],
			clouds: [cloud("older", card), cloud("newer", other)],
		});
		expect(placed.get("newer")!.overlap).toBe(0);
		expect(placed.get("newer")!.overlap).toBeLessThanOrEqual(placed.get("older")!.overlap);
	});

	it("places every cloud it is given, and nothing else", () => {
		const clouds = [cloud("a", CARDS[0]), cloud("b", CARDS[6])];
		const placed = placeClouds({ canvas: CANVAS, obstacles: CARDS, clouds });
		expect([...placed.keys()].sort()).toEqual(["a", "b"]);
	});

	it("works with no obstacles at all, for a surface that has none", () => {
		const lone: Rect = { left: 600, top: 200, width: 75, height: 56 };
		const placed = placeClouds({ canvas: CANVAS, clouds: [cloud("a", lone)] });
		expect(placed.get("a")!.side).toBe("above");
		expect(placed.get("a")!.overlap).toBe(0);
	});

	it("keeps the side it chose even when the clamp moves the box", () => {
		// A clamp can push a "below" box back up past its own anchor. Deriving the
		// side from the final coordinates then flips it, and the thought trail ends up
		// pointing away from the card — caught by a component test, fixed here.
		const canvas = { width: 600, height: 200 };
		const card: Rect = { left: 250, top: 120, width: 75, height: 56 };
		const above: Rect = { left: 0, top: 0, width: 600, height: 110 };
		const placed = placeClouds({ canvas, obstacles: [card, above], clouds: [cloud("a", card)] });
		expect(placed.get("a")!.side).toBe("below");
	});
});
