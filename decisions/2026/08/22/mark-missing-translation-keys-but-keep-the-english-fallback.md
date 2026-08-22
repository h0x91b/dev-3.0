# Mark missing translation keys, but keep the English fallback silent on screen

## Context

A missing translation was invisible. `t()` resolved `dict[key] ?? en[key] ?? key`, so a
key absent everywhere rendered its own bare text (`kanban.someKey`) — indistinguishable
from copy — and a key absent only from `ru`/`es` rendered perfect English with no signal
at all. `t.plural` was worse: it fell through to the bare *base* key, dropping the
suffix, so you could not tell which plural form was missing.

## Investigation

`TranslationKey` is `keyof typeof en` and `ru`/`es` are typed
`TranslationRecord & Record<string, string>`, so static `t("literal")` keys are fully
closed by the compiler — a key missing from a locale is a type error. Four holes the
type system cannot see:

- `as TranslationKey` casts on template-literal keys — `settings.family.${family}`
  (`AgentSettingsSection.tsx`), `toast.source.${entry.source}` (`toast.tsx`).
- `t.plural(baseKey: string, …)` — the base key is plain `string`, so all 72 call sites
  are unchecked; a typo compiles.
- Russian `_few`/`_many` keys are not in `TranslationKey` (English has only
  `_one`/`_other`), and the `& Record<string, string>` intersection deliberately admits
  extras — so a missing Russian plural form compiles and silently renders `_other`.
- `ProductivityStatsView.tsx:163` builds a dynamic plural key the same way.

`statusKey`/`statusDescKey` are typed `Record<TaskStatus, TranslationKey>` and are closed.
Nothing ever threw or returned an empty string; interpolation already survived a missing key.

## Decision

`src/mainview/i18n/missing-key.ts` owns both halves, shared by `t()`, `t.plural()` and
`translate()` in `context.tsx`:

- `markMissingKey` wraps an unresolved key as `⟦key⟧` (U+27E6/27E7 — a test asserts those
  code points appear in no translation string). `t()` returns a plain `string` that feeds
  `aria-label`, `title` and toasts, so the marker has to be characters; a design token is
  not reachable from there.
- `t.plural` marks the *resolved suffixed* key (`⟦ports.count_few⟧`), so the missing form
  is named rather than guessed at.
- `warnMissingKey` fires `console.warn` once per locale+key+reason in dev builds only,
  distinguishing `missing`, `fallback-to-en` and `wrong-plural-form`.

**The English fallback stays, and stays invisible on screen.** A key that resolves in
English is still rendered in English for a Russian or Spanish user; only the dev console
says so. Behaviour is identical in dev and production builds — there is no divergence to
reason about, and no shipped build behaves differently from the one you develop against.

## Risks

- A locale-only hole reachable through a cast or a plural suffix remains invisible in a
  production build. Accepted: showing `⟦key⟧` to a Russian user in place of a perfectly
  good English string is a worse product than showing the English string.
- If a hole ever does ship, `⟦…⟧` appears in the UI, including inside `aria-label` text.
  That is the intent — it is louder than copy and quieter than a crash.
- `import.meta.env.DEV` is always `true` under vitest (see `test-setup.ts`), so the warn
  path is exercised by tests but a "quiet in production" claim is not directly testable.
  Nothing depends on it being quiet, since rendering does not branch on the flag.

## Alternatives considered

- **Mark the English fallback too** (`"Add task ⟨en⟩"`). The literal reading of the
  request, and it closes the last hole — rejected for the blast radius on every
  non-English screen in production.

  This one was put twice. It was offered up front as an option and not taken; then, during
  review, the question was re-put with both screen outcomes named explicitly — that taking
  the current route means a key present in English but missing from `ru` renders an
  **unmarked** English string, which the literal request arguably does not permit. It was
  confirmed by endorsing the coordinator's recommendation to keep the current route, not by
  restating the choice, so read the strength of that confirmation accordingly. The reason
  on record is the coordinator's and this author's, not the requester's: brackets around
  live English text in production are noise in front of a real user.
- **Loud in dev, plain key in production.** Rejected: a shipped hole would then be
  invisible to users *and* to us in a release build, and the divergence is untestable
  because vitest always reports `DEV`.
- **Close the holes with types instead of displaying them** — give `t.plural` a derived
  `PluralBaseKey` type and add a Russian `_few`/`_many` parity test. Better engineering,
  but it prevents holes rather than surfacing them, so it does not do what was asked.
  Still worth doing separately; it composes with this change rather than replacing it.
