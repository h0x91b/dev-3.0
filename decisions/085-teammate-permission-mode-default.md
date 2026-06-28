# 085 — Propagate permission mode to Claude agent-team teammates

## Context

When a Claude agent launches in an auto-approve config (e.g. "Auto", "Bypass",
"Accept Edits") and uses the experimental agent-teams feature
(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + the `TeamCreate` tool), the spawned
teammates fell back to `default` permission mode and prompted "Waiting for tool
approval" on every command. The user had to manually approve every teammate's
every command.

## Investigation

dev3 sets the lead's mode via the `--permission-mode <mode>` CLI flag in
`resolveAgentCommand` (`src/bun/agents.ts`). Per the Claude Code docs
(code.claude.com — agent-teams / permission-modes / settings), that flag only
governs the **lead** session. Teammates take their starting mode from the
worktree's settings files, not the lead's CLI flag — so the default "Auto"
config (which passes only `--permission-mode auto`, no
`--dangerously-skip-permissions`) left teammates with no settings-file baseline
and they defaulted to interactive approval. The docs explicitly recommend
writing `permissions.defaultMode` into a settings file to give teammates a
baseline. Claude's valid `defaultMode` values
(`default | acceptEdits | plan | auto | dontAsk | bypassPermissions`) map 1:1 to
dev3's `PermissionMode` type.

## Decision

When launching a Claude agent, write the resolved config's `permissionMode`
(when non-`default`) as `permissions.defaultMode` into the worktree's
`.claude/settings.local.json`. Implemented in `ensureDefaultMode` +
`writeClaudeHooks` (`src/shared/agent-hooks.ts`), threaded through
`setupAgentHooks` (`src/bun/agent-hooks.ts`) from the launch flow
(`src/bun/rpc-handlers/tmux-pty.ts`). The CLI `--permission-mode` flag stays
(it wins for the lead by precedence); the settings entry is the teammate
baseline. It is always written to `settings.local.json` (local scope,
gitignored) so it never leaks into a committed `settings.json`.

## Risks

- `settings.local.json` `defaultMode` also applies to the auto-review agent
  sharing the worktree — acceptable, it mirrors the chosen task mode.
- Cloud sessions (Claude Code on the web) silently ignore
  `defaultMode: bypassPermissions`/`dontAsk` from settings files — not a concern
  for dev3's local desktop launches, but noted.

## Alternatives considered

- **Env var for default mode** — no documented env var sets `defaultMode`;
  rejected.
- **Pre-approving a broad `permissions.allow` allowlist** — more granular but
  brittle and noisy; `defaultMode` is the doc-recommended path.
- **Doing nothing / relying on CLI flag inheritance** — the flag does not give
  teammates a baseline, which is the bug.
