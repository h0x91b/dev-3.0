# 050 — Auto-approve project MCP servers in dev3 worktrees

## Context

Claude Code 2.1.x prompts the user on every launch when it finds servers in
`.mcp.json` that have not yet been approved for the current project. For dev3
users this fires on **every new worktree**, because the gitignored
`.claude/settings.local.json` (where Claude stores approvals) is never
carried over by `git worktree`. The user has to re-tick the same set of MCP
servers each time a task spawns.

## Investigation

Reverse-engineering `@anthropic-ai/claude-code/cli.js` (v2.1.143):

- Source-of-truth for approvals is the `localSettings` source, which maps to
  `<cwd>/.claude/settings.local.json`. The legacy `~/.claude.json
  projects[<path>].enabledMcpjsonServers` field is no longer read by the new
  approval flow.
- The approval check is:
  ```
  if (disabledMcpjsonServers.includes(name)) → rejected
  if (enabledMcpjsonServers.includes(name) || enableAllProjectMcpServers) → approved
  otherwise → pending  (triggers prompt)
  ```
- The user picking "yes_all" persists `{ enableAllProjectMcpServers: true }`
  into `localSettings`.

So writing `enableAllProjectMcpServers: true` into the worktree's
`.claude/settings.local.json` is the exact equivalent of the user clicking
"yes_all", and silences the prompt for any current or future server in
`.mcp.json`.

## Decision

`ensureClaudeTrust` (`src/bun/agents.ts`) now also takes a `projectPath` and,
when the worktree has a `.mcp.json`, merges MCP-related fields into
`<worktree>/.claude/settings.local.json`:

- Default: `{ enableAllProjectMcpServers: true }`.
- Overrides: any `enableAllProjectMcpServers`, `enabledMcpjsonServers`,
  `disabledMcpjsonServers` already present in
  `<projectPath>/.claude/settings.json` or `.../settings.local.json`. The
  later wins, mirroring Claude Code's own source-precedence order.
- Existing fields in the worktree's `settings.local.json` are preserved
  (permissions, hooks, etc.).

Call-site: `src/bun/rpc-handlers/tmux-pty.ts` passes `project.path` alongside
`worktreePath`.

A pure helper `mergeMcpApproval(existing, projectSources)` is exported and
covered by unit tests in `src/bun/__tests__/agents.test.ts`.

## Risks

- We auto-approve **all** servers from the project's `.mcp.json`. This is the
  same trust level we already grant by bypassing the trust dialog —
  consistent with how dev3 treats user-owned worktrees. If the user wants to
  opt out, they can set `enableAllProjectMcpServers: false` in
  `<projectPath>/.claude/settings.local.json` and we will honor it.
- If Claude Code changes the `localSettings` file location again, this seed
  becomes a no-op (the prompt returns). The reverse-engineering of the
  approval check is documented above so a future agent can re-derive it.

## Alternatives considered

- **Enumerate server names from `.mcp.json` into `enabledMcpjsonServers`.**
  Safer (any *new* server added later still prompts) but defeats the goal —
  the user would just keep getting prompts for every newly added server.
- **Copy `<projectPath>/.claude/settings.local.json` wholesale.** Clean, but
  users typically never run `claude` in the main project (only via dev3
  worktrees), so the source file is empty and nothing propagates.
- **Persist approvals back from the worktree to a dev3-owned store and seed
  new worktrees from it.** Most robust, but requires watching/snapshotting
  the worktree's settings file — overkill for the current pain point.
