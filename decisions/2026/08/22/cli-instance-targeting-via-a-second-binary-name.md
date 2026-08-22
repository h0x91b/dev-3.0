# CLI instance targeting: one primitive, and a SECOND binary name to arm it

## Context

Several dev3 instances share one `~/.dev3.0/`: the installed app, plus a "guest" — a dev build
booted by a task's `devScript`, or a headless `dev3 remote` from an agent pane. Discovery
deliberately prefers the primary (`discoverSocketIn` in `src/cli/context.ts`, from #910/#920:
routing a stop/restart into a guest hosted by the very session being stopped kills it
mid-request). Until now a human had no way to override that, so a freshly built CLI talked to
the installed app and new flags looked broken — observed 2026-08-22 as
`dev3 task update --type coordinator` → "Nothing to update", because that shell reached the app
from the previous day rather than the task's own dev-server.

## Investigation

The trap is the frozen path, and it is worse than "hooks use the same file":

- Every agent hook, the injected dev3 skill, and lifecycle onExit commands invoke the CLI as
  `~/.dev3.0/bin/dev3` (`DEV3_CLI` in `src/shared/agent-hooks.ts`), and that string is already
  written into every worktree's `.claude/settings.local.json`, which OLDER installed builds
  still read. Arming `bin/dev3` itself would route every task's status hooks into one guest —
  #910/#920 reproduced by construction, and unparseable for an older build.
- `DEV3_TASK_ID` is injected into every task pane, **agent panes included**, so it cannot be
  reinterpreted as an instance selector either — the hooks in that pane carry it too.
- `hostTaskId` already exists in the socket sidecar / endpoint record, so an instance can be
  named by the task hosting it and survive the pid changing on every dev-server restart.

## Decision

One primitive, two conveniences, and a precedence order: `--instance` **>** `DEV3_CLI_SOCKET`
**>** existing discovery. Nothing falls back — a human who names an instance and silently gets
another one is the confusion being fixed (`CLI_EXIT_CODE_INSTANCE_NOT_FOUND`, code 15).

- `DEV3_CLI_SOCKET=<endpoint path>` — the primitive, honoured in `resolveSocketPath`
  (`src/cli/context.ts`). Nothing in dev3 ever sets it, so hooks are unaffected.
- `--instance self | primary | task:<id> | seq:<N>` — resolved by `resolveInstanceSocket`,
  stripped from argv before help routing and per-command flag validation
  (`extractInstanceFlag` in `src/cli/args.ts`). Ambiguity is an error, not a guess: a variant
  shares its sibling's `seq`. `pid:<n>` was deliberately left out — it dies on every restart.
- Arming lives on a **second filename**: Settings → Install dev3 CLI now also writes
  `~/.dev3.0/bin/dev3-self` (`writeDev3SelfShim`, `src/bun/cli-self-install.ts`), an `exec` shim
  carrying `--instance task:<uuid>` of the installing instance. Nothing generated ever names
  `dev3-self`, so the hook path is unreachable from it *by construction* rather than by care.
  The shim execs the realpath'd binary and refuses any target that really lives in
  `<dev3Home>/bin` — that dir is first on PATH (ELOOP, see
  [pin-tmux-3.6-vendored-keg](../../07/05/pin-tmux-3.6-vendored-keg.md)).
- `socketDiagnostics` now names the task behind a deprioritized guest; before, the tag said only
  that *something* was skipped, which is why a pid was the one thing a human could aim at.

## Risks

- Two names for one CLI is a thing to learn. Mitigated by the Settings line naming the armed
  path and selector, and by `--instance` appearing in every `--help` footer.
- A shell that exports `DEV3_CLI_SOCKET` and then starts an agent in the same pane hands the
  override to that agent. That is explicit and the human's own doing; nothing in dev3 exports it.
- `--instance` is stripped globally from argv, so a positional argument spelled exactly
  `--instance` (e.g. inside a `dev3 message` body) is consumed. `parseArgs` already treats any
  `--foo` anywhere as a flag, so this matches existing behavior rather than adding a new edge.

## What was NOT verified

Recorded verbatim so a later reader cannot mistake it for covered ground:

- **Two live instances in the real `~/.dev3.0`.** Routing was proven with real CLI processes
  against two real listeners in a fabricated home, not against a guest booted into the
  developer's live home.
- **Windows.** The `dev3-self.cmd` shim is unit-tested only — never executed on Windows.

## Alternatives considered

- **Wrap `bin/dev3` and pass `--instance primary` in regenerated hooks.** One name, no typing —
  and the failure mode above: worktrees on disk keep the old string, so their hooks go to the
  guest. Rejected.
- **Implicit cwd-based targeting** (a CLI run inside a task worktree prefers that task's guest).
  Zero to learn, and exactly what #910/#920 fixed: hooks and onExit run in the same cwd, so they
  move too. Held as a mutation test — under that design three hook-path proofs in
  `src/bun/__tests__/cli-instance-routing.test.ts` go red.
- **Primitive plus a `dev3 instances` listing, no arming.** Least machinery, most typing every
  command. Rejected on use; the diagnostics tag now names the host task instead.
