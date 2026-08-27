# Dev builds never write the managed `~/.dev3.0/bin/dev3`

## Context

`~/.dev3.0/bin/dev3` is a single, frozen, machine-wide entry. Agent hooks, the injected dev3
skill and lifecycle `onExit` commands all invoke the CLI through that absolute path (`DEV3_CLI`
in `src/shared/agent-hooks.ts`), and every installed version of the app on the machine shares
the same `~/.dev3.0` (AGENTS.md, on-disk invariants). There is one name, so whoever writes it
last owns the CLI every agent and the user run.

Running `bun run dev` — the project's own documented dev loop, and what `dev3 dev-server start`
executes — was writing it. On a machine with several agents doing browser QA in parallel, the
rule was "whichever agent ran the dev loop most recently wins the shared CLI". Three independent
sightings landed in one night (2026-08-26/27) before anyone connected them.

## Investigation

Two observed failure shapes, and they came from **two different write paths**, not one:

| Shape | Write path | What the user sees |
|---|---|---|
| `bin/dev3` symlinked to the `bun` runtime | `src/bun/headless-entry.ts` → `ensureDev3CliSymlink(DEV3_HOME, process.execPath)`; under `bun run …` `process.execPath` **is** bun | every command dies with `error: Script not found "tasks"` |
| `bin/dev3` replaced by a 76 MB build from an unmerged branch | `src/bun/index.ts` startup `installBinary()` copies `<bundle>/Resources/app/cli/dev3` over it | nothing — the CLI works, from the wrong code |

Both reproduced before the fix: a source-run `dev3 remote start` produced
`bin/dev3 -> /opt/homebrew/Cellar/bun/1.3.14/bin/bun`, and one `dev3 dev-server start` moved the
real `~/.dev3.0/bin/dev3` from the installed app's build `c8cdeb2d` to this worktree's `2107fbc9`.

There is **no repair timer** and nothing self-heals. The two-minute "recovery" in the first
sighting was simply the next writer: the installed app rewrites the name on every launch, so a
relaunch (or another agent's dev loop) overwrote the broken entry.

A third writer, `installDev3Cli` in `src/bun/rpc-handlers/settings-config.ts`, exists behind
Settings → "Install dev3 CLI". It is a deliberate user action and is left alone.

## Decision

`src/bun/managed-cli-guard.ts` holds one predicate, `mayWriteManagedCli`, and both automatic
entry points call it before touching the name (`src/bun/index.ts` around `installBinary`,
`src/bun/headless-entry.ts` around `ensureDev3CliSymlink`).

Rule order is load-bearing:

1. The `dev` channel Electrobun bakes into a locally built bundle (`Resources/version.json`)
   positively identifies a non-install → refuse, unless `DEV3_INSTALL_MANAGED_CLI=1`.
2. **Any other channel is an install, and this answer must come before the source check** — the
   desktop app's own main process runs a `bun` binary from inside its bundle
   (`…/Contents/MacOS/bun`), so a source check placed first would refuse the installed app and
   break exactly what the guard protects.
3. A bare `bun` (`detectInstallMethod(…) === "source"`) has nothing to install → refuse, and the
   opt-in deliberately does **not** reach here: honouring it would aim the shared name at the bun
   runtime, which is the original crash.
4. No channel readable and not bun → fail **open**, so an install with an unfamiliar layout keeps
   working.

The opt-in is explicit, never default, and reversible the way `dev3 doctor` already documents:
relaunch the installed app and it rewrites the name from its own bundle.

## Risks

- **Fail-open on an unreadable channel.** A future non-install arrangement that carries no
  `version.json` and is not bun would still write. Chosen over the alternative, which is silently
  breaking real installs.
- **The channel string is Electrobun's, not ours.** If it ever stops baking `channel: "dev"` into
  local builds, the first rule goes quiet. The source check still catches the bun shape.
- **Nothing stops a fourth writer.** The guard is convention plus a comment, not an enforced
  invariant — same posture as the "always go through TmuxClient" rule.

## Alternatives considered

- **A second filename for dev builds** (`bin/dev3-dev`). Rejected: dev3 already has a second name,
  `dev3-self`, for instance pinning, and nothing generated ever names a second CLI, so the shim
  would exist and be reached by nobody.
- **Keep writing, restore on exit.** Rejected: an agent's dev server is killed far more often than
  it exits, so the restore is the path least likely to run. It also cannot survive N agents running
  the dev loop concurrently — restoring "the previous value" would resurrect another branch's build.
- **Do nothing and document it.** Rejected: the silent shape (a working CLI from the wrong branch)
  produces no symptom at all, so documentation cannot be acted on.
- **Renaming or moving anything under `~/.dev3.0`.** Forbidden outright by the frozen on-disk
  layout rules.
