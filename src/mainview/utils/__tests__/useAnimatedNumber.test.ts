import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAnimatedNumber } from "../useAnimatedNumber";

describe("useAnimatedNumber", () => {
	it("returns the target immediately under reduced motion (test env)", () => {
		// test-setup reports prefers-reduced-motion: reduce → no tween.
		const { result } = renderHook(() => useAnimatedNumber(42));
		expect(result.current).toBe(42);
	});

	it("returns the target when animation is disabled", () => {
		const { result } = renderHook(() => useAnimatedNumber(7, { enabled: false }));
		expect(result.current).toBe(7);
	});
});
