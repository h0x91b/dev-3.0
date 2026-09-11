import { describe, expect, it } from "vitest";
import {
	placeSpeaker,
	SPEAKER_GAP,
	SPEAKER_HEIGHT,
	SPEAKER_WIDTH,
	type SpeakerRect,
} from "../components/agent-traffic/speaker-placement";

const card = (x: number, y: number, width = 300, height = 234): SpeakerRect => ({ x, y, width, height });

const overlaps = (a: SpeakerRect, b: SpeakerRect) =>
	a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("placeSpeaker", () => {
	it("stands the pair over the card they wrote to when that space is free", () => {
		const recipient = card(600, 800);
		const spot = placeSpeaker(recipient, [recipient]);
		expect(spot.natural).toBe(true);
		expect(spot.tether).toBeUndefined();
		// Centred on the card, feet a gap above its top edge.
		expect(spot.x + spot.width / 2).toBe(recipient.x + recipient.width / 2);
		expect(spot.y + spot.height).toBe(recipient.y - SPEAKER_GAP);
	});

	it("moves the pair off a card that stands where they would have stood", () => {
		// The screenshot case: a coordinator above the grid, the person writing to a
		// card in the top row directly under it.
		const recipient = card(600, 800);
		const coordinator = card(560, 460, 370, 234);
		const spot = placeSpeaker(recipient, [recipient, coordinator]);
		expect(spot.natural).toBe(false);
		expect(overlaps(spot, coordinator)).toBe(false);
		expect(overlaps(spot, recipient)).toBe(false);
	});

	it("draws a tether between the displaced pair and the recipient", () => {
		const recipient = card(600, 800);
		const spot = placeSpeaker(recipient, [recipient, card(560, 460, 370, 234)]);
		const tether = spot.tether!;
		expect(tether).toBeDefined();
		// It leaves the person themselves — the middle of the box, not its corner —
		// and lands on the recipient's own edge.
		expect(tether.from.x).toBe(spot.x + spot.width / 2);
		expect(tether.to.x).toBeGreaterThanOrEqual(recipient.x);
		expect(tether.to.x).toBeLessThanOrEqual(recipient.x + recipient.width);
		expect(tether.to.y).toBeGreaterThanOrEqual(recipient.y);
		expect(tether.to.y).toBeLessThanOrEqual(recipient.y + recipient.height);
		const run = Math.hypot(tether.to.x - tether.from.x, tether.to.y - tether.from.y);
		expect(run).toBeLessThanOrEqual(SPEAKER_WIDTH);
	});

	it("keeps clear of every card in a dense grid, not only the one above", () => {
		// Four neighbours in a row plus a coordinator over the middle: the only free
		// air is to the side, and the pair has to find it.
		const recipient = card(600, 800);
		const cards = [
			card(0, 800), card(300, 800), recipient, card(900, 800), card(1200, 800),
			card(560, 500, 370, 234),
		];
		const spot = placeSpeaker(recipient, cards);
		for (const other of cards) expect(overlaps(spot, other)).toBe(false);
	});

	it("follows the recipient when replay reorders the grid", () => {
		// Same message, same cards, different order: the pair belongs to whichever
		// card holds the recipient now, not to where it stood a step ago.
		const first = card(300, 800);
		const second = card(900, 800);
		expect(placeSpeaker(first, [first, second]).x).toBeLessThan(
			placeSpeaker(second, [first, second]).x,
		);
	});

	it("reserves the pair's real footprint, bubble included", () => {
		const spot = placeSpeaker(card(0, 600), []);
		expect(spot.width).toBe(SPEAKER_WIDTH);
		expect(spot.height).toBe(SPEAKER_HEIGHT);
	});

	it("takes the least covered spot rather than none when the stage is full", () => {
		// Boxed in on every side. There is no clean answer, and refusing to draw the
		// person would be worse than drawing them somewhere legible-ish with a tether.
		const recipient = card(600, 800);
		const walls = [
			recipient,
			card(600, 400, 300, 380),
			card(100, 700, 480, 400),
			card(920, 700, 480, 400),
			card(600, 1052, 300, 380),
		];
		const spot = placeSpeaker(recipient, walls);
		expect(spot.natural).toBe(false);
		expect(spot.tether).toBeDefined();
		expect(overlaps(spot, recipient)).toBe(false);
	});
});
