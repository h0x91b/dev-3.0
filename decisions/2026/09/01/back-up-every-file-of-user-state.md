# Back up every file of user state, with a per-file collapse rule

## Context

On 2026-08-31 something wiped part of `~/.dev3.0` — `projects.json`, `logs/`,
`bin/`, `sockets/`. The cause was never found. PR #1620 gave `projects.json`
hourly snapshots plus a `projects-last-known-good.json` that rotation cannot
evict, driven by a 30-minute timer because the original defect was the trigger:
the old scheme only fired on a save or at app startup, so days when nobody edited
a project got no copy at all.

A day later the same incident turned out to have taken `spaces.json` as well, and
there was no backup of it anywhere. `settings.json`, `agents.json`,
`virtual-projects.json` and `model-catalog.json` had the identical hole. The fix
had been written for one file when six had the same problem.

## Investigation

Reading every `${DEV3_HOME}/...` path in `src/` produced 20 top-level files. Six
are user state — authored by the user and unrecoverable without them. The rest
split into derived/ephemeral state (`port-assignments.json`, `window-state.json`,
`last-route.json`, `tip-state.json`, `preferences.json`, `install-date.json`,
`terminal-backend.json`, `remote/state.json`, `web-push-subscriptions.json`) and
credentials (`model-catalog-keys.json`, `web-push-keys.json`,
`remote-jwt-secret`, `dev-web-access-code`). The full table with a reason per
file is in `docs/state-backups.md`.

## Decision

`src/bun/state-backup.ts` owns one registry, `PROTECTED_STATE_FILES`, and the
mechanism `writeHourlySnapshot` that `data.ts` already had. `data.ts` imports it
for the task store and delegates `backupProjectsHourly` to the registry entry, so
there is exactly one implementation. `src/bun/index.ts` ticks
`snapshotProtectedState()` every 30 minutes, which is the ONLY trigger the five
new files have — none of them gets a pre-write hook, because the timer is what
actually fixed the measured defect and adding five hooks is five more places to
get wrong.

**Collapse rule, per file, not one generic rule.** The `projects.json` rule
("refuse when more than half the entries went at once") is honest for a list and
dishonest for anything else, so each file states its own:

| File | Rule | Why that rule |
|---|---|---|
| `projects.json`, `virtual-projects.json`, `agents.json` | Half the array gone at once | Unchanged from #1620. Deleting a project or dropping a few removed presets is ordinary; halving is not. |
| `spaces.json` | Half the `spaces` array gone, and only for a file this loader could read back (`version === 1`, both arrays present) | Deletion here is SOFT — a deleted space stays in the array — so the count only grows during ordinary use, which makes any halving unambiguous. The shape check matters separately: a file dev3 cannot parse must never become the good copy no matter how large it is. |
| `model-catalog.json` | Half of `providers.length + models.length` gone | Both halves are user-authored and a wipe takes both; either one missing entirely means the bytes are not a catalog. |
| `settings.json` | Refuse only when the incoming keys are a strict SUBSET of the good copy's AND fewer than half remain | Key count alone is wrong here: the loader drops every default-valued field before writing, so a user turning one toggle back to its default legitimately removes a key. The shape worth refusing is the one that happened — the file vanished and came back written from `DEFAULT_SETTINGS`, four keys where twenty had been. That is a pure subset with massive loss; ordinary editing either introduces a key or drops a handful. |

**Per-file directories, not one dated snapshot directory.** A single directory
holding all files per timestamp would make a point-in-time restore look coherent,
and the coherence would be a lie: the pair that genuinely cross-references
(`projects.json` ↔ `data/<slug>/tasks.json`) can never share a directory, because
tasks live under the project's own data dir. A shared directory would also couple
the writers — one unreadable file would leave an incomplete set that still looks
like a moment in time. Instead every file keeps `<stem>-backups/` beside itself,
and the hourly filename is identical across directories, so a coherent restore is
still a matter of matching names. `projects-backups/` and
`projects-last-known-good.json` keep the exact paths #1620 shipped.

**Credentials are excluded.** Copying a live API key into up to 72 dated files,
each alive for three days, is a permanent widening of exposure; what it buys back
is a 30-second re-paste. Losing `spaces.json` is unrecoverable, losing a key is an
errand — the asymmetry decides it. Any future credential added to the list must
be written with the original's file mode.

**No restore in this change.** `docs/state-backups.md` documents the manual copy
(quit the app, keep the current file, copy the backup in). A `dev3 restore-state`
command is worth its own task; an automatic restore-on-startup is explicitly
never going to exist, because silently overwriting live user state turns one bad
day into two.

## Risks

- The new files are timer-only, so a copy can be up to 30 minutes stale. Accepted:
  the incident being defended against is a whole-file wipe, not a lost edit.
- `agents.json` written in the pre-array legacy format counts as `null` and never
  advances its good copy. Self-correcting — `getAllAgents` rewrites it as an array
  on the next load — and failing closed is the right direction.
- Six new sibling paths appear in `~/.dev3.0`. Additive only; older app versions
  never read them (AGENTS.md on-disk rule 5).

## Alternatives considered

- **One generic "half the entries" rule for every file.** Rejected: it has no
  honest meaning for `settings.json`, and forcing one would either freeze that
  file or wave a defaults-only rewrite through.
- **A single dated directory holding all files.** Rejected above — the coherence
  it promises is unavailable for the one pair that needs it.
- **Snapshot on every save, like `projects.json` does.** Rejected as the primary
  trigger: save-only cover is the exact defect #1620 diagnosed. The projects save
  hook is kept because it already exists and costs nothing.
- **Snapshot everything in the data root.** Rejected: 72 copies of
  `port-assignments.json` is noise that buries the copies that matter.
