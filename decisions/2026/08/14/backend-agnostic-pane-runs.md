# Backend-agnostic pane runs, and telling an agent the truth about its terminal

## Context

The injected dev3 skill stated as fact that the agent runs "inside a tmux session managed by
dev-3.0 (socket `dev3`)" and handed it a `tmux -L dev3 …` reference. On a Windows task every word
of that is false: there is no tmux binary, no `dev3` socket and no tmux session — the task runs on
the native terminal backend. The user hit it directly on his own Windows box: he asked his agent to
"run the build in the right-hand pane", the agent loaded `/dev3-tmux`, ran a tmux command and got
nowhere. An agent that believes a false statement about its own environment burns turns proving the
obvious, and this is the second time this programme shipped instructions describing a mechanism
nobody executes.

## Investigation

The app is already backend-neutral underneath: `splitTaskPane` (`src/bun/task-aux-panes.ts`) opens a
pane on whichever backend a task runs, `pane-input.ts` routes typing from the task rather than the
request, and `dev3 peek` reports a pane summary on both backends. Only the AGENT-facing surface was
tmux-shaped.

Reading a pane's OUTPUT was the genuinely blocked half. `TerminalBackend.captureView` exists and the
native adapter implements it fully, but production runs every native host with capture mode `none`,
so every native pane answers `not-enabled`
([read-only-pane-capture-seam](../../08/04/read-only-pane-capture-seam.md)) — measured cost was the
artifact, not the parsing, and activation was deliberately left undecided. So a screen read could
not be the output channel for this story without first deciding activation.

## Decision

A new backend-neutral CLI namespace, one skill text for every platform, and output routed through a
file the pane writes rather than a screen anyone pretends to read.

- **`dev3 pane list | run | logs | close`** (`src/cli/commands/pane.ts` → socket `pane.*` →
  `src/bun/task-pane-runs.ts`), on top of the existing `splitTaskPane`. `list` is how an agent
  DISCOVERS its backend, its own pane (`DEV3_PANE_ID` on native, `TMUX_PANE` on tmux) and whether a
  screen read works here at all — never inferred from the platform, because the native backend is
  not Windows-only.
- **The pane's process is the dev3 CLI itself** (`dev3 __pane-run <dir> <run-id>`,
  `src/cli/commands/pane-exec.ts`). It spawns the command, mirrors every byte to its own stdout (the
  user watches live) and to the run's log (the agent reads later), then records the exit code. No
  `tee`/`Tee-Object` pipeline: those are two programs with two quoting rules and two default
  encodings, and a POSIX-dialect assumption crossing into Windows is precisely the bug class that
  broke the Windows publish leg. The only per-dialect code is `paneRunShell`
  (`src/bun/pane-run-store.ts`): `sh -c` on POSIX; Windows PowerShell 5.1 with an explicit UTF-8
  output encoding (5.1 would otherwise hand a pipe the console code page) and an explicit exit
  epilogue (`powershell -Command` does not propagate a native exit code by itself). The epilogue
  cannot be a bare `exit $LASTEXITCODE`: only NATIVE commands set that variable, so a cmdlet or a
  mistyped command leaves it `$null`, which exits 0 and reads as "the build passed". It captures `$?`
  and `$LASTEXITCODE` first, then falls back to `$?` when the code is absent.
- **Reads are bounded and their outcome is explicit.** Default tail 200 lines, ceiling 2000, and the
  header says when it truncated. The outcome line separates *still running* from *finished, exit
  code N* from *killed by a signal* from *never ran* — a hung build must never read as a failed one.
  Bounded in the APP's memory too, not only in the agent's context: a read maps the last 4 MiB of
  the log rather than the file (`readLogWindow`), because a watcher's log grows without limit and
  `readFileSync` on it would stall the whole app; a count taken from that window prints as `900+`,
  never as the file's line count. A listing reads no log at all and asks the backend for its panes
  ONCE — a lookup per run was a tmux spawn (or a native pane sweep) per run.
