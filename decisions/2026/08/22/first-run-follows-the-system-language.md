# First run follows the system language, and the guess is not persisted

## Context

dev3 is fully translated into Russian and Spanish — 3 128 keys each, with
`TranslationRecord` making a missing key a type error. None of that reached a
newcomer: `readLocale()` returned `"en"` whenever nothing was stored, so a
Russian- or Spanish-speaking user had to already know that Settings → Appearance →
Language existed before they could discover the app spoke their language at all.
The most complete piece of accessibility work in the product was invisible on the
one screen where it mattered most.

## Investigation

Two places decided the initial language and only one of them was going to be
fixed by accident: `I18nProvider`'s `readLocale()`, and a separate inline read in
`main.tsx` that set `<html lang>` from `localStorage.getItem("dev3-locale") ||
"en"`. Left split, a detected Russian UI would have shipped with `lang="en"` —
which is what a screen reader believes.

A sweep of the locale barrels also found user-facing strings that were present in
`ru`/`es` but still held their English text: `launch.failedLaunchHintShell` and
`settings.prOriginTaskLinkUnsupported`. `TranslationRecord` cannot catch this — a
copy-paste of the English string satisfies it.

## Decision

`resolveInitialLocale()` (exported from `src/mainview/i18n/context.tsx`, re-exported
from the barrel) is now the single resolver: a stored choice wins, otherwise
`navigator.languages` is matched on its primary subtag (`ru-RU`, `ru`, `es-419` all
resolve), otherwise English. `main.tsx` sets `<html lang>` through the same
function instead of its own copy.

**The detection is deliberately not written back to storage.** Only an explicit
pick in Settings persists. A guess that persisted would pin a user to whatever
their system said the first time they opened the app, and getting out of it would
require the very setting they could not find.

`i18n/__tests__/untranslated.test.ts` fails on any `ru`/`es` value identical to its
English original, with an allowlist of the cases where identical is correct — agent
prompts, code/URL placeholders, language labels — each carrying its reason. The
prose heuristic strips `{placeholders}` first, because `{price}/M vs {builtin}` is
genuinely the same string in English and Spanish.

## Risks

- A user whose system is Russian but who wants the English UI now has to switch
  once. The reverse — a Russian speaker never finding out the app is translated —
  is the worse failure, and it was the shipped one.
- The macOS **application menu** is still English regardless of locale: it is built
  in the bun process (`application-menu.ts`), which has no access to the renderer's
  locale. A Russian UI under an English menu bar looks half-translated. Not fixed
  here; it needs the locale on the bun side and a translation table there.
- The untranslated guard is a heuristic. A short translation that happens to match
  its English source (a proper noun, a two-word label) passes silently; the ≤20
  character and two-word floors are what keep it from firing on those.

## Alternatives considered

- **Persist the detected locale on first run.** Simpler state, but it turns a guess
  into a stored preference the user never made, and the escape hatch is the setting
  they could not find in the first place.
- **Ask on first run** ("choose your language"). A modal in front of a product
  whose first screen is already an explaining problem, to ask something the OS
  already answered.
- **Detect in `main.tsx` and hand the result to the provider as a prop.** Same
  behaviour, but it leaves two definitions of "which language" — the split that
  caused the `<html lang>` mismatch in the first place.
