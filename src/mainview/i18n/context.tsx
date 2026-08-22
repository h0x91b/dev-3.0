import {
	createContext,
	useContext,
	useState,
	useCallback,
	type ReactNode,
} from "react";
import type { Locale } from "./types";
import type { TranslationKey } from "./translations/en";
import en from "./translations/en";
import ru from "./translations/ru";
import es from "./translations/es";
import { interpolate, getPluralForm } from "./interpolate";
import { markMissingKey, warnMissingKey } from "./missing-key";

const STORAGE_KEY = "dev3-locale";

const translationSets: Record<Locale, Record<string, string>> = { en, ru, es };

export type TFunction = {
	(key: TranslationKey, vars?: Record<string, string | number>): string;
	plural(
		baseKey: string,
		count: number,
		vars?: Record<string, string | number>,
	): string;
};

interface I18nContextValue {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: TFunction;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** Live snapshot of the provider's `t`, kept for pure non-React modules that
 *  cannot call a hook (see `translate` below). */
let activeT: TFunction | null = null;

/** Locale-aware lookup for pure modules (e.g. `utils/agentPicker.ts`) that
 *  produce user-facing labels but hold no React context. Components must keep
 *  using `useT()`; this falls back to English before the provider mounts. */
export function translate(
	key: TranslationKey,
	vars?: Record<string, string | number>,
): string {
	if (activeT) return activeT(key, vars);
	const template = (en as Record<string, string>)[key];
	if (template === undefined) {
		warnMissingKey(key, "en", "missing");
		return markMissingKey(key);
	}
	return vars ? interpolate(template, vars) : template;
}

function readLocale(): Locale {
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved === "en" || saved === "ru" || saved === "es") return saved;
	return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(readLocale);

	const setLocale = useCallback((next: Locale) => {
		setLocaleState(next);
		localStorage.setItem(STORAGE_KEY, next);
		document.documentElement.lang = next;
	}, []);

	const t = useCallback(
		(key: TranslationKey, vars?: Record<string, string | number>) => {
			const own = translationSets[locale][key];
			if (own !== undefined) return vars ? interpolate(own, vars) : own;

			const fallback = (en as Record<string, string>)[key];
			if (fallback !== undefined) {
				warnMissingKey(key, locale, "fallback-to-en");
				return vars ? interpolate(fallback, vars) : fallback;
			}

			warnMissingKey(key, locale, "missing");
			return markMissingKey(key);
		},
		[locale],
	) as TFunction;

	t.plural = (
		baseKey: string,
		count: number,
		vars?: Record<string, string | number>,
	) => {
		const dict = translationSets[locale];
		const enDict = en as Record<string, string>;
		const form = getPluralForm(count, locale);
		const suffixedKey = `${baseKey}_${form}`;

		const exact = dict[suffixedKey];
		if (exact !== undefined) return interpolate(exact, { count, ...vars });

		// The exact plural form is absent — every remaining branch renders a
		// grammatically wrong or wrong-language string, so say so in dev.
		const sameLocaleOther = dict[`${baseKey}_other`];
		if (sameLocaleOther !== undefined) {
			warnMissingKey(suffixedKey, locale, "wrong-plural-form");
			return interpolate(sameLocaleOther, { count, ...vars });
		}

		const english = enDict[suffixedKey] ?? enDict[`${baseKey}_other`];
		if (english !== undefined) {
			warnMissingKey(suffixedKey, locale, "fallback-to-en");
			return interpolate(english, { count, ...vars });
		}

		warnMissingKey(suffixedKey, locale, "missing");
		return markMissingKey(suffixedKey);
	};

	activeT = t;

	return (
		<I18nContext.Provider value={{ locale, setLocale, t }}>
			{children}
		</I18nContext.Provider>
	);
}

export function useT(): TFunction {
	const ctx = useContext(I18nContext);
	if (!ctx) throw new Error("useT() must be used within <I18nProvider>");
	return ctx.t;
}

export function useLocale(): [Locale, (locale: Locale) => void] {
	const ctx = useContext(I18nContext);
	if (!ctx) throw new Error("useLocale() must be used within <I18nProvider>");
	return [ctx.locale, ctx.setLocale];
}
