import { describe, it, expect } from "vitest";
import { normalizeWindowName, WINDOW_NAME_MAX } from "../../shared/window-name";

describe("normalizeWindowName", () => {
	it("trims and flattens whitespace and control characters", () => {
		expect(normalizeWindowName("  Dev\tserver\n\u0007logs  ")).toBe("Dev server logs");
	});

	it("blank input means automatic naming", () => {
		expect(normalizeWindowName(" \t\n ")).toBe("");
	});

	it("caps the length by code point, never splitting an emoji", () => {
		const name = normalizeWindowName("🚀".repeat(WINDOW_NAME_MAX + 5));
		expect([...name]).toHaveLength(WINDOW_NAME_MAX);
	});
});
