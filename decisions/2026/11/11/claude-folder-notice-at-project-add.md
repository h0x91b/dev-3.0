# Claude folder notice at project add, and a confirm on the folder switch

## Context
With "Each project uses its own Claude folder" on, a new project's agents use `<project>/.claude`, which usually has no login, and on Linux and Windows the folder can be refused silently (`project-claude-folder-on-every-os.md`). Flipping the switch also strands the conversations of tasks that are already active.

## Investigation
Claude Code 2.1.322 stores a custom-dir login in the macOS Keychain under service `Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR, NFC) first 8 hex>`, account `$USER` (or `claude-code-user` when `$USER` has other characters than `[a-zA-Z0-9._-]`). The hash covers the variable's raw value, not a normalized path. On Windows a Credential Manager store exists behind the `tengu_windows_credman` feature flag; `.credentials.json` is still the default.

## Decision
- `claudeFolderNotice` (`src/bun/claude-folder-notice.ts`) runs at the end of `addProjectImpl`, so Add, Init, Clone and `dev3 projects add|clone` all get one `claudeFolder` result field: `ready`, `no-login`, or `refused`. It fires whenever the resolved env pins a folder other than `~/.claude`, whether the global default or the repo's own config set it. Off macOS it reports `refused` for a refused `{projectPath}` default, and for any pin `claudeLoginKeptOutOfGit` rejects, because `ensureClaudeConfigDir` drops such a pin at launch.
- A login is a `.credentials.json` on any OS, or on macOS a Keychain item found with `security find-generic-password -a -s` without `-w`, which reads no secret and raises no prompt.
- The renderer shows one toast per project beside the auto-configure toast; refused is an error toast, like `storageKeptHome`. A folder inside the project reads as `<project>/.claude` (`claudeFolderLabel`), because a plain-string toast cannot carry the streamer-mode blur class. The CLI prints a `Claude folder:` line.
- `claudeFolderSwitchImpact` resolves every project's env under the current and the toggled defaults (`resolveProjectEnv` takes `agentEnvDefaults`) and counts `ACTIVE_STATUSES` tasks whose folder changes. `AgentEnvDefaultsSection` asks through `confirm()` only when that count is above zero; switching back restores resume, so the confirm is not `danger`.

## Risks
- The service-name formula is Claude Code's internal detail. If it changes, macOS reports `no-login` for a folder that has a login. The notice is informational, so launches are unaffected.
- If the impact RPC fails, the switch flips without asking; the switch description still states the caveat.
- If Credential Manager becomes the Windows default, Windows logins will read as `no-login`.

## Alternatives considered
- A step inside the Add Project modal before Add. Rejected: an informational fact must not gate the primary action.
- A badge on the project card. Rejected: the login state changes after the first sign-in, and the badge would go stale.
- Reading the Keychain secret with `-w`. Rejected: it prompts, and existence is all the notice needs.
