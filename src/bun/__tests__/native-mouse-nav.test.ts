import { describe, it, expect, vi } from "vitest";

vi.mock("electrobun/bun", () => ({
	PATHS: { VIEWS_FOLDER: "/fake-bundle/Resources/app/views/" },
	Utils: {},
	Updater: {},
}));
vi.mock("bun:ffi", () => ({
	dlopen: vi.fn(),
	FFIType: { function: "function", i32: "i32", void: "void" },
	JSCallback: class {},
}));

import { swipeDirectionToAction } from "../native-mouse-nav";

describe("swipeDirectionToAction", () => {
	it("maps a positive deltaX swipe to Back, like browsers do for Logi mice", () => {
		expect(swipeDirectionToAction(1)).toBe("go-back");
	});

	it("maps a negative deltaX swipe to Forward", () => {
		expect(swipeDirectionToAction(-1)).toBe("go-forward");
	});

	it("ignores a zero direction", () => {
		expect(swipeDirectionToAction(0)).toBeNull();
	});
});
