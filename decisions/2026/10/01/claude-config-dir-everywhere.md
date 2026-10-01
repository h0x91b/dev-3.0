# Follow CLAUDE_CONFIG_DIR wherever dev3 writes for Claude

## Context

Claude Code reads its user config from `$CLAUDE_CONFIG_DIR` when set: `settings.json`, `skills/` and its own `.claude.json` all live inside it, and `~/.claude` plus `~/.claude.json` are only the fallback. A user can pin the variable per project (`.dev3/config.local.json` `env`), per agent config, or on the server's own environment. dev3 wrote its skills, its `settings.json` entries (dev3 CLI allow rule, sandbox socket, `autoMode.allow`) and worktree trust to `~/.claude` regardless, and `dev3 statusline` read the user's statusLine from there. A pinned agent never saw any of it: no `/dev3-project-config` and friends, a classifier free to block `dev3 task move --status completed`, a trust prompt, and its custom statusLine silently replaced. Managed accounts escaped only because their dir symlinks `~/.claude` entries.

## Investigation

The value is per launch, not global: project env is resolved inside each launch, after the startup install has already run. Headless `dev3 remote` (`headless-entry.ts`) never called `installAgentSkills` at all, so a headless box got no dev3 skills even in `~/.claude`.

## Decision

`src/shared/claude-config-dir.ts` resolves the location from the env the agent will see (launch env first, then the server's env, then the default). Startup installs into `~/.claude` (managed accounts symlink its skills and settings, unpinned launches read it) and also into the server env's pinned dir when there is one (`installAgentSkills` → `installClaudeConfigDir`). The account switcher's `ENV_UNSET` sentinel in a launch env means the default dir. Each launch passes its final env into `ensureAgentTrust` (`rpc-handlers/tmux-pty.ts`): `ensureClaudeConfigDir` installs skills and settings into a pinned dir (writes only on changed bytes), and `ensureClaudeTrust` writes trust into that dir's `.claude.json` instead of `~/.claude.json`. Pinned dirs are recorded in `~/.dev3.0/claude-config-dirs.json` so `claude-json-prune.ts` sweeps them. `dev3 statusline` uses the same resolver. Headless startup now calls `installAgentSkills`. A `settings.json` that exists but does not parse is left alone rather than replaced.

## Risks

Writing into a user's hand-maintained config dir: limited to the same keys dev3 already wrote into `~/.claude/settings.json`, merged, never replacing an unparsable file. A pinned launch no longer gets a `~/.claude.json` trust entry; nothing but Claude reads it. The low-battery output style and `/low-battery` skill still target `~/.claude` - deciding which pinned dir's `outputStyle` a global toggle may change is a separate question.

## Alternatives considered

Shipping the skills as a plugin via `--plugin-dir` (as clodex does) needs no config dir at all, but plugin skills are namespaced (`dev3:dev3-project-config`), which would rename every `/dev3-*` reference in the length-capped protocol. Putting the settings entries into the existing `--settings` file avoids touching the user's file, but the permission and socket entries must also reach sessions started outside the dev3 launcher.
