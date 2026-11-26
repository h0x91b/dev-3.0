import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createVerifiedQuitGate, type BeforeQuitEvent } from "../verified-quit";

function electrobunQuit(emitter: EventEmitter): boolean {
	const event: BeforeQuitEvent = {};
	emitter.emit("before-quit", event);
	return event.response?.allow !== false;
}

describe("verified desktop quit gate", () => {
	it("synchronously vetoes Electrobun's quit decision and retries after verified cleanup", async () => {
		const emitter = new EventEmitter();
		let releaseCleanup!: () => void;
		const cleanup = vi.fn(() => new Promise<void>((resolve) => { releaseCleanup = resolve; }));
		let allowedQuitCount = 0;
		const quit = () => {
			if (electrobunQuit(emitter)) allowedQuitCount++;
		};
		const gate = createVerifiedQuitGate({ cleanup, retryQuit: quit, onFailure: vi.fn() });
		emitter.on("before-quit", gate);

		quit();
		expect(allowedQuitCount).toBe(0);
		expect(cleanup).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(cleanup).toHaveBeenCalledOnce();

		releaseCleanup();
		await vi.waitFor(() => expect(allowedQuitCount).toBe(1));
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("keeps quit vetoed and reports a failed cleanup without retrying", async () => {
		const emitter = new EventEmitter();
		const failure = new Error("server still alive");
		const onFailure = vi.fn();
		const quitAgain = vi.fn();
		const gate = createVerifiedQuitGate({ cleanup: async () => { throw failure; }, retryQuit: quitAgain, onFailure });
		emitter.on("before-quit", gate);

		expect(electrobunQuit(emitter)).toBe(false);
		await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(failure));
		expect(electrobunQuit(emitter)).toBe(false);
		await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(2));
		expect(quitAgain).not.toHaveBeenCalled();
	});
});
