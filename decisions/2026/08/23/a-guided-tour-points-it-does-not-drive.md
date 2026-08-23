# A guided tour owns the screen while a step is open

> **Reversed on the day it landed** — the title of the first version was "a guided tour
> points at real controls; it does not drive them". The question it settled was *may a
> tour take the screen away from the user*, and the first answer was no. One live run
> answered it the other way; see "The reversal" below. The rules here are the current
> ones.

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

## The reversal

The pointing-only version survived one run by its first real user and lost the user
inside ten seconds. Exactly what happened, in order: the tour opened on step one
(ring on `+ New Task`), every other control on the board was still live, and the
`Next` on the card advanced the *tour* while the *app* stood still. Step two then had
no anchor to point at — the Create Task modal was never opened — so the card parked
bottom-centre, and 2.5s later rule 3 fired and the tour was gone. There was no way
back in: the board was no longer empty and a skip had counted as completion.

The second run, on the fixed build, found the other half of the same mistake in
`Back`. From the `launch` step it pointed at `Save & Start` in a Create Task modal
that had already closed, so the tour declared itself lost; `Start over` then pressed
`+ New Task` on top of the still-open Launch dialog, stacking two modals. Rule 4
below is the answer: a tour can drive the app forward but can never rewind it, so it
follows the app instead of guessing.

Three separate rules were wrong, and the same reading is behind all of them: that a
guide must never take the screen. It reads well and it is wrong for a first run — a
user who does not know what a control does cannot be trusted to be the one holding
the sequence together. Arseny's word: *"он ни хрена не блокирует весь UI, хотя должен
на самом деле, чтобы юзер шёл именно строго по шагам"*.

## Decision

`src/mainview/tour.ts` is the registry (steps: `anchor`, copy keys, `advanceOn`,
optional `action` and `effect`), `components/TourOverlay.tsx` the engine, and
`App.tsx` owns the state, because a tour crosses screens and anything mounted
per-screen would unmount mid-step. Five rules, mirrored in bible §5.4b:

1. **A step owns the screen.** Four shield bands leave a hole around the step's own
   control, so that control and the card are the only live things on screen. The
   hole is a real gap in the DOM, so the control receives clicks normally.
2. **The step's button presses the real control** (`action: "click-anchor"` →
   `el.click()`), and a step waiting on a choice only the user can make has no
   button at all. A button that advances the tour without moving the app is the
   exact failure above.
3. **Progress is observed.** A step ends when `[data-tour-anchor="<next>"]` appears.
   Auto-advance arms only after the target has been seen *absent*, or `Back` would
   re-advance on the next tick and be a dead button.
4. **The tour follows the app; it never rewinds it.** `Back` is offered only over a
   step that explained something *and* whose anchor is still measurable — never over
   a step that pressed a control, because that press cannot be undone. A step whose
   screen is gone resyncs to the *furthest* step whose anchor is on screen
   (`resyncTarget`), furthest rather than first because the board's `+ New Task` stays
   measurable under every modal and picking it would drag the user back to step one.
   A lost anchor therefore only survives when nothing at all is on screen: the card
   says it lost the thread and offers leaving, with no restart button, since there is
   provably nowhere to restart to. It recovers on its own if an anchor returns. Out is
   `Skip` or Escape — a stray click can no longer end anything.
5. **Entry and exit are both explicit.** An empty sandbox board starts it on *every*
   visit until it is walked to the end; only reaching the end records
   `completedTours`; afterwards help mode's banner carries "Walk me through the
   first task". A skip no longer counts as done.

The `launch` step is anchored on the whole Launch dialog rather than its variant
rows, because the button that launches sits in the dialog's footer — a hole around
the rows would have shielded the user out of the one control the step is about.

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
- **The shield is a wizard-shaped cage while a step is open.** On the `prompt` step
  the rest of the Create Task form is unreachable, so a user who wanted to pick a
  different agent there must leave the tour first. Deliberate — strict sequencing was
  the requirement — but it is the rule most likely to need a per-step exception, and
  the shape for one already exists (a second declared hole).
- **`click-anchor` presses a real button with real consequences.** On the `start`
  step that button creates a task and starts an agent. The copy says so, but the
  distance between "Do it" and a running agent is one click.
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
- **Keep pointing, and fix only the `Next` button.** Would have left every other
  control live, so the user can still click past a step — the failure was the pair,
  not either half.
- **A full-screen dim with a spotlight.** Tried before the shield and dropped: the
  last two steps ask the user to *read* the terminal and the git bar, and dimming the
  thing being explained is self-defeating. The shield dims what is *not* the step,
  which is the same idea aimed the other way.
- **Block the sandbox on `installed` alone.** One less probe, and it lets the exact
  failure this gate exists to prevent straight through.
