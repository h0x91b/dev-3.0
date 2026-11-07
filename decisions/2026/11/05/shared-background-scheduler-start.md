# One shared start path for the background jobs

## Context

The desktop entry (`src/bun/index.ts`) started five clock-driven schedulers and the focus tracker inline. `dev3 remote` boots through `src/bun/headless-entry.ts`, which started only the worktree cleanup scheduler (added directly there by h0x91b/dev-3.0#2191), while comments in `index.ts` and the automations record claimed the rest "run in headless too". On a headless box, automations, "Start in" launches, "Send later" messages and keep-alive never fired, and no focus time was recorded, with no error.

## Decision

`src/bun/background-schedulers.ts` owns `startBackgroundSchedulers()` / `stopBackgroundSchedulers()`, and both entries call them. A new scheduler goes into that module, never into one entry. The worktree cleanup moves out of `headless-entry.ts` into the same call, so each entry starts it exactly once through one path; the #2191 test now checks it there. The focus tracker (`src/bun/focus-tracker.ts`) is in the same call: its inputs, window focus and the active task, arrive through the `setWindowForeground` and `setActiveContext` RPCs, which a browser client sends exactly like the desktop renderer. `src/bun/__tests__/background-schedulers.test.ts` checks that the module starts and stops every `start*Scheduler` / `stop*Scheduler` exported by a `src/bun/*-scheduler.ts` file plus the focus tracker, that neither entry starts a scheduler directly, and that every top-level `start*()` in `index.ts` also runs in `headless-entry.ts` unless it is in the test's `DESKTOP_ONLY` list with a reason.

## Risks

The entry checks read source text, because both entries boot the whole app on import. A start call that is not a top-level statement (for example inside a callback) is invisible to the parity check. The focus tracker's idle gate reads the host's HID idle on macOS only. On a macOS headless box, a user working from a browser gets no focus credit while nobody touches the host's own keyboard and mouse. Linux and Windows report idle as unknown, so there a focused browser tab is credited, the same as the desktop app on those platforms.

## Alternatives considered

Copying the five start calls into `headless-entry.ts` is the smaller diff, but it is the same two-list setup that caused the drift. A single shared boot function for all pollers and monitors would cover more, but those take entry-specific push callbacks and is a bigger refactor than this fix needs.
