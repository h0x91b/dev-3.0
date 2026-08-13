# PR origin-task deep link: opt-out setting + review fixes (#1340)

## Context

Follow-ups to the merged PR-deeplink feature ([pr-origin-task-deep-link](pr-origin-task-deep-link.md)),
collected in issue #1340 after review.

## Decision

- **Opt-out setting.** `GlobalSettings.prOriginTaskLink`, default on (only an
  explicit `false` is stored, the same shape as `importShellEnv`). Surfaced as a
  toggle in Global Settings → Behavior (`BehaviorSettingsSection.tsx`). When off,
  `createPullRequest` (`git-operations.ts`) sends the plain PR prompt. The footer
  copy names the escape hatch ("can be turned off in dev3 settings").
- **Single-line handoff prompt.** `createPrAgentPrompt` no longer embeds the
  multi-line markdown block; it describes the `---` divider in words and appends a
  newline-free `buildTaskPrDeepLinkLine`. A newline in a handoff prompt reaches the
  pane as a raw byte and can submit early on agents that treat `\n` as Enter.
- **Setext fix.** `buildTaskPrDeepLinkSection` now begins with a blank line before
  `---`; appended straight after text, `text\n---` is a setext H2, not a rule.
- **Verbatim ids.** `buildTaskWebLink` and `docs/open.html` stop percent-encoding
  the id (ids are UUIDs), so both links in a footer resolve to the identical target.
- **open.html dispatch.** `new-task` is matched before `project` (it is the only
  kind that also reads `project`), and the page has a grammar test guarding the
  `dev3://` prefixes it emits.

## Risks

- The `dev3://` grammar still exists in two source spots (the TS module and the
  hand-written `open.html` script). The new grammar test is a guard, not a
  generator, so a TS-only change could still drift the page — flagged, not closed.

## Alternatives considered

- **A `dev3 task deep-link` CLI** as the single source for the footer (so the skill
  need not restate the grammar). Rejected for now by the task owner in favor of the
  lighter skill-line approach; the URL shape now lives in prose in the skill too.
- **Encoding the id on both sides** instead of dropping it. Equivalent for UUIDs;
  dropping is simpler and needs no decode in `parseDeepLink`.
