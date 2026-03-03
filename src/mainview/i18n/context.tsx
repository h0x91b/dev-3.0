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
			const dict = translationSets[locale];
			const template = dict[key] ?? en[key] ?? key;
			return vars ? interpolate(template, vars) : template;
		},
		[locale],
	) as TFunction;

	t.plural = (
		baseKey: string,
		count: number,
		vars?: Record<string, string | number>,
	) => {
		const dict = translationSets[locale];
		const form = getPluralForm(count, locale);
		const suffixedKey = `${baseKey}_${form}`;
		const template =
			dict[suffixedKey] ??
			dict[`${baseKey}_other`] ??
			(en as Record<string, string>)[suffixedKey] ??
			(en as Record<string, string>)[`${baseKey}_other`] ??
			baseKey;
		const mergedVars = { count, ...vars };
		return interpolate(template, mergedVars);
	};

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
