/**
 * A key that exists in every locale can still be English in all of them.
 *
 * `TranslationRecord` only enforces that a key is PRESENT, so a copy-paste of the
 * English string satisfies the type system and ships untranslated. Two such
 * strings survived that way — a launch failure hint and a settings explanation —
 * and both were the kind of text a user only ever meets when something is already
 * going wrong.
 */
import en from "../translations/en";
import ru from "../translations/ru";
import es from "../translations/es";

/**
 * Values that are DELIBERATELY the same in every locale. Each entry needs a
 * reason, because the whole point of the guard is that "it looks fine" is what
 * let the real ones through.
 */
const SAME_IN_EVERY_LOCALE = new Set<string>([
	// Prompts copied for an agent to run. Agent-facing text is English everywhere.
	"header.devServerHintPrompt",
	"bugHunters.nextPrompt",
	// Command-palette rows that name a language; the label is the language itself.
	"command.localeRu",
	"command.localeEs",
	// Placeholders that are literal examples of code, a URL or a config line —
	// AGENTS.md forbids translating those.
	"addProject.gitUrlPlaceholder",
	"projectSettings.envVarsPlaceholder",
	"catalog.modelIdPlaceholder",
	"scripts.dropdown.header",
	"scripts.dropdown.headerMake",
]);

/** Long enough, and prose enough, that an identical copy means "not translated". */
function looksLikeUntranslatedProse(value: string): boolean {
	if (value.length <= 20) return false;
	// `{price}/M vs {builtin}` is the same string in English and Spanish and is
	// correct — the words inside the braces are variable names, not prose, so they
	// must not count towards the word tally.
	const words = value.replace(/\{[^}]*\}/g, " ").match(/[A-Za-z]{4,}/g) ?? [];
	// Two or more runs of ≥4 Latin letters: one product name or one code token is
	// not prose, a sentence is.
	return words.length >= 2;
}

describe.each([
	["ru", ru],
	["es", es],
])("%s translations", (name, locale) => {
	it("has no user-facing string left as its English original", () => {
		const untranslated = Object.keys(en).filter((key) => {
			if (SAME_IN_EVERY_LOCALE.has(key)) return false;
			const source = (en as Record<string, string>)[key];
			const target = (locale as Record<string, string>)[key];
			return target === source && looksLikeUntranslatedProse(source);
		});

		expect(
			untranslated,
			`${name} still shows the English text for: ${untranslated.join(", ")}\n` +
				"Fix: translate it. If it is deliberately identical in every locale (an agent prompt, a\n" +
				"code/URL placeholder, a language label), add the key to SAME_IN_EVERY_LOCALE with a reason.",
		).toEqual([]);
	});
});
