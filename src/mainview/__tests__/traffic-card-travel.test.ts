import { act, renderHook } from "@testing-library/react";
import {
	travelArc,
	useCardTravel,
	TRAVEL_MS,
} from "../components/agent-traffic/card-travel";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// dx/dy are where the card starts relative to its new home, so a positive dx
// means the card is travelling left.
it("sends a card heading left over the top and one heading right under the bottom", () => {
	const left = travelArc(400, 0);
	const right = travelArc(-400, 0);
	expect(left.my).toBeLessThan(0);
	expect(right.my).toBeGreaterThan(0);
	expect(left.mx).toBe(200);
	expect(right.mx).toBe(-200);
});

it("sends a card heading up round the left and one heading down round the right", () => {
	expect(travelArc(0, 300).mx).toBeLessThan(0);
	expect(travelArc(0, -300).mx).toBeGreaterThan(0);
});

it("caps how far a very long trip bows out", () => {
	expect(Math.abs(travelArc(4000, 0).my)).toBe(260);
});

it("animates only a card that moved, and alternates the slot so trips restart", () => {
	const { result, rerender } = renderHook(
		({ x, y }) => useCardTravel(x, y, true),
		{ initialProps: { x: 0, y: 0 } },
	);
	expect(result.current).toBeNull();

	rerender({ x: 200, y: 0 });
	expect(result.current?.slot).toBe("a");
	expect(result.current?.style["--travel-x" as keyof typeof result.current.style]).toBe("-200px");

	rerender({ x: 400, y: 0 });
	expect(result.current?.slot).toBe("b");

	// The stage re-renders every frame; a render that moves nothing must leave the
	// trip in flight rather than cancelling it.
	rerender({ x: 400, y: 0 });
	expect(result.current?.slot).toBe("b");

	act(() => void vi.advanceTimersByTime(TRAVEL_MS + 10));
	expect(result.current).toBeNull();
});

it("stays out of the way when motion is off", () => {
	const { result, rerender } = renderHook(
		({ x }) => useCardTravel(x, 0, false),
		{ initialProps: { x: 0 } },
	);
	rerender({ x: 300 });
	expect(result.current).toBeNull();
});
