import { beforeEach, describe, expect, it } from "vitest";
import {
	__resetQuitConfirmedForTests,
	consumeQuitDialogPending,
	isQuitConfirmed,
	markQuitConfirmed,
	markQuitDialogPending,
} from "../quit-manager";

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

	describe("quit dialog pending flag", () => {
		it("starts not pending", () => {
			expect(consumeQuitDialogPending()).toBe(false);
		});

		it("returns true once after markQuitDialogPending, then clears", () => {
			markQuitDialogPending();
			expect(consumeQuitDialogPending()).toBe(true);
			// Consumed — second read is false.
			expect(consumeQuitDialogPending()).toBe(false);
		});

		it("is cleared by the test reset", () => {
			markQuitDialogPending();
			__resetQuitConfirmedForTests();
			expect(consumeQuitDialogPending()).toBe(false);
		});
	});
});
