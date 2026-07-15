import { describe, expect, it } from "vitest";
import en from "../i18n/translations/en";
import es from "../i18n/translations/es";
import ru from "../i18n/translations/ru";
import {
	GLOBAL_SETTINGS_FIELDS,
	LEGACY_SETTINGS_CATEGORY_MAP,
	SETTINGS_CATEGORIES,
	SETTINGS_ENTRIES,
	SETTINGS_GLOBAL_FIELD_EXCLUSIONS,
	filterSettingsEntries,
	groupSettingsEntriesByCategory,
	normalizeSettingsCategoryId,
} from "../settings-registry";

describe("settings registry", () => {
	it("keeps category order and entry ids unique", () => {
		expect(SETTINGS_CATEGORIES.map((category) => category.id)).toEqual([
			"appearance",
			"tasks",
			"terminal",
			"agents",
			"accounts",
			"workspace",
			"system",
		]);
		const ids = SETTINGS_ENTRIES.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("has translated metadata for every entry in every locale", () => {
		for (const entry of SETTINGS_ENTRIES) {
			expect(en, `missing English title for ${entry.id}`).toHaveProperty(entry.titleKey);
			expect(en, `missing English description for ${entry.id}`).toHaveProperty(entry.descriptionKey);
			expect(ru, `missing Russian title for ${entry.id}`).toHaveProperty(entry.titleKey);
			expect(ru, `missing Russian description for ${entry.id}`).toHaveProperty(entry.descriptionKey);
			expect(es, `missing Spanish title for ${entry.id}`).toHaveProperty(entry.titleKey);
			expect(es, `missing Spanish description for ${entry.id}`).toHaveProperty(entry.descriptionKey);
			expect(SETTINGS_CATEGORIES.map((category) => category.id)).toContain(entry.category);
		}
	});

	it("accounts for every GlobalSettings field", () => {
		const registered = new Set<string>(
			SETTINGS_ENTRIES.flatMap((entry) =>
				"globalField" in entry ? [entry.globalField] : [],
			),
		);
		for (const field of GLOBAL_SETTINGS_FIELDS) {
			expect(
				registered.has(field) || SETTINGS_GLOBAL_FIELD_EXCLUSIONS.includes(field as never),
				`${field} needs a registry entry or explicit exclusion`,
			).toBe(true);
		}
	});

	it("maps legacy deep-link vocabulary to current categories", () => {
		expect(LEGACY_SETTINGS_CATEGORY_MAP).toEqual({
			appearance: "appearance",
			behavior: "tasks",
			workspace: "workspace",
			agents: "agents",
			proxy: "system",
			developer: "system",
		});
		expect(normalizeSettingsCategoryId("proxy")).toBe("system");
		expect(normalizeSettingsCategoryId("developer")).toBe("system");
		expect(normalizeSettingsCategoryId()).toBe("appearance");
	});

	it("filters and groups localized entry copy", () => {
		const localized = (dictionary: typeof ru) => (key: keyof typeof ru) => dictionary[key];
		const russianMatches = filterSettingsEntries("скорость", localized(ru));
		expect(russianMatches.map((entry) => entry.id)).toEqual(["terminal-scroll-speed"]);

		const SpanishMatches = filterSettingsEntries("repositorios", localized(es));
		const groups = groupSettingsEntriesByCategory(SpanishMatches);
		expect(groups).toHaveLength(1);
		expect(groups[0].category.id).toBe("workspace");
		expect(groups[0].entries.map((entry) => entry.id)).toContain("clone-directory");
 	});
});
