/** Renders an unresolved key so the hole reads as a hole rather than as copy.
 *  U+27E6/27E7 appear in no translation string, and `t()` returns a plain string
 *  (it feeds aria-label, title and toasts), so the marker has to be characters —
 *  a colour token is not reachable from here. */
export function markMissingKey(key: string): string {
	return `⟦${key}⟧`;
}

type MissingReason = "missing" | "fallback-to-en" | "wrong-plural-form";

const warned = new Set<string>();

/** Dev-only, once per locale+key: a hole that resolves to English is invisible
 *  on screen by design, so the console is the only place it can surface. */
export function warnMissingKey(
	key: string,
	locale: string,
	reason: MissingReason,
): void {
	if (!import.meta.env.DEV) return;
	const seen = `${locale}:${key}:${reason}`;
	if (warned.has(seen)) return;
	warned.add(seen);
	const detail =
		reason === "missing"
			? "not found in any locale"
			: reason === "wrong-plural-form"
				? `absent from "${locale}", showing its _other form instead`
				: `not found in "${locale}", showing the English string`;
	console.warn(`[i18n] "${key}" ${detail}`);
}
