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

	it("still centres over its own card, which it does not need to cover", () => {
		// The trail lives inside the cloud's own box and stops short of the card, so a
		// clean placement never reaches into it — the cloud can treat its own card as
		// an obstacle and still sit centred right above it.
		const lone: Rect = { left: 600, top: 180, width: 75, height: 56 };
		const placed = placeClouds({ canvas: CANVAS, obstacles: [lone], clouds: [cloud("a", lone)] });
		const spot = placed.get("a")!;
		expect(spot.overlap).toBe(0);
		expect(Math.abs(spot.left - (lone.left + lone.width / 2 - SIZE.width / 2))).toBeLessThan(1);
	});

	it("does not sit on its OWN card when the clamp pulls it down onto one", () => {
		// Seq 1823's reproduction, verbatim: at 39% zoom the stage pans, so card #101
		// straddles the top edge at y −4..68. Every "above" candidate is off-canvas,
		// the clamp pulls the cloud back to top 4 — onto the card — and the card's
		// title ended up 100% hidden while the placement scored zero, because the
		// cloud's own card was excluded from its obstacles. It is not excluded now.
		const own: Rect = { left: 567, top: -4, width: 145, height: 72 };
		const size = { width: 278, height: 67 };
		const placed = placeClouds({
			canvas: CANVAS,
			obstacles: [own, { left: 663, top: 229, width: 117, height: 87 }],
			clouds: [cloud("a", own, size)],
		}).get("a")!;
		expect(placed.overlap).toBe(0);
		// And the number is honest about the box that actually lands on screen.
		const landed = { ...placed, ...size };
		const covered = Math.max(0, Math.min(landed.left + size.width, own.left + own.width) - Math.max(landed.left, own.left))
			* Math.max(0, Math.min(landed.top + size.height, own.top + own.height) - Math.max(landed.top, own.top));
		expect(covered).toBe(0);
	});

	it("scores the box that lands, not the candidate before the clamp", () => {
		// The area form of the side-flip: a candidate can be clean where it was asked
		// for and dirty where the clamp puts it. Whatever is reported has to describe
		// the box on screen, or an acceptance run reads a zero that is not true.
		const canvas = { width: 400, height: 160 };
		const own: Rect = { left: 150, top: -10, width: 100, height: 60 };
		const size = { width: 300, height: 100 };
		const wall: Rect = { left: 0, top: 55, width: 400, height: 105 };
		const placed = placeClouds({ canvas, obstacles: [own, wall], clouds: [cloud("a", own, size)] }).get("a")!;
		const landed = { ...placed, ...size };
		const truth = [own, wall].reduce((sum, box) => sum
			+ Math.max(0, Math.min(landed.left + size.width, box.left + box.width) - Math.max(landed.left, box.left))
			* Math.max(0, Math.min(landed.top + size.height, box.top + box.height) - Math.max(landed.top, box.top)), 0);
		expect(placed.overlap).toBe(Math.round(truth));
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

	describe("Seq 1823's real stage, step 44 at 39% zoom", () => {
		// Their verbatim handoff, not a scaled stand: every box in the space their code
		// passes it, from one frame of the preserved fixture. The sender #107 is boxed
		// in — #102 above it, the caption below, the canvas edge to its left.
		const CANVAS_39 = { width: 1280, height: 355 };
		const ANCHOR = { x: 363.5, y: 271.4, height: 87.2 };
		// The preview as it measures TODAY. Their handoff recorded 66.7 tall, which is
		// what clipped the stamp; the preview was shortened to 51.1 for exactly this.
		const CLOUD = { width: 220.7, height: 51.1 };
		const CLOUD_BEFORE = { width: 220.7, height: 66.7 };
		const OBSTACLES: Rect[] = [
			{ left: 567.3, top: -3.6, width: 145.3, height: 71.9 },
			{ left: 304.6, top: 130.0, width: 117.8, height: 87.2 },
			{ left: 442.8, top: 130.0, width: 117.8, height: 87.2 },
			{ left: 581.1, top: 130.0, width: 117.8, height: 87.2 },
			{ left: 719.3, top: 130.0, width: 117.8, height: 87.2 },
			{ left: 857.6, top: 130.0, width: 117.8, height: 87.2 },
			{ left: 304.6, top: 271.4, width: 117.8, height: 87.2 },
			{ left: 22.0, top: 309.0, width: 665.6, height: 30.0 },
			{ left: 1112.0, top: 16.0, width: 148.0, height: 101.0 },
			{ left: 1038.4, top: 301.0, width: 221.6, height: 40.0 },
			{ left: 20.0, top: 65.0, width: 0.0, height: 0.0 },
			{ left: 0.0, top: -17.0, width: 1280.0, height: 76.5 },
		];

		const place = () => placeClouds({
			canvas: CANVAS_39,
			obstacles: OBSTACLES,
			clouds: [{ key: "s44", anchor: ANCHOR, size: CLOUD }],
		}).get("s44")!;

		it("clears card #102's Completed stamp now the preview is shorter", () => {
			// The whole point of the shortened preview: at 66.7 tall the only box within
			// reach of the card clipped 48% of a neighbour's status stamp; at 51.1 there
			// is a clean one, still touching its own card.
			const before = placeClouds({
				canvas: CANVAS_39, obstacles: OBSTACLES,
				clouds: [{ key: "b", anchor: ANCHOR, size: CLOUD_BEFORE }],
			}).get("b")!;
			expect(before.overlap).toBeGreaterThan(0);
			const now = place();
			expect(now.overlap).toBe(0);
			expect(ANCHOR.y - (now.top + CLOUD.height)).toBeLessThanOrEqual(CLOUD.height * 1.3);
		});

		it("stays attached to its own card rather than taking a clean box far away", () => {
			// A zero-overlap box DOES exist on this canvas — 209px above the card, at
			// the other end of the stage. Taking it would score perfectly and stop
			// being #107's thought, which is the same failure as scoring a cloud
			// pushed off-screen as clean. So the bound wins and the overlap is real.
			const spot = place();
			const gap = ANCHOR.y - (spot.top + CLOUD.height);
			expect(gap).toBeGreaterThanOrEqual(0);
			expect(gap).toBeLessThanOrEqual(CLOUD.height * 1.3);
		});

		it("reports the residual honestly, to the pixel they measured, at the old height", () => {
			// Kept as the record of what was measured on the real stage: 58.9 x 18.5 of
			// card #102, exactly where its Completed stamp sits. Their number and mine
			// agreed, which is what proved the score describes the drawn box.
			const before = placeClouds({
				canvas: CANVAS_39, obstacles: OBSTACLES,
				clouds: [{ key: "b", anchor: ANCHOR, size: CLOUD_BEFORE }],
			}).get("b")!;
			expect(before.overlap).toBe(1090);
		});
	});

		it("reaches a pocket that only an intermediate offset can hit", () => {
			// A corridor 15px wider than the cloud, positioned BETWEEN the offsets a
			// coarse sweep would try. Every other storey and the whole area below are
			// walled off, so this pocket is the only clean box on the canvas — and a
			// sweep of centred/half/full misses it by construction. Verified by
			// mutation: restoring the five-offset sweep fails this test.
			const canvas = { width: 1280, height: 280 };
			const card: Rect = { left: 300, top: 200, width: 100, height: 60 };
			const size = { width: 140, height: 67 };
			const walls: Rect[] = [
				card,
				{ left: 0, top: 0, width: 1280, height: 120 },     // the storey above the corridor
				{ left: 0, top: 120, width: 325, height: 80 },     // corridor, left wall
				{ left: 480, top: 120, width: 800, height: 80 },   // corridor, right wall
				{ left: 0, top: 205, width: 1280, height: 75 },    // everything below
			];
			const placed = placeClouds({ canvas, obstacles: walls, clouds: [cloud("a", card, size)] }).get("a")!;
			expect(placed.overlap).toBe(0);
			expect(placed.left).toBeGreaterThanOrEqual(325);
			expect(placed.left + size.width).toBeLessThanOrEqual(480);
		});

	it("nudges out of the way when the candidate grid misses the pocket", () => {
		// A 2px-wide corridor: wide enough for the cloud, but sitting between two of
		// the grid's offsets, so the grid alone reports "nowhere to go". A non-zero
		// score is what a product decision would rest on, so it has to mean searched
		// and there is nothing — not "my grid was coarse".
		const canvas = { width: 1280, height: 400 };
		const card: Rect = { left: 300, top: 200, width: 100, height: 60 };
		const size = { width: 278, height: 67 };
		const walls: Rect[] = [
			card,
			{ left: 0, top: 0, width: 1280, height: 120 },     // the storey above
			{ left: 0, top: 120, width: 240, height: 60 },     // corridor, left wall
			{ left: 520, top: 120, width: 760, height: 60 },   // corridor, right wall
			{ left: 0, top: 195, width: 1280, height: 205 },   // everything below
		];
		const placed = placeClouds({ canvas, obstacles: walls, clouds: [cloud("a", card, size)] }).get("a")!;
		expect(placed.overlap).toBe(0);
		expect(placed.left).toBeGreaterThanOrEqual(240);
		expect(placed.left + size.width).toBeLessThanOrEqual(520);
	});

	it("refuses a nudge that would carry the cloud away from its card", () => {
		// The escape is bounded by the same sideways limit the grid honours. A cloud
		// that clears every obstacle by leaving its card behind belongs to nothing,
		// so an honest non-zero score is the better answer.
		const canvas = { width: 1280, height: 300 };
		const card: Rect = { left: 100, top: 150, width: 80, height: 50 };
		const size = { width: 200, height: 67 };
		const walls: Rect[] = [
			card,
			{ left: 0, top: 0, width: 700, height: 300 },      // only free space is far right
		];
		const placed = placeClouds({ canvas, obstacles: walls, clouds: [cloud("a", card, size)] }).get("a")!;
		expect(placed.overlap).toBeGreaterThan(0);
		expect(placed.left).toBeLessThan(700);
	});
});
