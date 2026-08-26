import type { Locale } from "./types";

export function interpolate(
	template: string,
	vars: Record<string, string | number>,
): string {
	return template.replace(/\{(\w+)\}/g, (_, key) =>
		key in vars ? String(vars[key]) : `{${key}}`,
	);
}

/** The suffixes a key may carry; `Intl.PluralRules` picks between them. */
export type PluralForm = Intl.LDMLPluralRule;

const rules = new Map<Locale, Intl.PluralRules>();

/**
 * CLDR decides, not us. The hand-rolled mod-10/mod-100 branch this replaced was
 * byte-identical to `Intl.PluralRules` for en/ru at every integer, and a fourth
 * locale (Polish, Czech, Arabic) would have needed its own branch. Categories a
 * locale has no key for fall through to `_other` in `t.plural`.
 */
export function getPluralForm(count: number, locale: Locale): PluralForm {
	let pr = rules.get(locale);
	if (!pr) {
		pr = new Intl.PluralRules(locale);
		rules.set(locale, pr);
	}
	return pr.select(count);
}
