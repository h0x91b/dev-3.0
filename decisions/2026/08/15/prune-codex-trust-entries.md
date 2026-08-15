# Prune dev3 trust entries from ~/.codex/config.toml

## Context

`ensureCodexTrust` (`src/bun/agents.ts`) appends a `[projects."<worktree>"] trust_level = "trusted"` block to
`~/.codex/config.toml` on every Codex launch. Nothing ever removed one — not on task completion, not on worktree
removal, not on uninstall. On the machine that reported this (machine-footprint audit, dev3 task seq 1551 — its
findings live in that task's notes, deliberately not in git), 464 project blocks had accumulated, 426 of them dev3
worktrees, in a 63 KB file.

`config.toml` is Codex's only config file, and a malformed one stops Codex from starting at all — dev3 has already
done that once on Windows (seq 1540, unescaped backslashes in TOML basic strings). So the cost of a wrong edit here
is much higher than the cost of one stale block.

## Investigation

Measured on the reporting machine's real 63 KB config:

| Step | Cost |
|---|---|
| read + line scan for `[projects.…]` headers | 0.5 ms |
| `existsSync` on all 464 trusted paths | 0.8 ms |
| `js-toml` parse | 13–110 ms depending on warm-up |

Cheap enough that no one-shot migration with persisted bookkeeping is warranted: the sweep just runs as part of the
maintenance dev3 already performs on that file. A dry run over the real config removed 412 blocks (63 163 → 10 082
bytes), touched none of the user's own 38 entries (6 of which point at directories that no longer exist), left the
14 live dev3 entries, and produced a file whose parsed non-`[projects]` content was byte-identical.

## Decision

Codex pruning plugs into the trust seam `src/bun/worktree-trust.ts` (added for Gemini the same day, see
`forget-worktree-trust-on-removal.md`) rather than growing a second teardown hook beside it:

- `forgetWorktreeTrust(path)` — teardown, from the `removeWorktree` and `removeTaskWorkspace` effects.
- `sweepStaleWorktreeTrust()` — once at startup, for entries left by versions that never pruned.

`src/bun/codex-config.ts` owns the file, not the policy:

- `pruneCodexProjectEntries(content, shouldRemove, preParsed?)` — the pure edit. It removes whole
  `[projects."<path>"]` blocks (and their sub-tables) from the **raw text**, not from a re-serialized parse tree.
  `js-toml` has no serializer, and a re-stringify would flatten the user's comments, formatting and key order.
  A trailing run of blank/comment lines inside a removed block is re-attached to the next header instead of
  going with the block: a comment written directly above a kept `[projects."…"]` belongs to that header, and the
  equality guard cannot see comment loss because comments are not in the parse tree.
- `pruneCodexTrustEntries(homePath, shouldRemove)` — reads and writes `<home>/.codex/config.toml`.
- `isDev3TrustPath(path, dev3Home)` — the ownership test: under `~/.dev3.0/worktrees` or `~/.dev3.0/ops`, never
  the roots themselves.

Removal requires **both** dev3 ownership and a directory that is gone. On teardown an exact path match also counts,
but it is not what carries the case: on Windows the entry was written as a `realpath` and the task's own path may
spell its separators differently, so "gone from disk" is the rule that reliably fires.

`ensureCodexConfig` deliberately does NOT sweep. It writes what a launch needs; forgetting is teardown's job, and
splitting it that way keeps one owner per direction.

Fails closed at three points: the file does not parse, the result does not parse, or the result differs from the
input by anything other than exactly the selected project keys (compared through a stable serialization of both
parse trees). Any of those returns the original content untouched. The third guard is not theoretical — the
blank-line collapsing that block removal inherits from the file's other section helpers can alter a multi-line
string value while still parsing, and only the comparison catches it.

Roots themselves (`~/.dev3.0/worktrees`) are never pruned: dev3 trusts that path deliberately and permanently.

The equality guard serializes both parse trees itself instead of using `JSON.stringify`, because `js-toml` decodes
an integer past 2^53 as a `BigInt` and `JSON.stringify` throws on those. One such key anywhere in the user's
config — `max_bytes = 9223372036854775807` is enough — turned the guard into a `TypeError` that escaped
`pruneCodexProjectEntries` entirely and took the Claude and Gemini prunes down with it.

## Risks

- A user who keeps their own project *inside* `~/.dev3.0/worktrees` would lose its trust entry. Nothing supports
  that layout — the directory is dev3-managed — and the worst outcome is one trust dialog.
- The sweep uses `existsSync` at launch time. A worktree that is momentarily unreadable (unmounted volume) would be
  read as gone and re-trusted on the next launch. Again: one dialog, no data loss.
- A config containing a multi-line string with blank lines never gets pruned at all, because the equality guard
  refuses the edit. Accepted — a permanently stale entry is cheaper than a rewritten string value.

## Alternatives considered

- **Format-preserving TOML library.** None is in the dependency tree, `js-toml` is parse-only, and adding a
  serializer would hand every future write path a way to reformat the user's file.
- **One-shot migration with a "swept" flag in settings.** More state to keep, and it heals nothing when a later
  version leaks entries again. The measured cost makes an always-on sweep free.
- **Deleting `~/.codex/config.toml.dev3-backup` on the same trigger.** Rejected. That file is written exactly once,
  and only when dev3 found a config it could not parse — it is the user's only pre-damage copy of a file dev3 may
  have broken. Deleting it destroys evidence of our own incident to save one file; it also does not shred anything,
  since a plain `unlink` leaves the contents on disk. It stays, and its path is already logged when created.
