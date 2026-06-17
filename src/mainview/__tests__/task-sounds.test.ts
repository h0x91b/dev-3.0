import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOUND_DEFS, playTaskSound } from "../task-sounds";

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

// The kanban UI plays the completion sound client-side the instant a card is
// dropped onto completed/cancelled, while the bun process pushes a `taskSound`
// event for the same move a moment later. The dedupe guard must swallow that
// near-simultaneous repeat so the user hears the sound exactly once.
describe("playTaskSound dedupe", () => {
	let playSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		playSpy = vi
			.spyOn(window.HTMLMediaElement.prototype, "play")
			.mockResolvedValue(undefined as unknown as void);
	});

	afterEach(() => {
		playSpy.mockRestore();
		vi.useRealTimers();
	});

	it("plays only once for a repeated status within the dedupe window", async () => {
		await playTaskSound("completed");
		vi.advanceTimersByTime(200);
		await playTaskSound("completed");
		expect(playSpy).toHaveBeenCalledTimes(1);
	});

	it("plays again once the dedupe window has elapsed", async () => {
		await playTaskSound("cancelled");
		vi.advanceTimersByTime(2000);
		await playTaskSound("cancelled");
		expect(playSpy).toHaveBeenCalledTimes(2);
	});

	it("does not swallow the retry when the first playback fails", async () => {
		// Clear any dedupe stamp left by earlier tests (module state persists).
		vi.advanceTimersByTime(2000);
		// First attempt rejects (e.g. autoplay still blocked); it must NOT leave a
		// dedupe stamp behind, or the immediate retry would be silently dropped.
		playSpy.mockRejectedValueOnce(new Error("blocked"));
		await playTaskSound("completed");
		vi.advanceTimersByTime(100);
		await playTaskSound("completed");
		expect(playSpy).toHaveBeenCalledTimes(2);
	});
});
