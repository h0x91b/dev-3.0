# Codex asks before dev3 subcommands that execute

## Context

Issue #2043: the dev3 CLI lets an agent run a command through the app (`dev3 pane run "<cmd>"`,
`dev-server start`, `agent spawn`, …), outside the agent's own check. The Claude half was closed by
`decisions/2026/10/26/narrow-dev3-agent-permissions.md`. This record covers sandboxed Codex
(`default_permissions="dev3"`): there the app ran the command outside Codex's sandbox with no prompt.

## Investigation

Measured with `codex sandbox` / `codex execpolicy check` 0.163 against a temporary `CODEX_HOME`:

- With `[permissions.dev3.network] enabled = true` every local unix socket is reachable. The
  `network.unix_sockets` allowlist dev3 writes is not enforced at all, so the profile cannot keep the
  sandbox off the dev3 socket without turning all network off.
- Codex loads every `<CODEX_HOME>/rules/*.rules`, not only `default.rules`.
- When several `prefix_rule`s match, the strictest decision wins. An `allow` rule can never carve an
  exception out of a broader `prompt`, so "prompt on all of dev3, allow the metadata" is not
  expressible.

## Decision

- `src/shared/codex-exec-policy.ts` builds `prompt` rules for the **complement** of
  `DEV3_AUTO_APPROVED_SUBCOMMANDS`, the same allowlist Claude uses, so the two cannot drift: every
  top-level command with nothing allowlisted, every unlisted subcommand of a partly allowlisted one
  (`pane run`, `dev-server start`, `agent spawn`, …), and the position-free `--instance` flag. No
  `allow` rules: metadata subcommands already run without a prompt under `-a on-request`.
- The command list is `cliCommandSpecs()` (`src/cli/help.ts`): the help registry plus the words
  main.ts dispatches without help. `codex-dev3-rules.test.ts` fails when main.ts grows an unknown
  command, so a new command prompts by default.
- `src/bun/codex-rules.ts` writes `<CODEX_HOME>/rules/dev3.rules`, a file dev3 owns whole, into
  `~/.codex` at startup (`ensureCodexConfigFile`) and into each managed account's CODEX_HOME
  (`ensureCodexAccountHome`). The user's `default.rules` is never read or written.
- The maintainer chose this over a capability key on the socket or an app-side dialog.

## Risks

- **A guard against accidental bypass, not a deliberate one.** A sandboxed Codex agent can still
  talk to the dev3 socket directly (python, nc) and run anything through `pane.run`, and the profile
  still grants write on all of `~/.dev3.0`, including `~/.dev3.0/bin/dev3`, which hooks run unsandboxed.
- Spellings the rules cannot see: `--instance=<sel>` glued to its value, an env prefix
  (`DEV3_CLI_SOCKET=… dev3 …`), a nested `sh -c`, a subcommand the help registry does not list.
- The rules live in CODEX_HOME, so they also prompt in Codex sessions dev3 did not start, and in the
  `danger-full-access` presets.

## Alternatives considered

- Capability key the sandbox cannot read (a `"none"` filesystem entry is enforced) required by every
  executing socket method, plus narrow `~/.dev3.0` write: closes the deliberate bypass too; rejected
  by the maintainer as over-engineering.
- App-side approval dialog on executing methods: double-prompts Claude, rejected before.
