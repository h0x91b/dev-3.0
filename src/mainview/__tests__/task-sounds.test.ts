import { describe, expect, it } from "vitest";
import { SOUND_DEFS } from "../task-sounds";

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
