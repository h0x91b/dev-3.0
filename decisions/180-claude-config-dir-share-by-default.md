# 180 — Per-account Claude config dirs share ~/.claude by default, deny-list only

## Context

Each managed Claude account is a full `CLAUDE_CONFIG_DIR` under
`~/.dev3.0/agent-accounts/claude/<id>/` (decision 107). Shared user state was symlinked in
from `~/.claude` through a hand-maintained allow-list of nine entries.

The allow-list lost the race against Claude Code releases. `output-styles` was never added,
so a `settings.json` naming a custom `outputStyle` resolved to nothing and Claude Code fell
back to the default style with no warning anywhere — about an hour of debugging to find,
because the setting, the style file and every skill all looked correct. `cli.js` resolves six
resource types by name out of its config dir (`commands`, `agents`, `output-styles`, `skills`,
`workflows`, `routines`); the allow-list covered four. `hooks/`, `scripts/` and top-level
`*.md` files imported from `CLAUDE.md` (`@RTK.md`) were missing too.

## Investigation

Sharing is already the proven behaviour, not the risky one: with the switcher off
(`claude.activeId: null`, the default) every agent on the machine runs on `~/.claude`
directly and writes to the same `sessions/`, `cache/`, `history.jsonl`, `shell-snapshots/`.
Nothing about that is per-account.

Claude rate-limit attribution does not read inside the account dir either — the statusline
wrapper writes per-account dumps into `~/.dev3.0/data/rate-limits/claude/<id>.json`, keyed by
`DEV3_AGENT_ACCOUNT_ID_ENV` (`rate-limit-monitor.ts`). Only Codex reads per-account sessions.

## Decision

`scaffoldClaudeAccountDir` now reads `~/.claude` and symlinks **every** entry except
`CLAUDE_PRIVATE_ENTRIES` — the five things that make an account be an account:
`.credentials.json` (login), `.claude.json` (identity + trust), `stats-cache.json` (usage),
`policy-limits.json` (org policy of that login), `statsig` (per-user flags).

`isPrivateClaudeEntry` additionally denies anything credential-shaped by pattern
(`/credential/i`, `/^auth/i`, `/token/i`, `/\.key$/i`) so a future secret file is private
even when the explicit list forgets it. `.DS_Store`/`.localized` are skipped as junk.

The failure direction is inverted deliberately: a missed allow-list entry silently disabled a
user setting, while a missed deny-list entry shares ordinary runtime state that is already
shared whenever the switcher is off.

Two supporting changes in the same commit set: scaffolding is re-run from
`getActiveClaudeConfigDir`, so accounts created by older builds pick up newly appearing
entries; and `warnOnUnresolvableOutputStyle` logs when `settings.json` names an output style
that matches no registered name. Claude Code registers a style under its frontmatter `name`
*instead of* its filename slug (`$ = A.name ?? basename(file, ".md")`, then an exact map
lookup `q[Y] ?? null`), so `low-battery.md` declaring `name: Low Battery` is only reachable as
`"Low Battery"` — the original bug in this task was that mismatch, not the plumbing.

## Risks

- If Anthropic adds a per-account state file that is not credential-shaped by name, it gets
  shared and that account's data merges with the others. Mitigation: the pattern deny-list
  covers the damaging class (secrets), and merged usage caches are recoverable.
- Existing accounts converge only partially. An entry that already exists in the account dir
  as real state is left untouched — never replaced, never deleted (see the on-disk invariants
  in `AGENTS.md`). Only genuinely absent entries get a new symlink.
- `settings.local.json` becomes shared. Accepted: `settings.json` already had the same
  write-through property and has been shared since decision 107.

## Alternatives considered

- **Extend the allow-list to all six resource types + `hooks`/`scripts`/`*.md` and warn on
  unclassified entries.** Keeps leaks impossible, but still needs a manual edit per Claude
  Code release; the warning only shortens the debugging, it does not prevent the breakage.
- **Recursively copy `~/.claude` into each account dir.** Dead on arrival: 2.0 GB on a real
  machine (1.8 GB of it `projects/`), stale the moment it is written, and it duplicates the
  login token per account.
- **Symlink the whole directory.** `CLAUDE_CONFIG_DIR` would equal `~/.claude` and accounts
  would stop existing.
