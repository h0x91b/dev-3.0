# Pin Claude Code mods by marketplace tag, disable instead of uninstall

## Context
Settings → Agents installs third-party Claude Code plugins (`CLAUDE_MODS`, today prismantis) whose hooks run inside every Claude session. The first version refreshed the marketplace and installed whatever its default branch named, uninstalled on "off", and assumed one install in `~/.claude` reached every managed account.

## Investigation
Verified against Claude Code 2.1.314 in an isolated `CLAUDE_CONFIG_DIR`:
- `claude plugin marketplace add <git-url>#<ref>` clones with `--branch`: a tag works, a bare commit SHA is refused. `marketplace list --json` reports the `ref`.
- `marketplace remove` uninstalls that marketplace's plugins and deletes their saved options.
- Plugin options live in `settings.json` under `pluginConfigs`; `plugin uninstall --keep-data` keeps only the data dir and drops them. `plugin disable`/`enable` keep them.
- `scaffoldClaudeAccountDir` never replaces an existing entry, so an account with a real `plugins/` or `settings.json` misses an install made in `~/.claude`.

## Decision
`src/bun/rpc-handlers/claude-mods.ts`: each mod carries `marketplaceRef` (a tag; its manifest pins the plugin source by SHA) and the `pinnedVersion` that tag installs, verified after every install. A marketplace with another URL or ref is removed and re-added before the plugin state is read. "Off" disables. Every command runs with `CLAUDE_CONFIG_DIR` unset (or set to a target account), `GIT_TERMINAL_PROMPT=0`, and a 90 s kill timeout, and the change also runs in every account whose `plugins/` or `settings.json` is not a link into `~/.claude`.

## Risks
A tag can be moved by the repo owner; the post-install version check catches a different version but not a re-tagged same version. Re-pinning an unpinned marketplace loses options set under the old install. A marketplace manifest's version label can lag its pinned source (tag v0.41.0 installs plugin 0.40.0), so `pinnedVersion` must be read from a real install, not from the tag name.

## Alternatives considered
Pinning by SHA (refused by the CLI); verifying the version only after installing from the default branch (the code is already on disk by then); saving and restoring `pluginConfigs` around an uninstall (editing Claude's settings file behind its back); reporting separate accounts instead of installing there (leaves the switch lying).
