import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SOUND_DEFS,
	playTaskCompletionSound,
	playTaskSoundFromPush,
	setTaskCompletionSoundEnabled,
} from "../task-sounds";

// Regression guard for the `views://` range-request bug: task sounds must be
// inlined as base64 `data:` URLs (via the `?inline` import suffix), never served
// as separate files through the Electrobun `views://` scheme. WKWebView's media
// loader fetches <audio> sources with a Range request that the scheme handler
// does not satisfy, so a file URL silently fails with `NotSupportedError`.
describe("task sound assets", () => {
	for (const [status, def] of Object.entries(SOUND_DEFS)) {
		it(`serves "${status}" as an inlined data: URL`, () => {
			expect(def.url.startsWith("data:audio/")).toBe(true);
		});
	}
});

// The sound plays in exactly one place per move: UI-initiated moves play it
// locally (and signal `clientPlayedSound` so the backend skips its push), while
// non-UI completions play it from the backend push. `playTaskCompletionSound`
// returns whether the UI owns the sound so the caller can suppress the push —
// this is what prevents the double-play in remote mode (desktop window + browser
// on the same machine both receiving a broadcast push).
describe("completion sound playback", () => {
	let playSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		setTaskCompletionSoundEnabled(true);
		playSpy = vi
			.spyOn(window.HTMLMediaElement.prototype, "play")
			.mockResolvedValue(undefined as unknown as void);
	});

	afterEach(() => {
		playSpy.mockRestore();
	});

	it("plays locally and reports the UI owns the sound when enabled", () => {
		const played = playTaskCompletionSound("completed");
		expect(played).toBe(true);
		expect(playSpy).toHaveBeenCalledTimes(1);
	});

	it("does not play and reports false when the setting is disabled", () => {
		setTaskCompletionSoundEnabled(false);
		const played = playTaskCompletionSound("completed");
		expect(played).toBe(false);
		expect(playSpy).not.toHaveBeenCalled();
	});

	it("plays the backend push (CLI / branch-merge / agent approval)", () => {
		playTaskSoundFromPush("completed");
		expect(playSpy).toHaveBeenCalledTimes(1);
	});

	it("rings for two different tasks completing back-to-back", () => {
		expect(playTaskCompletionSound("completed")).toBe(true);
		expect(playTaskCompletionSound("cancelled")).toBe(true);
		expect(playSpy).toHaveBeenCalledTimes(2);
	});
});

// Desktop Chrome rejects a delayed, programmatic `.play()` on a never-activated
// <audio> element — and the remote `taskSound` push lands seconds after the
// user's "Approve" click. Priming each element inside the first user gesture
// (play/pause) marks it user-activated so the later push-driven play is honored.
// Fresh module instances (resetModules + dynamic import) isolate this global
// unlock/prime state from the shared-state tests above.
describe("audio unlock priming (remote desktop browsers)", () => {
	it("primes both sound templates on the first user gesture", async () => {
		vi.resetModules();
		const playSpy = vi
			.spyOn(window.HTMLMediaElement.prototype, "play")
			.mockResolvedValue(undefined as unknown as void);
		const pauseSpy = vi
			.spyOn(window.HTMLMediaElement.prototype, "pause")
			.mockImplementation(() => {});
		try {
			const mod = await import("../task-sounds");
			mod.initTaskSoundPlayback();
			expect(playSpy).not.toHaveBeenCalled();

			window.dispatchEvent(new Event("pointerdown"));

			// `>=` (not exact): `window` is shared across the static import above and
			// this fresh dynamic instance, so a leaked unlock listener may also fire.
			expect(playSpy.mock.calls.length).toBeGreaterThanOrEqual(Object.keys(mod.SOUND_DEFS).length);
			await Promise.resolve();
			expect(pauseSpy).toHaveBeenCalled();
		} finally {
			playSpy.mockRestore();
			pauseSpy.mockRestore();
		}
	});

	it("reuses one <audio> element per status instead of cloning", async () => {
		vi.resetModules();
		const playSpy = vi
			.spyOn(window.HTMLMediaElement.prototype, "play")
			.mockResolvedValue(undefined as unknown as void);
		try {
			const mod = await import("../task-sounds");
			mod.playTaskSoundFromPush("completed");
			mod.playTaskSoundFromPush("completed");
			expect(playSpy).toHaveBeenCalledTimes(2);
			expect(playSpy.mock.instances[0]).toBe(playSpy.mock.instances[1]);
		} finally {
			playSpy.mockRestore();
		}
	});
});
