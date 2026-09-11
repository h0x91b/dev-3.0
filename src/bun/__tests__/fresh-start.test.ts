import { describe, it, expect, afterEach } from "vitest";
import { isFreshStartMode, shouldActivateLaunchWindow } from "../fresh-start";

const ORIGINAL = process.env.DEV3_FRESH_START;

afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.DEV3_FRESH_START;
	else process.env.DEV3_FRESH_START = ORIGINAL;
});

describe("isFreshStartMode", () => {
	it("is false when the env var is unset", () => {
		delete process.env.DEV3_FRESH_START;
		expect(isFreshStartMode()).toBe(false);
	});

	it("is true when DEV3_FRESH_START=1", () => {
		process.env.DEV3_FRESH_START = "1";
		expect(isFreshStartMode()).toBe(true);
	});

	it("is false for any other value (only exact '1' enables it)", () => {
		for (const v of ["0", "", "true", "yes", "2"]) {
			process.env.DEV3_FRESH_START = v;
			expect(isFreshStartMode()).toBe(false);
		}
	});
});

describe("shouldActivateLaunchWindow", () => {
	it("an ordinary launch still comes to the front", () => {
		delete process.env.DEV3_FRESH_START;
		expect(shouldActivateLaunchWindow()).toBe(true);
	});

	it("a dev launch opens without taking foreground", () => {
		process.env.DEV3_FRESH_START = "1";
		expect(shouldActivateLaunchWindow()).toBe(false);
	});
});
