import { describe, it, expect } from "vitest";
import { createBreadcrumbTrail, BREADCRUMB_LIMIT } from "../terminal-breadcrumbs";

/** A trail on a clock the test owns, so the relative times in the output are exact. */
function makeTrail(limit?: number) {
	let clock = 10_000;
	const trail = createBreadcrumbTrail({ now: () => clock, limit });
	return { trail, advance: (ms: number) => void (clock += ms) };
}

describe("createBreadcrumbTrail", () => {
	it("writes nothing while the terminal is healthy", () => {
		const { trail } = makeTrail();
		expect(trail.format()).toBe("");
		expect(trail.entries()).toBe(0);
	});

	it("reports events oldest first, timed relative to the crash", () => {
		const { trail, advance } = makeTrail();
		trail.note("resize", "158x82");
		advance(2000);
		trail.note("hidden");
		advance(1000);

		expect(trail.format()).toBe("-3.0s resize 158x82 | -1.0s hidden");
	});

	it("collapses a repeated event into a count, so a storm cannot flush the ring", () => {
		const { trail, advance } = makeTrail();
		for (let i = 0; i < 40; i++) {
			trail.note("resize", "158x82");
			advance(100);
		}

		expect(trail.entries()).toBe(1);
		expect(trail.format()).toBe("-4.0s→-0.1s resize 158x82 x40");
	});

	it("keeps a changing sequence as separate events — the shape of a real resize drag", () => {
		const { trail, advance } = makeTrail();
		trail.note("resize", "158x82");
		advance(100);
		trail.note("resize", "146x82");
		advance(100);
		trail.note("resize", "158x82");

		expect(trail.entries()).toBe(3);
		expect(trail.format()).toBe("-0.2s resize 158x82 | -0.1s resize 146x82 | -0.0s resize 158x82");
	});

	it("drops the oldest event once the ring is full", () => {
		const { trail } = makeTrail(3);
		trail.note("a");
		trail.note("b");
		trail.note("c");
		trail.note("d");

		expect(trail.entries()).toBe(3);
		expect(trail.format()).toBe("-0.0s b | -0.0s c | -0.0s d");
	});

	it("defaults to a bounded ring", () => {
		const { trail } = makeTrail();
		for (let i = 0; i < BREADCRUMB_LIMIT * 3; i++) trail.note(`event-${i}`);

		expect(trail.entries()).toBe(BREADCRUMB_LIMIT);
	});

	it("omits the detail when there is none", () => {
		const { trail } = makeTrail();
		trail.note("frame-error");

		expect(trail.format()).toBe("-0.0s frame-error");
	});
});
