/**
 * Which language a brand-new install opens in.
 *
 * It used to be English for everyone, so a Russian- or Spanish-speaking newcomer
 * had to already know that Settings → Appearance → Language existed before they
 * could find out the app was translated at all.
 */
import { resolveInitialLocale } from "../context";

function setLanguages(languages: string[] | undefined, language?: string) {
	Object.defineProperty(window, "navigator", {
		configurable: true,
		value: { ...window.navigator, languages, language },
	});
}

beforeEach(() => {
	localStorage.clear();
});

describe("resolveInitialLocale", () => {
	it("honours an explicit choice over anything the system asks for", () => {
		localStorage.setItem("dev3-locale", "en");
		setLanguages(["ru-RU", "ru"]);
		expect(resolveInitialLocale()).toBe("en");
	});

	it("ignores a stored value that is not a locale we ship", () => {
		localStorage.setItem("dev3-locale", "klingon");
		setLanguages(["es-ES"]);
		expect(resolveInitialLocale()).toBe("es");
	});

	it.each([
		["ru-RU", "ru"],
		["ru", "ru"],
		["es-419", "es"],
		["EN-GB", "en"],
	])("matches %s on its primary subtag", (tag, expected) => {
		setLanguages([tag]);
		expect(resolveInitialLocale()).toBe(expected);
	});

	it("takes the first language it speaks, in the user's own order", () => {
		// A machine set to Portuguese-then-Spanish should be Spanish, not English.
		setLanguages(["pt-BR", "es-ES", "en-US"]);
		expect(resolveInitialLocale()).toBe("es");
	});

	it("falls back to English for a language we do not ship", () => {
		setLanguages(["de-DE", "fr"]);
		expect(resolveInitialLocale()).toBe("en");
	});

	it("reads navigator.language when the list is unavailable", () => {
		setLanguages(undefined, "ru");
		expect(resolveInitialLocale()).toBe("ru");
	});

	it("survives a navigator that offers no language at all", () => {
		setLanguages(undefined, undefined);
		expect(resolveInitialLocale()).toBe("en");
	});
});
