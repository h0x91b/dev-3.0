# Enable the artifact popup after a session that froze with an artifact open

## Context

On some machines the window stops running JavaScript while an HTML artifact is open in the docked panel. It is
intermittent and nobody has reproduced it on demand; the opt-in tracing of PR #1655 was closed unmerged, so the
app has no span-level record of what the renderer was doing. What does exist is `renderer-watchdog.ts`, which
notices a window that stopped beating, and one workaround the affected user already trusts: opening artifacts as
a popup instead (`openArtifactsInPopup`, default off).

The user asked for that workaround to be applied for them after a freeze, rather than remembered and re-enabled
by hand.

## Investigation

- The renderer cannot report its own freeze — every timer in it is dead too — so the host is the only witness.
  `renderer-watchdog.ts` already judges the silence and logs `heartbeat lost` at 8 s.
- A missing clean-exit marker proves nothing: a force quit, a crash, a power cut and an unrelated kill all look
  the same. It is deliberately not used as a signal.
- The host cannot prove a whole-process freeze. If the bun side wedges too, nothing is written and the freeze
  leaves no record at all. This design detects a frozen RENDERER only, and says so.
- A window close, a reload and a remote tab losing its network are all indistinguishable from silence, which is
  why the renderer now says goodbye on `pagehide` and why only desktop windows produce evidence.

## Decision

Evidence, not proof, at three gates (`src/bun/renderer-watchdog.ts`): 20 s of silence (`FREEZE_EVIDENCE_MS`,
well past the 8 s log line), from a **visible desktop** window that has beaten healthily for 15 s
(`MIN_CLIENT_AGE_MS`), with an artifact mounted or closed within the last 60 s (`ARTIFACT_ASSOCIATION_MS`). A
check that arrives more than three intervals late means the host was suspended too, so that tick judges nobody
and rebases every baseline.

The evidence is written synchronously to `~/.dev3.0/artifact-freeze-recovery.json` — a new file, never a rename
or a rewrite of existing state — because the app may be force-quit seconds later. The renderer contributes only
coarse presence (`artifactOpen`, `artifactIdleMs`): no document, no title, no task id, and nothing leaves the
machine.

At the next launch, before the first window loads, `applyArtifactFreezeRecovery()` consumes at most one piece of
evidence and, if it is credible, turns `openArtifactsInPopup` on and leaves a one-shot notice the renderer shows
as a clickable toast deep-linking to that setting. Consumption happens whatever the verdict, so the recovery is
idempotent: one freeze, one decision. Turning the popup off afterwards records `declinedAt` and ends the
recovery for good.

## Risks

- A renderer crash, or a debugger paused in the renderer, with an artifact open, reads as a freeze. The cost is
  one flipped presentation setting and one toast, and the user can turn it straight back off.
- A machine that sleeps between the watchdog's checks is excused by a tick-lateness heuristic, so a real freeze
  that started just before a suspend is missed. Missing a freeze is the cheap direction.
- Both halves of the popup switch reaching the settings file outside `saveGlobalSettings` (hand-edited JSON)
  would miss `noteArtifactPopupPreference`; the startup path catches that case separately by treating
  "we enabled it, it is off again" as a decline.

## Alternatives considered

- **A separate watchdog process.** It could also see a wedged host, which the in-process watchdog cannot. Not
  worth a new long-lived helper, its lifecycle and its own failure modes for a diagnostic that the existing
  heartbeat already covers for the renderer.
- **Clean-exit marker on quit, treat its absence as a freeze.** Rejected: a force quit alone says nothing about
  artifacts, and this would enable popup mode for every user who ever kills the app.
- **A new "safe artifact mode".** Rejected — the user already has a setting that does exactly this, and a second
  one would compete with it.
- **Asking first, with a dialog.** Rejected: the user explicitly asked for it to be automatic, and a blocking
  dialog on launch is banned for a reversible preference.
