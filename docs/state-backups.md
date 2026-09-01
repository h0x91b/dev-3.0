# Backups of your dev3 state

dev3 keeps hourly copies of every file of user state in `~/.dev3.0`, so a wipe,
a bad write, or a corrupted file is recoverable. It never restores anything by
itself — restoring is a deliberate manual step, described at the bottom.

## What is copied

Every hour the app is running (checked twice an hour), each protected file gets:

- `~/.dev3.0/<name>-backups/YYYY-MM-DDTHHZ.json` — one copy per hour, the newest
  72 kept, so roughly three days of history.
- `~/.dev3.0/<name>-last-known-good.json` — a single copy that rotation can never
  evict. It only advances when the incoming file still looks intact, so a run of
  wrecked hours cannot push the last good copy out of the window.

| File | Why it is protected |
|---|---|
| `projects.json` | The project list. Losing it makes every board unreachable and re-adding a project by hand gives it a new id, orphaning all its tasks. |
| `virtual-projects.json` | The Operations boards. Same failure as above, for boards with no git repo behind them. |
| `spaces.json` | Your spaces. Authored entirely by hand and reconstructable from nothing else. |
| `settings.json` | Default agent, binary paths, update channel, theme. Losing it silently reset the update channel to `stable` on a canary install. |
| `agents.json` | Your agent presets. Tens of kilobytes of hand-tuned configuration. |
| `model-catalog.json` | The providers and named models you defined for the proxy sidecar. |
| `data/<project>/tasks.json` | Every task on a board, with its own `tasks-backups/` directory on the same scheme. |

## What is deliberately NOT copied

Keeping 72 dated copies of a file that means nothing when restored is worse than
keeping none — it buries the copies that matter and it costs a real decision to
tell them apart later.

| File | Why not |
|---|---|
| `port-assignments.json` | Derived from the live task set and rewritten constantly. A restored copy describes ports that are no longer assigned to anything. |
| `remote/state.json` | A handoff record for a server process that is already gone. Restoring it points the app at a dead pid and a dead tunnel. |
| `window-state.json`, `last-route.json` | Window geometry and the last screen you had open. Recreated the moment you move the window or navigate. |
| `tip-state.json` | Which "Did you know?" tips you have seen. Losing it shows a few tips again. |
| `preferences.json` | The last folder you picked in the folder picker. |
| `install-date.json` | Derived. A fresh one just restarts the "installed on" clock. |
| `terminal-backend.json` | A single terminal-backend choice, re-made in one click. |
| `web-push-subscriptions.json` | Push endpoints registered by devices. A restored copy resurrects endpoints the push service has already dropped; devices re-subscribe on their next visit. |
| `logs/`, `sockets/`, `bin/`, `worktrees/`, `vents/` | Runtime scratch, disposable by design. |

### Credentials are excluded on purpose

`model-catalog-keys.json` (upstream API keys), `web-push-keys.json` (the VAPID
keypair), `remote-jwt-secret` and `dev-web-access-code` are **not** copied.

A live API key's safety comes from existing in exactly one place at mode `0600`.
Snapshotting it hourly would multiply it into up to 72 dated files, each living
for three days, every one of them picked up by an OS backup, a `cp -r ~/.dev3.0`,
or a support bundle. The exposure that buys is permanent; what it saves is a
30-second re-paste from the provider's dashboard, or a regenerated secret that
costs one re-auth. Losing `spaces.json` is unrecoverable; losing an API key is an
errand. The two do not deserve the same treatment.

If a credential file is ever added to the protected list, it must be written with
the same mode as the original.

## Restoring

There is **no automatic restore**. An app that silently overwrites live state at
startup turns one bad day into two, so this is always something you do yourself,
with the app closed.

1. **Quit dev3 completely.** A running app holds these files and will overwrite
   whatever you put there.
2. **Pick a copy.** The last-known-good file is the safe default:

   ```sh
   ls -la ~/.dev3.0/spaces-last-known-good.json
   ```

   For a specific point in time, list the hourly directory — the names are UTC
   hours, and the same name in two directories is the same moment, so
   `spaces-backups/2026-08-31T10Z.json` and `settings-backups/2026-08-31T10Z.json`
   belong together:

   ```sh
   ls ~/.dev3.0/spaces-backups/
   ```

3. **Keep what is there now**, in case the copy turns out to be the wrong one:

   ```sh
   cp ~/.dev3.0/spaces.json ~/.dev3.0/spaces.json.before-restore
   ```

4. **Copy the backup into place**, and only then start dev3:

   ```sh
   cp ~/.dev3.0/spaces-last-known-good.json ~/.dev3.0/spaces.json
   ```

The same four steps work for `projects.json`, `virtual-projects.json`,
`settings.json`, `agents.json` and `model-catalog.json`. Tasks live per project
at `~/.dev3.0/data/<project-slug>/tasks.json`, with their copies beside them in
`tasks-backups/`.

**Restoring `model-catalog.json` does not restore its API keys** — they were never
copied. Re-paste them in Settings once the catalog is back.
