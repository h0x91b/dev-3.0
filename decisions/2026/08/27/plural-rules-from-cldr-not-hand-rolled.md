# Plural forms come from `Intl.PluralRules`, and `{count}` is plural by default

## Context

`getPluralForm` in `src/mainview/i18n/interpolate.ts` hand-rolled CLDR: a mod-10 /
mod-100 branch for Russian and `count === 1 ? "one" : "other"` for English and
Spanish. It worked, but it was a re-implementation of a table the runtime already
ships, and a fourth locale (Polish, Czech, Arabic) would have needed another
branch written by hand.

The larger problem was that nothing required a count string to be plural at all.
`TranslationRecord` checks that a key is present, never that it agrees with the
number rendered next to it, so flat keys shipped and stayed: the git row said
"1 commits ahead" in English and "1 коммитов позади" in Russian, and the diff
badge in `TaskInfoPanel.tsx` rendered a hardcoded English ternary
(`{n} {n === 1 ? "file" : "files"}`) while the correct `infoPanel.diffFileCount`
plural key already existed two components away.

## Investigation

`Intl.PluralRules` was compared against the hand-rolled function for every
integer 0…2000 plus 10 000 / 100 000 / 1 000 000 / 2 000 000 in all three
locales. Two differences, both in Spanish, both at exact millions where CLDR
returns `many` (`un millón de tareas`) and the old code returned `other`. English
and Russian were byte-identical, including the boundaries the Russian branch
existed for: 1 → `one`, 2 → `few`, 5 → `many`, 11 → `many`, 21 → `one`,
101 → `one`, 111 → `many`, 0 → `many`.

A sweep of every `{count}` value across the three locales found 38 flat keys.
Roughly half were genuinely broken agreement; the rest were counts not attached
to any noun — a parenthetical `(N)`, a ratio `N/M`, an abbreviated unit, the
total in "Pane N of M".

## Decision

`getPluralForm` is now a memoized `Intl.PluralRules(locale).select(count)`
returning `Intl.LDMLPluralRule`, so a new locale needs keys and no code. The
categories a locale has no key for fall through the `_other` branch that
`t.plural` in `src/mainview/i18n/context.tsx` already had, with the existing
`wrong-plural-form` dev warning — which is the honest signal for Spanish `many`.

21 flat keys became plural key sets across `en`/`ru`/`es`, their call sites moved
from `t(...)` to `t.plural(...)`, and the hardcoded ternary now calls the
`infoPanel.diffFileCount` key that already existed.
`connQuality.samplesWithLoss` was restructured to select on the lost-sample
count (`{samples} ({count} lost)`) because that is the number Spanish agrees
with.

`src/mainview/i18n/__tests__/plural-keys.test.ts` is the guard: it fails on a
`{count}` value whose key has no plural suffix, on a form set that misses a
category `Intl.PluralRules` can return for that locale, and on a plural base
present in one locale and absent in another. Deliberately flat keys live in its
`FLAT_COUNT_KEYS` map, each with a reason.

## Risks

- Spanish at exactly 1 000 000 now selects `many`, has no `_many` key, and logs a
  dev warning while rendering the (correct) `_other` string. Unreachable in this
  app, where counts are tasks, files and commits.
- The guard keys on the literal `{count}`. A count passed under another variable
  name — as `connQuality.samplesWithLoss` used to — is invisible to it.
- `Intl.PluralRules` must exist in the runtime. It does in Bun, Node, happy-dom
  and every WebView the app runs in; there is no polyfill and no fallback.

## Alternatives considered

- **Keep the hand-rolled function and just add the missing keys.** Fixes the
  strings, leaves the mechanism that guarantees the next locale is hand-written.
- **`@formatjs/intl-messageformat` / full ICU MessageFormat.** Buys ordinals,
  ranges and gendered `select`. Nothing here needs any of them, and it is a
  dependency plus a message syntax for plain counts.
- **Make `TranslationRecord` require plural suffixes at the type level.** Cannot
  express "this value contains `{count}`" in TypeScript; a test reads the values
  and can.
