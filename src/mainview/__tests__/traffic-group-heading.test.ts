import { describe, expect, it } from "vitest";
import {
	headingRoom,
	headingTop,
	headingWidth,
} from "../components/agent-traffic/group-heading";
import { SCENE_PAD_Y } from "../components/agent-traffic/traffic-camera";
import { CARD_WIDTH } from "../components/agent-traffic/nodes-layout";

describe("headingTop", () => {
	it("hangs the name above the frame at every zoom", () => {
		for (const scale of [0.1, 0.14, 0.36, 0.7, 1, 2.2]) {
			expect(headingTop(scale)).toBeLessThan(0);
		}
	});

	it("keeps the same 22px gap on screen while there is room for it", () => {
		expect(headingTop(1)).toBe(-22);
		expect(headingTop(0.5) * 0.5).toBe(-22);
	});

	it("never rises above the padding the scene bounds reserve", () => {
		// Beyond it the camera clamp cuts the name off at the top of the viewport.
		expect(headingTop(0.14)).toBe(-SCENE_PAD_Y);
		expect(headingTop(0.05)).toBe(-SCENE_PAD_Y);
	});
});

describe("headingWidth", () => {
	it("tracks the group while the group is wide enough on screen", () => {
		expect(headingWidth(600, 1)).toBe(552);
	});

	it("stays readable when the group shrinks to a few pixels", () => {
		// A 300-wide group at 14% is 42px on screen — "rts-do…" and nothing more.
		expect(headingWidth(CARD_WIDTH, 0.14)).toBe(150);
	});

	it("never reaches the next project's name", () => {
		// Two groups 524 scene units apart at 14%: 73px on screen, so the 150px
		// minimum would run straight through the neighbour's name.
		expect(headingWidth(364, 0.14, 524)).toBeLessThan(524 * 0.14);
		expect(headingWidth(364, 0.14, 524)).toBeGreaterThan(0);
	});

	it("keeps the full width when the neighbour is far away", () => {
		expect(headingWidth(600, 1, 4000)).toBe(552);
		expect(headingWidth(600, 1)).toBe(552);
	});

	it("gives up rather than show a smudge when two groups nearly touch", () => {
		// 200 scene units at 5% leave 10px on screen: less than one word.
		expect(headingWidth(364, 0.05, 200)).toBe(0);
	});

	it("keeps the reported pair of names apart on screen", () => {
		// The screenshot: a one-card project (364 wide) 160 units left of a six-column
		// one, at 14%. Headings sit 24 scene units inside their frame, so on screen
		// the first name may not reach where the second one starts.
		const scale = 0.14;
		const narrow = { x: 0, y: 0, width: 364, height: 500 };
		const wide = { x: 524, y: 0, width: 2060, height: 2600 };
		const room = headingRoom(narrow, [narrow, wide]);
		const right = (narrow.x + 24) * scale + headingWidth(narrow.width, scale, room);
		expect(right).toBeLessThan((wide.x + 24) * scale);
	});

	it("never asks for more room than it was given", () => {
		for (const scale of [0.05, 0.14, 0.36, 0.7, 1, 2.2])
			for (const room of [200, 524, 900, 2400]) {
				const width = headingWidth(364, scale, room);
				expect(width).toBeLessThanOrEqual(Math.max(0, room * scale - 14));
			}
	});
});

describe("headingRoom", () => {
	const row = [
		{ x: 0, y: 0, width: 364, height: 500 },
		{ x: 524, y: 0, width: 1700, height: 900 },
	];

	it("measures to the next group standing on the same band", () => {
		expect(headingRoom(row[0], row)).toBe(524);
	});

	it("is unbounded for the last group on its band", () => {
		expect(headingRoom(row[1], row)).toBe(Number.POSITIVE_INFINITY);
	});

	it("ignores a group on another row, however wide it is", () => {
		const below = { x: 100, y: 1200, width: 2000, height: 600 };
		expect(headingRoom(row[0], [...row, below])).toBe(524);
		expect(headingRoom(row[1], [...row, below])).toBe(Number.POSITIVE_INFINITY);
	});

	it("takes the nearest of several groups to the right", () => {
		const third = { x: 700, y: 0, width: 300, height: 400 };
		expect(headingRoom(row[0], [...row, third])).toBe(524);
		expect(headingRoom(row[0], [row[0], third])).toBe(700);
	});
});
