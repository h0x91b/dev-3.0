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

	describe("signal quit confirmation (Ctrl+C in `bun run dev`)", () => {
		const makeProc = () => new EventEmitter() as unknown as NodeJS.Process;

		it("marks quit confirmed when SIGINT is delivered", () => {
			const proc = makeProc();
			installSignalQuitConfirmation(proc);
			(proc as unknown as EventEmitter).emit("SIGINT");
			expect(isQuitConfirmed()).toBe(true);
		});

		it("marks quit confirmed when SIGTERM is delivered", () => {
			const proc = makeProc();
			installSignalQuitConfirmation(proc);
			(proc as unknown as EventEmitter).emit("SIGTERM");
			expect(isQuitConfirmed()).toBe(true);
		});

		it("does not confirm before any signal arrives", () => {
			installSignalQuitConfirmation(makeProc());
			expect(isQuitConfirmed()).toBe(false);
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
