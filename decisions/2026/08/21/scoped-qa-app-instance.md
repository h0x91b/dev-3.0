# A QA app instance is scoped by redirecting DEV3_HOME, not by suppressing prompts

## Context

An app instance started for browser verification (`bun run dev`, or a task's dev-server)
renders the developer's whole real board. Two vents reported the consequence: another task's
"Branch Merged — mark this task as completed?" approval dialog is live and clickable inside the
agent's own headless browser, and another task's live terminal is reachable by navigation, so a
stray keystroke lands in someone else's agent session. Both times the agent aborted the
verification and shipped the requested UI check as an explicit gap.

A third consumer arrived mid-task: nobody on the team can reach dev3's first-run experience —
no project, no config, nothing — without risking their real data, and that is the next macro-goal.

## Investigation

`DEV3_HOME` named **two different things**, and that is the root of the bug rather than an
oversight. It was a constant in `src/bun/paths.ts` derived from `resolveUserHome()`, which
ignored the environment variable — while exactly three modules honoured the variable, each with
its own inline fallback chain: `native-terminal-registry/paths.ts`, `native-terminal-multipane/paths.ts`,
`prototypes/detached-pty/state.ts`. Setting `DEV3_HOME` therefore produced a *half*-redirected
instance, and every individual file looked correct in isolation.

A second bypass class recomputes the root from `HOME` and honoured the variable nowhere:
`src/cli/context.ts`, `src/cli/spaces.ts`, `src/cli/commands/install-hooks.ts`. The CLI is a
separate process, so without it a scoped app instance is only half isolated — any `dev3` command
run inside that session still resolves the user's real board.

## Decision

One source: `resolveDev3Home()` in `src/shared/dev3-home.ts` — `shared/`, because the app, the
CLI and the native host must agree. `src/bun/paths.ts` builds its `DEV3_HOME` constant from it,
and all three env-honouring modules plus the three CLI modules call it.

**The name collision is kept, not renamed.** The constant and the variable now mean exactly the
same thing, so reading either one is correct — which is the least surprising state available, and
a rename would churn 40 importers for nothing. The next reader is protected by a tripwire instead:
`src/bun/__tests__/dev3-home-single-source.test.ts` fails when a module composes the root from a
user home itself, with a reasoned allowlist for the cases that legitimately want the real home
(the installed CLI binary, the tmux shim, the user's own `~/.codex` and `~/.claude` config).

`bun run dev --qa[=seeded|virgin]` (or `DEV3_QA_SCOPE`) points the launched app at a throwaway
root under the OS temp dir (`scripts/qa-scope.ts`). `seeded` writes one throwaway git project and
no tasks; `virgin` writes nothing, which is the state a brand-new user is in. Opt-in only — the
plain `bun run dev` keeps showing the real board.

**The redirect is not a migration.** Nothing under the real `~/.dev3.0` is read, renamed, moved or
deleted; a scoped instance simply writes elsewhere. `projectSlug()` is untouched, and
`src/cli/context.ts` keeps recomputing the slug inline exactly as before, so AGENTS.md on-disk
invariants 1–5 all hold. Only `DEV3_HOME` and `DEV3_LOG_DIR` are redirected: `HOME` stays real,
because the agent's own `dev3` CLI, git and module resolution read it.

`configureTestIsolation` in `test-isolation.ts` stopped setting `DEV3_HOME`. It sets the sandbox
`HOME`, from which the root is now derived, so the override was a redundant second source — and a
harmful one: it OUTRANKED the `process.env.HOME = fixtureHome` that a dozen suites use to relocate
the board, so they read the shared run root instead of their own fixture (43 failures across nine
files, all fixed by that one deletion).

## Risks

**Read this before trusting the scoping: a scoped QA instance is NOT safe to hand a task that runs
`dev3` CLI commands from a real worktree.** `detectFromWorktreePath` Strategy 2 derives the data
root from the cwd path, so such a command reaches the real app and can act on real tasks whatever
`$DEV3_HOME` says. The browser-facing threats are closed; this one is not.

**What a scoped instance does NOT isolate.** Stated as a list rather than left to silence, because
"scoped" reads as complete:

| Leak | Why the home redirect cannot reach it | Closed here? |
|---|---|---|
| The tmux socket directory | tmux honours only `TMUX_TMPDIR`, which dev3 sets nowhere | **No** — follow-up |
| The PowerShell history file (Windows) | PSReadLine resolves the per-user folder through the Windows shell API; measured — private `APPDATA`/`LOCALAPPDATA` still crossed in 10 of 12 rounds (Seq 1550) | **No** — its own task |
| The `dev3` CLI, a separate process | It recomputed the root from `HOME` itself | **Partly.** `src/cli/context.ts`, `spaces.ts` and `install-hooks.ts` now share `resolveDev3Home()`, so the sockets dir, `projects.json`, `spaces.json` and the worktrees root follow the redirect — measured: `discoverSocket()` returns the scoped instance's socket. But `detectFromWorktreePath` Strategy 2 derives the home from the **cwd path** by design (the Codex sandbox rewrites `HOME`), so an agent running `dev3` from inside a REAL worktree still reaches the real app whatever `$DEV3_HOME` says |
| The user's own `~/.codex` / `~/.claude` agent configs | Written from `homedir()`, not from the data root | **No**, and unchanged by this work |

- **A scoped instance still shares the tmux socket directory** with the real app. tmux honours
  only `TMUX_TMPDIR`, which nothing in dev3 sets, so sockets are still minted into the shared
  system dir. The UI cannot reach another task (no task record exists in a scoped board), but the
  underlying tmux server is one namespace. Handed back as a follow-up: setting `TMUX_TMPDIR`
  requires every tmux invocation to agree or a client looks in the wrong dir and sees no server.
- **The agent-config writes still target the real home** — `agents.ts`, `codex-config.ts` and
  `agent-skills.ts` grant the real worktrees/sockets paths inside the user's own
  `~/.codex/config.toml` and `~/.claude/settings.json`. Unchanged by this work (they read
  `homedir()`, not the redirect), so no new harm; the cost is that a Codex agent launched inside a
  scoped instance is not pre-trusted.
- `scripts/dev-web-code.ts` reads the web access code from the real home by design, so the agent
  and the scoped app agree on the token.
- Subtree overrides (`DEV3_VIEWS_DIR`, `DEV3_GUI_BUNDLE_PATH`, the `DEV3_NATIVE_*` family,
  `DEV3_TEST_ROOT`) are narrower than the root and were left alone. Note that `DEV3_TEMP_ROOT` in
  `src/bun/temp-paths.ts` is a constant that reads the env var `DEV3_TEST_ROOT` — one letter apart,
  and a trap of the same shape as the one fixed here.

## Alternatives considered

- **A suppression flag** (`DEV3_DISABLE_BACKGROUND_PROMPTS`) gating the dialog in `App.tsx` and the
  pollers in `index.ts` — rejected: it fixes the dialog and leaves the other task's terminal
  reachable, which was the second vent verbatim, and it makes every future cross-task prompt a
  fresh chance to forget the gate.
- **A read-only instance mode** rejecting mutating RPC at the handlers barrel — rejected: it blocks
  the very mutation the QA run exists to verify, and terminal input is not RPC-shaped, so the
  keystroke needs a separate block anyway.
- **Renaming the constant** to break the name collision — rejected above.
- **Auto-wiping the virgin root on every start** — rejected: a destructive default, and a mode that
  erases state every boot cannot show what a *returning* first-run user sees. `dev` prints the
  `rm -rf` line instead.
