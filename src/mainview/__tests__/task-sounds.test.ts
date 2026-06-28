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
