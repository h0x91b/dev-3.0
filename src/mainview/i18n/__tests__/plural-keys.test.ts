/**
 * A count next to a noun needs plural forms, and nothing enforced that.
 *
 * `TranslationRecord` checks that a key exists, never that it agrees with the
 * number it renders. So `"{count} commits ahead"` shipped as a flat key and the
 * git row said "1 commits ahead" in English and "1 коммитов позади" in Russian
 * for as long as the string existed. This guard makes the flat case a deliberate,
 * reviewed decision instead of the default.
 */
import { ALL_LOCALES, type Locale } from "../types";
import { getPluralForm } from "../interpolate";
import en from "../translations/en";
import ru from "../translations/ru";
import es from "../translations/es";

const SETS: Record<Locale, Record<string, string>> = { en, ru, es };

/** Every category `Intl.PluralRules` can hand this locale for an integer count. */
function categoriesFor(locale: Locale): Set<string> {
	const seen = new Set<string>();
	for (let n = 0; n <= 1000; n++) seen.add(getPluralForm(n, locale));
	return seen;
}

/**
 * Keys that carry `{count}` and are deliberately flat. Each needs a reason —
 * "it looked fine" is exactly what let the broken ones through.
 */
const FLAT_COUNT_KEYS: Record<string, string> = {
	"kanban.showMore": "count sits alone in parentheses, attached to no noun",
	"labels.moreLabels": "'+N more' — the noun is elided in every locale",
	"customColumns.charCount": "a ratio, {count}/{max}",
	"activity.summaryCustom": "'{count} × {label}' — a multiplication sign, not grammar",
	"activity.secondsAgo": "abbreviated unit, '5s ago'",
	"activity.minutesAgo": "abbreviated unit",
	"activity.hoursAgo": "abbreviated unit",
	"activity.daysAgo": "abbreviated unit",
	"activity.monthsAgo": "abbreviated unit",
	"activity.yearsAgo": "abbreviated unit",
	"artifactViewer.versionOf": "count is the total in 'Version N of M', never a subject",
	"nativePaneLab.pager": "count is the total in 'Pane N of M'",
	"infoPanel.prShowResolved": "count sits alone in parentheses",
	"updateSim.windowFiles": "count sits alone in parentheses",
	"task.hibernateConfirmMulti":
		"only rendered when the task has 2+ panes, so every locale's wording is already its plural form",
};

describe("plural keys", () => {
	it.each(ALL_LOCALES)("%s: every {count} string is plural or allow-listed", (locale) => {
		const offenders = Object.entries(SETS[locale])
			.filter(([, value]) => value.includes("{count}"))
			.map(([key]) => key)
			.filter((key) => !/_(zero|one|two|few|many|other)$/.test(key))
			.filter((key) => !(key in FLAT_COUNT_KEYS));

		expect(offenders, "add plural suffixes, or an entry with a reason in FLAT_COUNT_KEYS").toEqual([]);
	});

	it.each(ALL_LOCALES)("%s: every plural key set covers the locale's CLDR categories", (locale) => {
		const required = categoriesFor(locale);
		const bases = new Map<string, Set<string>>();
		for (const key of Object.keys(SETS[locale])) {
			const match = key.match(/^(.*)_(zero|one|two|few|many|other)$/);
			if (!match) continue;
			const forms = bases.get(match[1]) ?? new Set<string>();
			forms.add(match[2]);
			bases.set(match[1], forms);
		}

		const incomplete = [...bases]
			.map(([base, forms]) => [base, [...required].filter((form) => !forms.has(form))] as const)
			.filter(([, missing]) => missing.length > 0)
			.map(([base, missing]) => `${base}: missing ${missing.join(", ")}`);

		expect(incomplete).toEqual([]);
	});

	it("keeps the same plural bases in every locale", () => {
		const basesOf = (dict: Record<string, string>) =>
			new Set(
				Object.keys(dict)
					.map((key) => key.match(/^(.*)_(zero|one|two|few|many|other)$/)?.[1])
					.filter((base): base is string => base !== undefined),
			);

		const source = basesOf(en);
		for (const locale of ALL_LOCALES) {
			const own = basesOf(SETS[locale]);
			expect([...source].filter((base) => !own.has(base)), `${locale} is missing plural bases`).toEqual([]);
			expect([...own].filter((base) => !source.has(base)), `${locale} has plural bases en does not`).toEqual([]);
		}
	});
});
