import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import {
	__resetQuitConfirmedForTests,
	consumeQuitDialogPending,
	installSignalQuitConfirmation,
	isQuitConfirmed,
	markQuitConfirmed,
	markQuitDialogPending,
} from "../quit-manager";

describe("quit-manager", () => {
	beforeEach(() => __resetQuitConfirmedForTests());

	it("starts unconfirmed, confirms idempotently, and resets for tests", () => {
		expect(isQuitConfirmed()).toBe(false);
		markQuitConfirmed();
		markQuitConfirmed();
		expect(isQuitConfirmed()).toBe(true);
		__resetQuitConfirmedForTests();
		expect(isQuitConfirmed()).toBe(false);
	});

	describe("quit dialog pending flag", () => {
		it("starts not pending, returns true once after markQuitDialogPending, and is cleared by the test reset", () => {
			expect(consumeQuitDialogPending()).toBe(false);
			markQuitDialogPending();
			expect(consumeQuitDialogPending()).toBe(true);
			// Consumed — second read is false.
			expect(consumeQuitDialogPending()).toBe(false);
			markQuitDialogPending();
			__resetQuitConfirmedForTests();
			expect(consumeQuitDialogPending()).toBe(false);
		});
	});

	describe("signal quit confirmation (Ctrl+C in `bun run dev`)", () => {
		const makeProc = () => new EventEmitter() as unknown as NodeJS.Process;

		it.each(["SIGINT", "SIGTERM"])("marks quit confirmed only once %s is delivered", (signal) => {
			const proc = makeProc();
			installSignalQuitConfirmation(proc);
			expect(isQuitConfirmed()).toBe(false);
			(proc as unknown as EventEmitter).emit(signal);
			expect(isQuitConfirmed()).toBe(true);
		});

		it("runs before listeners registered earlier (Electrobun's quit handler)", () => {
			// Electrobun's runtime registers its SIGINT listener at import time,
			// before our code runs. That listener synchronously calls Utils.quit(),
			// which hits the before-quit gate — so the confirmed flag must already
			// be set by the time it fires. prependListener guarantees that.
			const proc = makeProc();
			let confirmedWhenQuitRan: boolean | null = null;
			(proc as unknown as EventEmitter).on("SIGINT", () => {
				confirmedWhenQuitRan = isQuitConfirmed();
			});
			installSignalQuitConfirmation(proc);
			(proc as unknown as EventEmitter).emit("SIGINT");
			expect(confirmedWhenQuitRan).toBe(true);
		});
	});
});
