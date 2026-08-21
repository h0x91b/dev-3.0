# PSReadLine's shared history faked a cross-session journal leak

**Conclusion first:** the native-session registry never leaked one session's output into
another's journal. On Windows, the second session's own PowerShell drew the FIRST session's
command as PSReadLine ghost text into its own PTY, and the journal recorded that faithfully.
The lifecycle E2E's `bravo journal holds only bravo's output` check was reading a real foreign
byte from a channel that has nothing to do with dev3.

## Context

`src/bun/native-terminal-registry/__tests__/lifecycle.bun-e2e.ts` failed on windows-latest
roughly one run in four with `bravo's journal contains alpha's marker`, and the fixture's own
explanation asserted this could only be registry-side leakage. Because the step had no
`if: always()`, the failure also hid the fourteen proof steps after it, so one flake read as a
broad Windows outage.

## Investigation

The failing run's evidence line showed bravo's journal ending in PSReadLine redraw escapes. New
diagnostics printed the bytes AROUND the foreign marker: bravo's own prompt, the single typed
character `W` in the command colour, then dim + italic (`\e[97m\e[2m\e[3m`) ghost text spelling
out the whole of alpha's command including `ALPHAMARK`, then a cursor jump and the real
`BRAVOMARK` line. That is inline prediction, drawn by bravo's own line editor.

`cross-session-echo-probe.ts` then reproduced it with dev3 entirely absent — two PowerShell
shells on two Bun terminals in one process, no registry, no host, no journal, no fan-out:

| Arm | Conditions | Crossed |
|---|---|---|
| A1 | shared profile, shell two started AFTER shell one's line was accepted | 11 / 12 |
| A2 | shared profile, both shells started up front (what the E2E does) | 1 / 12 |
| B | private `APPDATA`/`LOCALAPPDATA`, A1 conditions | 10 / 12 |

Start order is the intermittency: PSReadLine loads history when the editor starts, so only a
session that started after the other's line was appended can predict it. The real fixture
repeated eight times in the same job went 0 / 8 — which is why no single run ever settled this.

Arm B is a killed control, kept because it is the useful finding: PSReadLine resolves the
per-user history folder through the Windows shell API, so no environment variable moves it. A
`resolveUserHome`-family knob cannot isolate it.

## Decision

The product is unchanged; the fixture stops using a contaminated channel. Every Windows session
in the lifecycle E2E now types `WINDOWS_LINE_EDITOR_QUIET`
(`src/bun/native-terminal-registry/__tests__/command-roundtrip.ts` — `HistorySaveStyle
SaveNothing`, `PredictionSource None`) before any marker exists. The isolation assertion itself
is untouched, and `observeJournal` now prints the bytes around a foreign marker so the two
possible channels are told apart at the byte level instead of asserted about.

Verified by mutation: with `paths.journalFile` made session-blind, the check fails and the new
context shows the marker sitting inside alpha's own frames — channel (1), a real product leak.

Separately, every independent proof step in `.github/workflows/windows-conpty-package.yml` now
carries `if: always()`, so one failure can no longer hide the verdicts after it. Build and
upload steps keep the default: a failed proof must still publish nothing.

## Risks

- The two typed PSReadLine lines are PowerShell-version dependent. They are sent as two separate
  commands so an unknown parameter on an old PSReadLine cannot take the other setting down, and a
  failure prints into the journal rather than breaking the run.
- Other Windows E2Es that assert non-crossing output (multi-pane coordinator, multi-client) share
  the same exposure and were left alone; they have not been observed failing this way.
- The user-facing half is untouched by design: two dev3 tasks on Windows still share one PSReadLine
  history, so one task's shell can suggest another's typed commands. That is the Windows default for
  any two terminals, dev3 overrides nothing on the launch path today, and it is tracked separately.

## Alternatives considered

- **Retry or quarantine the check** — refused; it converts a possible product defect into a
  permanent blind spot.
- **Private `APPDATA` per session** — measured and disproved (arm B, 10 / 12 still crossed).
- **Make the two commands share no prefix** so prediction cannot complete one into the other —
  works only as long as prediction stays prefix-based, and hides the mechanism instead of removing it.
