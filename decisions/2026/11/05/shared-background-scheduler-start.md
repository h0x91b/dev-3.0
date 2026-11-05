# One shared start path for the background schedulers

## Context

The desktop entry (`src/bun/index.ts`) started five clock-driven schedulers inline. `dev3 remote` boots through `src/bun/headless-entry.ts`, which started none of them, while comments in `index.ts` and the automations record claimed they "run in headless too". On a headless box, automations, "Start in" launches, "Send later" messages, keep-alive and worktree cleanup never fired, with no error.

## Decision

`src/bun/background-schedulers.ts` owns `startBackgroundSchedulers()` / `stopBackgroundSchedulers()`, and both entries call them. A new scheduler goes into that module, never into one entry. `src/bun/__tests__/background-schedulers.test.ts` checks that the module starts and stops every `start*Scheduler` / `stop*Scheduler` exported by a `src/bun/*-scheduler.ts` file, that neither entry starts a scheduler directly, and that every top-level `start*()` in `index.ts` also runs in `headless-entry.ts` unless it is in the test's `DESKTOP_ONLY` list with a reason.

## Risks

The entry checks read source text, because both entries boot the whole app on import. A start call that is not a top-level statement (for example inside a callback) is invisible to the parity check. The focus tracker stays desktop only: it reads desktop window focus and HID idle, which a headless box does not have.

## Alternatives considered

Copying the five start calls into `headless-entry.ts` is the smaller diff, but it is the same two-list setup that caused the drift. A single shared boot function for all pollers and monitors would cover more, but those take entry-specific push callbacks and is a bigger refactor than this fix needs.
