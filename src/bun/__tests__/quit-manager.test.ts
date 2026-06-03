import { beforeEach, describe, expect, it } from "vitest";
import { __resetQuitConfirmedForTests, isQuitConfirmed, markQuitConfirmed } from "../quit-manager";

describe("quit-manager", () => {
	beforeEach(() => __resetQuitConfirmedForTests());

	it("starts unconfirmed", () => {
		expect(isQuitConfirmed()).toBe(false);
	});

	it("flips to confirmed after markQuitConfirmed", () => {
		markQuitConfirmed();
		expect(isQuitConfirmed()).toBe(true);
	});

	it("stays confirmed (idempotent)", () => {
		markQuitConfirmed();
		markQuitConfirmed();
		expect(isQuitConfirmed()).toBe(true);
	});

	it("resets for tests", () => {
		markQuitConfirmed();
		__resetQuitConfirmedForTests();
		expect(isQuitConfirmed()).toBe(false);
	});
});
