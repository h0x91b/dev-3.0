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

// The UI plays the completion sound client-side the instant a card is dropped,
// while the bun process pushes a `taskSound` echo for the SAME move a moment
// later. The echo is suppressed precisely by task id — not by status+time — so
// the sound is heard exactly once AND two different tasks both ring.
describe("completion-sound echo suppression", () => {
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

	it("swallows the bun echo for a task the UI already played", () => {
		playTaskCompletionSound("completed", "task-A");
		playTaskSoundFromPush("completed", "task-A"); // the echo
		expect(playSpy).toHaveBeenCalledTimes(1);
	});

	it("rings for two different tasks completing back-to-back", () => {
		playTaskCompletionSound("completed", "task-1");
		playTaskCompletionSound("completed", "task-2");
		expect(playSpy).toHaveBeenCalledTimes(2);
	});

	it("swallows a repeated echo (force-retry can emit the push twice)", () => {
		playTaskCompletionSound("completed", "task-R");
		playTaskSoundFromPush("completed", "task-R");
		playTaskSoundFromPush("completed", "task-R");
		expect(playSpy).toHaveBeenCalledTimes(1);
	});

	it("plays a push for a task the UI never played locally (CLI/other window)", () => {
		playTaskSoundFromPush("completed", "remote-task");
		expect(playSpy).toHaveBeenCalledTimes(1);
	});

	it("does not play locally when the setting is disabled", () => {
		setTaskCompletionSoundEnabled(false);
		playTaskCompletionSound("completed", "task-off");
		expect(playSpy).not.toHaveBeenCalled();
	});
});
