# A guided tour points at real controls; it does not drive them

## Context

The sandbox landed a newcomer on a board that was empty, on purpose, with the next
move written only in the repo's `README.md` — a file nobody opens on their first
minute in a new app. Help mode could not fix it: it explains a zone when asked, and
the missing answer was a *sequence* across four surfaces (board → Create Task →
Launch → task screen). Two smaller holes had the same shape: the Create Task modal
never says that its blue primary `Save` does not start anything, and the Launch
dialog never says what a variant is.

## Investigation

Three shapes were on the table. **Pre-creating the task** in the sandbox is the
cheapest and leaves the two modal holes untouched — the user still meets Launch
with no idea what it wants. **Extending help mode** cannot express order: its whole
contract is "you ask about a zone, it answers", and a sequence has no zone. **A
tour** covers all three, and Arseny picked it explicitly, with the standing
requirement that it be reusable for later cases.

The mechanism question was how a step knows the user did the thing. Having each
component report progress would mean editing every participating surface and
keeping call sites in sync forever. Watching the DOM for the next step's anchor
costs one attribute per control and keeps every component ignorant of the tour.

A separate finding decided the gate: `checkAgentAvailability` answers "is the binary
on PATH", which is not "can this run". An installed-but-unauthenticated `claude`
launches, prints a login prompt into a tmux pane, and the task sits there dead —
which is what the sandbox would have handed to the exact user least able to
diagnose it.

## Decision

`src/mainview/tour.ts` is the registry (steps: `anchor`, copy keys, `advanceOn`,
optional `effect`), `components/TourOverlay.tsx` the engine, and
`App.tsx` owns the state, because a tour crosses screens and anything mounted
per-screen would unmount mid-step. Four rules, mirrored in bible §5.4b:

1. **A step points; it never acts.** No backdrop, nothing click-shielded but the
   card itself — the user presses the real button. A `Next` that performs the step
   would teach the wizard instead of the app.
2. **Progress is observed.** A step ends when `[data-tour-anchor="<next>"]` appears.
   Auto-advance arms only after the target has been seen *absent*, or `Back` would
   re-advance on the next tick and be a dead button.
3. **A lost anchor ends the tour** after 2.5s. Every derailment — Escape, `Save`
   instead of `Save & Start`, navigating away — lands here, and a card floating
   over an unrelated screen is worse than no card.
4. **Auto-start once**, from the sandbox board only (`Project.sandbox`, additive),
   and a skip counts as completion (`GlobalSettings.completedTours`).

The prompt the tour prefills lives in `shared/sandbox-prompts.ts`, imported by both
the README seeder and the tour, so the wizard cannot ask for work the repo does not
document. `bun/harness-readiness.ts` gates the sandbox: three-valued sign-in
evidence per CLI, blocking only on a positive "no", so a CLI dev3 has no probe for
is never blocked by dev3's own ignorance.

## Risks

- **The sign-in probes are file heuristics** against five CLIs that owe us no
  stability. A moved credential path reads as `not-signed-in` and sends a working
  user to Settings. Mitigated by the direction of the check (only positive absence
  blocks) and by `unknown` on any read error, but a renamed file is still a false
  block. The reverse — a stale credential file that no longer authenticates — reads
  as signed in, and the user meets the dead task the gate was meant to prevent.
- **The engine polls at 100ms** instead of observing mutations. Cheap, but it means
  a step can advance up to 100ms after the user's click, and the timer runs for as
  long as the tour is open.
- **`data-tour-anchor` is a contract nothing in the app enforces at runtime.** A
  renamed button breaks the tour silently — the card parks bottom-centre and then
  quits, exactly as if the user had walked off. `__tests__/tour.test.ts` scans the
  components for every anchor in both directions, which is the only thing standing
  between a rename and a dead onboarding.
- Ratcheting the `docs/ux` budget again (310 → 313) buys the manifest entry that
  stops the next agent inventing a second walk-through mechanism.

## Alternatives considered

- **Pre-create the sandbox task.** No wizard to build, and the board is no longer
  empty — but the user is then dropped in front of Launch with no idea what it
  wants, and it teaches nothing transferable to their own repo.
- **Prefill only, no guidance.** Solves the "lazy client will not type" half and
  none of the "what do I press" half, which was the actual complaint.
- **Grow help mode into a sequence.** Would have made the master explain-surface
  serve two contracts at once; ordering is exactly what it deliberately lacks.
- **Components report progress to the tour.** Precise, no polling — and every new
  step means editing another component, with call sites that rot invisibly.
- **Block the sandbox on `installed` alone.** One less probe, and it lets the exact
  failure this gate exists to prevent straight through.
