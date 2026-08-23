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

5. **Waiting is declared; the ending is an anchor going away.** A step carrying
   `waitsForAnchor` expects its anchor later — the artifact panel exists only once the
   agent publishes a report — so while it is missing the card parks, says it is waiting
   on the agent, and hides its Next; neither the lost state nor a resync fires. The
   last step's anchor disappearing exits as completed, because the merge-completion
   dialog closing is precisely the end of the loop. The `dev-server` step stays manual
   for a related reason: an artifact that arrived while the user was reading the
   terminal step would already be on screen, and auto-advance only fires on
   *appearance*, so it would have hung forever.

**The sandbox launches in a bypass preset.** `Auto` maps to Claude Code's own
`--permission-mode auto` with no `--dangerously-skip-permissions`, so the agent CLI —
not dev3 — stops and asks about ordinary shell commands. Live QA watched exactly that
happen on `rtk ls`: the first task never started, and a first-run user has no basis to
judge the question. `LaunchVariantsModal.makeDefaultVariant` therefore preselects the
first configuration whose `permissionMode === "bypassPermissions"` **when
`project.sandbox`**, falling back to the normal resolution — the user's own global
default is untouched everywhere else, and the mode picker still shows what it picked.

Two more rules came straight out of the live run, and both are about not lying:
while a `waitsForAnchor` step is waiting, **nothing is shielded** — QA caught the agent
asking for permission behind a full-screen shield, with no way to type the answer it
was waiting for — and `click-anchor` on a **disabled** control flashes the ring instead
of pressing it, because `Merge` stays disabled until the agent has committed and a
click that silently does nothing reads as a broken card.

The tour now runs to the actual end of a task: terminal → dev server → the agent's
artifact → the diff → `Merge` → the "branch merged, complete the task?" dialog. Merge
is pressed by the card (`click-anchor`) and dev3's own merge watcher raises that
dialog, so the last step is a real dialog rather than a tour-invented one. The
completion `✓` on the board card is deliberately NOT the ending: it would have walked
the user off the task screen for one click.

The sandbox repo changed shape to serve this: one page (`index.html`) with one green
button, a dependency-free `server.js`, and `devScript: "node server.js"` with
`portCount: 1` on the project, so the dev-server button has something to run. `node`
rather than `python3` or `bun` because a machine with an npm-installed agent CLI has
it, and the file is CommonJS so it runs under either runtime. The first prompt is the
smallest visible change in the repo plus "show them in a dev3 artifact" — the
before/after belongs in the agent's own report, not in tour steps.

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
- **The sandbox's dev server assumes `node` on PATH.** Absent, the dev-server window
  prints a not-found error and the tour's dev-server step points at a button that does
  nothing useful. The step is manual, so nothing hangs — but the sandbox's promise of
  "no toolchain" is now "no toolchain beyond node".
- **The sandbox's bypass preselect is a real bypass.** An agent with no permission
  gate in a throwaway repo is the point, but it is the same machine — a first task
  that goes badly wrong is not confined to the sandbox folder. Accepted because the
  alternative, observed live, is a newcomer staring at a question they cannot answer.
- **The artifact step depends on the agent doing as it is told.** An agent that fixes
  the colour but publishes no artifact leaves the tour parked on a step that can only
  be skipped. The prompt asks for it explicitly, which is a request, not a guarantee.
- **The ending depends on dev3 raising the merge-completion dialog.** A suppressed or
  toast-downgraded prompt (`shouldPrompt === false`, or `manualCompletion`) leaves the
  tour on the merge step with its button re-pressable and Skip as the way out.
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
