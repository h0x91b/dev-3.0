import { describe, it, expect } from "vitest";
import { countryForTimezone, currentTimezone, timezoneCountryMap } from "../../shared/timezone-country";

describe("timezone → country", () => {
	it("covers the whole world, not a handful of zones", () => {
		expect(timezoneCountryMap().size).toBeGreaterThan(400);
	});

	it("resolves the countries this exists to tell apart", () => {
		expect(countryForTimezone("Asia/Jerusalem")).toBe("IL");
		expect(countryForTimezone("Europe/Moscow")).toBe("RU");
		expect(countryForTimezone("America/New_York")).toBe("US");
		expect(countryForTimezone("America/Los_Angeles")).toBe("US");
		expect(countryForTimezone("Europe/Berlin")).toBe("DE");
	});

	// CLDR answers with the legacy spellings; newer ICU builds are moving to the
	// canonical IANA ones. Both must work, or a country vanishes on a browser update.
	it("resolves both the legacy and the modern spelling of a renamed zone", () => {
		expect(countryForTimezone("Asia/Calcutta")).toBe("IN");
		expect(countryForTimezone("Asia/Kolkata")).toBe("IN");
		expect(countryForTimezone("Europe/Kiev")).toBe("UA");
		expect(countryForTimezone("Europe/Kyiv")).toBe("UA");
		expect(countryForTimezone("America/Godthab")).toBe("GL");
		expect(countryForTimezone("America/Nuuk")).toBe("GL");
	});

	// A wrong country is worse than none: an unmapped zone must come back empty so
	// the field is omitted rather than guessed.
	it("returns empty for a zone it cannot place", () => {
		expect(countryForTimezone("UTC")).toBe("");
		expect(countryForTimezone("Etc/GMT+3")).toBe("");
		expect(countryForTimezone("Mars/Olympus")).toBe("");
		expect(countryForTimezone("")).toBe("");
	});

	it("never returns anything but a two-letter region", () => {
		for (const region of timezoneCountryMap().values()) expect(region).toMatch(/^[A-Z]{2}$/);
	});

	// The table has to answer for whatever THIS engine reports, and the test suite
	// runs on node, whose Intl lacks the lookup the table was generated from.
	it("places every zone this runtime knows about, bar the country-less ones", () => {
		const zones = (Intl as unknown as { supportedValuesOf: (k: string) => string[] })
			.supportedValuesOf("timeZone");
		const unplaced = zones.filter(
			(zone) => !zone.startsWith("Etc/") && zone !== "UTC" && !countryForTimezone(zone),
		);
		expect(unplaced).toEqual([]);
	});

	it("reads the machine's own zone without throwing", () => {
		expect(typeof currentTimezone()).toBe("string");
	});
});
