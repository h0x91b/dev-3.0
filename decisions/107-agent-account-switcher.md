# 107 — Agent account switcher: CLAUDE_CONFIG_DIR dirs for Claude, auth.json swap for Codex

## Context

Users juggling multiple Claude Code / Codex subscriptions need to hot-swap the active
account without re-login. Neither CLI supports multi-account natively: Claude keeps one
login in `~/.claude.json` + Keychain (macOS) or `~/.claude/.credentials.json`; Codex keeps
exactly one login in `~/.codex/auth.json`.

## Decision

Accounts live under `~/.dev3.0/agent-accounts/` (additive tree, registry in `accounts.json`).
Two different swap mechanics, per CLI (`src/bun/agent-accounts.ts`):

- **Claude**: each account is a full `CLAUDE_CONFIG_DIR` directory holding its own
  `.claude.json` + `.credentials.json` (the file WINS over the Keychain in Claude's own
  resolution). Everything user-customized (`settings.json`, `CLAUDE.md`, `skills/`,
  `agents/`, `commands/`, `plugins/`, `projects/`, `todos/`) is **symlinked** into
  `~/.claude`, so statuslines, skills, memory, transcripts and session resume are shared
  across accounts. Activation only flips a registry field; `resolveCommandForAgent`
  injects `CLAUDE_CONFIG_DIR` into new sessions (`applyClaudeAccountEnv` in
  `src/bun/agents.ts`). `ensureClaudeTrust` dual-writes trust into the active account dir.
- **Codex**: each account is a snapshot of `auth.json`. Activation copies the snapshot into
  `~/.codex/auth.json` (same-dir tmp+rename, atomic) after syncing the outgoing login's
  refreshed tokens back into its own snapshot. Active account is *reconciled* from the
  actual `auth.json` content on every list, so out-of-band `codex login` shows as
  "unmanaged" instead of lying.

Adding an account = import current login (macOS Keychain read via
`security find-generic-password -s "Claude Code-credentials" -w`, may prompt once) or a
copy-paste login command verified by the UI (`AgentAccountsSection.tsx`).

- **Claude API profiles** (`auth: "api"`): a third account flavor with no login at all.
  The profile dir stores `api-profile.json` (0600: baseUrl/apiKey/model/extra env);
  `getActiveClaudeSessionEnv` turns it into `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` /
  `ANTHROPIC_MODEL` + the extra vars (covers Bedrock via `CLAUDE_CODE_USE_BEDROCK=1` +
  `AWS_*`, and Anthropic-compatible endpoints like OpenRouter/LiteLLM proxies), injected
  alongside its own `CLAUDE_CONFIG_DIR`. The seeded `.claude.json` pre-approves the key's
  last-20-chars tail in `customApiKeyResponses.approved` so Claude Code skips its
  "detected an API key" prompt (if that internal format ever drifts, the cost is one
  extra prompt — not a failure). The bulk `AgentApiProfileInfo` (in `listAgentAccounts`)
  exposes only `hasApiKey` + env var *names*; the key value is returned solely by the
  on-demand edit draft (see the editable-in-place bullet below).
- **Per-slot model overrides + family-based flag rewrite**: an API profile can override
  each Claude alias slot (Opus/Sonnet/Haiku/Fable) with its own provider model id + optional
  `/model` display name/description, or set one master model for all four. These map to
  `ANTHROPIC_DEFAULT_<SLOT>_MODEL` (+ `_NAME`/`_DESCRIPTION`), which cover aliases,
  background tasks, subagents and the `/model` picker. But dev3 presets launch with a
  **concrete** model id (`claude-opus-4-8[1m]`, not the `opus` alias), and the `--model`
  flag beats those env vars — so alias env alone never binds. `applyModelOverride`
  (`src/bun/agents.ts`) therefore classifies the preset id's family (`claudeModelFamily`)
  and rewrites `--model` to that slot's override (falling back to a bare `ANTHROPIC_MODEL`
  escape hatch). `ANTHROPIC_MODEL` itself is deliberately never set from the profile.
- **Duplicate detection is (accountUuid, organization)**, not accountUuid alone: one
  Claude user can belong to several orgs with the same email/UUID. Colliding emails get
  the org appended to the default label (`registerAccount`).
- **Every switch is confirmed** (`accountsSwitchConfirm*` dialog in both the settings
  section and the launch-picker popover): switching is billing-sensitive — all NEW
  sessions bill to the target account — so it never happens on a bare row click.
- **Stale profile env is actively unset on switch** (`ENV_UNSET` sentinel in
  `src/shared/agent-accounts.ts`): the first agent spawn seeds the long-lived tmux
  *server* env (`-e` flags + client spawn env + `set-environment` loop in
  `pty-server.ts`), so an API profile's `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/model
  vars survive an account switch and hijack the next OAuth session (Claude prefers
  `ANTHROPIC_API_KEY` over OAuth). `getActiveClaudeSessionEnv` therefore marks every
  clearable key (fixed ANTHROPIC_*/CLAUDE_CONFIG_DIR set ∪ all profiles' extra env keys)
  the active selection does not set with the sentinel; consumers translate it —
  `unset KEY` in wrapper scripts (`buildEnvExports`), skipped in real process envs,
  `set-environment -r` in tmux, ignored by `applyModelOverride`. An empty registry
  (feature unused) still returns `{}` and never touches the ambient env.
- **API profiles are editable in place** (`updateClaudeApiProfile`), reusing the add
  form. The edit draft (`getClaudeApiProfileDraft`) returns every field — base URL, model,
  slot overrides, env values, **and the API key** — so the form can prefill and show the
  key masked with a reveal toggle (it is the user's own key; forcing a re-type was worse
  UX than showing it). All of this travels only on an explicit edit-fetch, never in the
  bulk `listAgentAccounts` state, which still exposes only `hasApiKey` + env var names.

## Risks

- Claude may change the file-over-Keychain precedence or start rewriting the symlinked
  entries as real files; both degrade to "account keeps working but stops sharing state".
- A running agent keeps its in-memory token — swaps affect only new sessions (documented in UI).
- `codex login` for a *new* account overwrites the previous login's `auth.json`; we
  auto-snapshot the current login in `prepareCodexLogin` before instructing the user.

## Alternatives considered

- **Keychain-swap for Claude** (claude-swap style): mutates the user's `~/.claude.json`
  and Keychain, affects the user's own terminals, needs a Keychain write per swap. Kept as
  fallback knowledge, rejected as default.
- **CODEX_HOME per account**: would isolate `config.toml`/`sessions` too, breaking the
  dev3-managed trust entries and themed profiles already written into `~/.codex/config.toml`.
