import { describe, expect, it } from "vitest";
import {
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
});
