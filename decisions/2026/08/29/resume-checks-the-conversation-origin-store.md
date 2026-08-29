# Resume checks the conversation's origin store

## Context

`verify-resume-session-id-against-transcripts.md` made resume self-healing: a
stored id whose transcript is gone is replaced by the newest transcript for that
worktree, and by the agent's own `--continue` when the store is empty. Its stated
intent is that the resolver "never downgrades a resume it cannot check."

A pane whose conversation began in a *different* directory defeats that intent
without tripping any of its guards.

## Investigation

Measured against Claude Code 2.1.246. A session was created with cwd `A`, then
resumed with `claude -p --resume <id>` from cwd `B`:

- The conversation stayed in **A's** store — `<config>/projects/<encoded-A>/<id>.jsonl`
  grew 107 612 → 127 456 bytes, with the new records stamped `"cwd":"<B>"`.
  Resume is cwd-independent and never migrates the file.
- `<config>/projects/<encoded-B>/` **was created**, containing only an empty
  `memory/` subdirectory and no `.jsonl`.

Re-measured on review against 2.1.236 (same result) and against 2.1.112, where
the same id resumed from another cwd instead fails with `No conversation found
with session ID` and exits 1, creating no store dir. So cwd-independent resume
arrived somewhere between those two versions, and the trap only exists above it.

That empty directory is the trap. In `resolveResumableSessionId`
(`src/bun/agent-transcripts.ts`) the early-out `!store.dirs.some(existsSync)`
does not fire, because the directory exists; `sessionIdsNewestFirst` returns
`[]`; so the function reaches `ids[0] ?? null` and yields **null** — which the
Claude adapter turns into `--continue`, which in a directory with no
conversation starts a brand new one. The stored id was alive the whole time.

Symptom: the pane launches correctly once, and the first recovery (app restart,
hibernate/wake, pane relaunch) silently swaps the conversation for an empty one,
leaving only a `log.warn`.

## Decision

`PaneSessionEntry.sessionOriginCwd` records the directory whose store holds the
conversation, and `resolveResumableSessionId` takes an `originCwd` and checks
that store before falling back. Absent on every pane whose session began where
the task lives, so the healing behaviour is unchanged for them.

The check sits *after* `ids.includes(stored)` deliberately: the task's own store
is still the best answer when it has one, and a pane that later starts local
sessions must not have them outrank the id it was told to resume.

## Risks

- **An older Claude Code turns this into a dead pane.** Below the version that
  made resume cwd-independent, `--resume <foreign id>` from the worktree exits 1
  and kills the pane — the failure
  `verify-resume-session-id-against-transcripts.md` exists to prevent. dev3 does
  not detect the agent's version, so whichever path eventually sets
  `sessionOriginCwd` owns that risk and should keep the field off panes it cannot
  vouch for.
- **The field only survives if every `sessionState` write carries it.** That write
  in `launchTaskPty` replaces pane[0] wholesale, so the entry is rebuilt on each
  launch and resume; it now carries the origin forward while the resumed id is
  unchanged, and drops it on a substituted id, which belongs to the local store.
- **One more reverse-engineered behaviour.** The empty-`memory/` directory is not
  documented and may stop being created. If it does, the earlier `existsSync`
  guard starts firing and the stored id passes through untouched — the safe
  direction, so the change degrades rather than breaks.
- **Nothing sets the field yet.** `dev3 conversations import` does not resume, so
  today this is a latent fix. It becomes load-bearing the moment any path resumes
  a conversation that began outside the task's own worktree.

## Alternatives considered

- **Search every store dir for the id.** Removes the need for a stored field, but
  turns an O(1) check into a scan of every project directory on the machine, and
  a same-id collision across stores would resolve arbitrarily.
- **Suppress healing entirely when the id came from elsewhere.** Simpler, but
  gives up the repair the earlier record exists to provide — a genuinely dead
  pointer would then kill the pane again.
- **Persist the transcript path rather than the origin cwd.** The path moves
  between config dirs (an agent account changes the store root); the cwd is what
  every store keys on, so it survives that.