- **A run with no pane behind it reads as stopped.** Killing a pane kills its runner mid-write, so
  the status file keeps saying `running` forever; `paneRunOutcomeLine` trusts the pane set over that
  stale file, or `dev3 pane close` followed by `dev3 pane logs` would leave an agent waiting for an
  ending that already happened.
- **Files live in the OS temp directory** under the existing `dev3-<taskId>-…` prefix
  (`paneRunDir`). Not the worktree — a log there would appear in `git status` and in the diff the
  user reviews. Not `~/.dev3.0` — that directory is shared with every other installed version of
  the app, and a run log is per-process scratch with no reason to be durable there; nothing is
  added, renamed or migrated under it.
- **Vocabulary stays disjoint from `dev3 peek`.** Peek reads a pane's SCREEN, for a pane nobody
  promised you; `pane logs` reads a RUN you started. Peek keeps its freshness-granularity honesty,
  and the skill now states the matching limit out loud: screen reads are tmux-only today.
- **The same rule caught a second false platform claim in the same text.** The skill told every
  agent to end a PR description with a `dev3://` origin-task footer, but only the macOS bundle
  registers that scheme (nothing here writes a Windows registry key or a Linux `.desktop` MimeType),
  and the `https` form merely redirects back to it. `skillPrLinkInstruction`
  (`src/shared/agent-skill-content.ts`) now asks `deepLinkSchemeRegistered`
  (`src/shared/deep-link.ts`) and replaces the instruction outright off macOS — publish nothing,
  name the task by its `seq` — rather than softening it. Gated on the capability, not on "is this
  Windows": Linux has no handler either. It reads `process.platform` through a default parameter,
  the house idiom in `src/shared/`, because the app that generates the skill runs on the same
  machine as the agent that reads it.
- **The skill text no longer asserts tmux.** `SKILL_TMUX` became `SKILL_PANES`, `/dev3-tmux` opens
  with a `dev3 pane list` gate before its first tmux command, and a guard test fails if any
  unconditional tmux assertion returns (mutation-verified against four reintroductions).

`DEV3_PANE_RUN_CLI` overrides which dev3 binary a pane launches. It is a dev/test seam, absent from
`--help`: a source checkout cannot otherwise exercise a real pane run without first installing its
binary over the user's.

## Risks

The run's command loses its TTY (it is spawned on pipes so its bytes can go two places), so
interactive TUIs and animated progress bars are out of scope and stdin is closed — documented in the
skill as "non-interactive only". Reading the screen of a pane the agent did NOT start is still
tmux-only; native capture activation remains undecided and this change does not decide it. When the
command ends, the runner holds the pane open until Enter so a finished build stays on screen, which
means an unattended pane lives until `dev3 pane close`. The Windows leg is authored per dialect and
unit-tested, but a dialect is only truly proven by running it on Windows — the acceptance evidence
for this task is a real run on the user's own box, not a macOS run of the same code. The PR-footer
gate keys on the platform, so a future Windows or Linux scheme registration must flip
`deepLinkSchemeRegistered` in the same change or agents there will keep skipping a footer that by
then works.

## Alternatives considered

**A Windows-specific skill variant** driving the native backend directly: rejected — it is a second
way to do one thing, which AGENTS.md forbids, and the programme's direction is tmux out and native
in everywhere, so the fork would have to be unwound later. **Feature-gating** ("panes are not
drivable here, use a background process"): rejected — the capability exists on both backends; only
the agent-facing surface was missing, so honesty alone would have left the user's actual request
unserved. **Activating native screen capture** (threading a capture mode through the neutral
contract so `captureView` works on agent-created panes): rejected for now — it leaks a native-only
concept into a deliberately backend-neutral contract and re-opens a cost decision that was measured
and deferred, while a run log answers the asked question for both backends at zero runtime cost.
**Piping through `tee` / `Tee-Object`**: rejected on the encoding and quoting grounds above.
