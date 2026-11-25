import { describe, it, expect, afterEach } from "vitest";
import { isFreshStartMode, shouldOpenLaunchWindowInBackground } from "../fresh-start";

const ORIGINAL = process.env.DEV3_FRESH_START;

afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.DEV3_FRESH_START;
	else process.env.DEV3_FRESH_START = ORIGINAL;
});

describe("isFreshStartMode / shouldOpenLaunchWindowInBackground", () => {
	it("enables fresh-start mode, and a background launch window, only for DEV3_FRESH_START=1 exactly", () => {
		delete process.env.DEV3_FRESH_START;
		expect(isFreshStartMode(), "unset").toBe(false);
		// An ordinary launch still comes to the front.
		expect(shouldOpenLaunchWindowInBackground(), "unset").toBe(false);
		for (const v of ["0", "", "true", "yes", "2"]) {
			process.env.DEV3_FRESH_START = v;
			expect(isFreshStartMode(), v).toBe(false);
		}
		// A dev launch opens minimized in the background.
		process.env.DEV3_FRESH_START = "1";
		expect(isFreshStartMode()).toBe(true);
		expect(shouldOpenLaunchWindowInBackground()).toBe(true);
	});
});
