import { describe, expect, it } from "vitest";
import { sharedArrivalNoun } from "../sharedArrivalNoun";
import en from "../../i18n/translations/en";

describe("sharedArrivalNoun", () => {
	it("names each show-media batch by what it carried", () => {
		expect(sharedArrivalNoun("video")).toBe("showVideo");
		expect(sharedArrivalNoun("audio")).toBe("showAudio");
		expect(sharedArrivalNoun("media")).toBe("showMedia");
		expect(sharedArrivalNoun("image")).toBe("showImage");
		expect(sharedArrivalNoun(undefined)).toBe("showImage");
	});

	it("points only at keys that exist for both the toast and the badge", () => {
		const keys = en as Record<string, string>;
		for (const kind of ["image", "video", "audio", "media"] as const) {
			const base = sharedArrivalNoun(kind);
			for (const key of [`${base}.toast_one`, `${base}.toast_other`, `${base}.attention_one`, `${base}.attention_other`]) {
				expect(keys[key], key).toBeTruthy();
			}
		}
		expect(keys["showAudio.toast_one"]).toBe("Agent shared an audio clip");
	});
});
