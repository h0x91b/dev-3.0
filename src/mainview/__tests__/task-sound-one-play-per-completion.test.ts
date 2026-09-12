/**
 * Counts actual playback, not push routing: how many times a real
 * `HTMLMediaElement.play()` fires for ONE finished task with TWO renderers alive.
 *
 * Each window runs its own copy of `task-sounds`, with its own module state, so
 * a renderer-local Set can never deduplicate against another window — the only
 * place the duplicate can be stopped is the delivery, which is what
 * `src/bun/push-targets.ts` now does. The second case here is the pre-fix
 * behaviour, kept so the count that used to reach the user stays visible.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SoundsModule = typeof import("../task-sounds");

const installedListeners: Array<[string, EventListenerOrEventListenerObject]> = [];
const realAddEventListener = window.addEventListener.bind(window);

/** A second, independent module instance stands in for a second window. */
async function loadRenderer(): Promise<SoundsModule> {
	vi.resetModules();
	return await import("../task-sounds");
}

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

let play: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	installedListeners.length = 0;
	window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: unknown) => {
		installedListeners.push([type, listener]);
		realAddEventListener(type as keyof WindowEventMap, listener as EventListener, opts as AddEventListenerOptions);
	}) as typeof window.addEventListener;
	play = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined as unknown as void);
});

afterEach(() => {
	window.addEventListener = realAddEventListener;
	for (const [type, listener] of installedListeners) window.removeEventListener(type, listener);
	installedListeners.length = 0;
	play.mockRestore();
});

describe("one completion, two renderers", () => {
	it("plays once when the push reaches a single window", async () => {
		const windowA = await loadRenderer();
		const windowB = await loadRenderer();
		expect(windowA).not.toBe(windowB);

		// The backend now delivers `taskSound` to the focused window alone.
		windowA.playTaskSoundFromPush("completed");
		await settle();

		expect(play).toHaveBeenCalledTimes(1);
	});

	it("played twice when the push reached both windows (the reported bug)", async () => {
		const windowA = await loadRenderer();
		const windowB = await loadRenderer();

		windowA.playTaskSoundFromPush("completed");
		windowB.playTaskSoundFromPush("completed");
		await settle();

		expect(
			play.mock.calls.length,
			"Two windows, one completion: this is the duplicate chime the delivery fix removes. " +
				"A renderer-local guard cannot see the other window's module state.",
		).toBe(2);
	});
});
