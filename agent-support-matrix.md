# Agent Support Matrix

Feature compatibility across supported AI coding agents.

Last updated: 2026-07-09

## Agents

| Agent | CLI binary | Skill directories |
|-------|-----------|-------------------|
| Claude Code | `claude` | `~/.claude/skills/dev3/`, `~/.claude/skills/dev3-project-config/`, `~/.claude/skills/dev3-bug-hunter/` |
| Cursor Agent | `agent` | `~/.cursor/skills/dev3/`, `~/.cursor/skills/dev3-project-config/`, `~/.cursor/skills/dev3-bug-hunter/` |
| Codex | `codex` | `~/.codex/skills/dev3/`, `~/.codex/skills/dev3-project-config/`, `~/.codex/skills/dev3-bug-hunter/` |
| Gemini CLI | `gemini` | `~/.agents/skills/dev3/`, `~/.agents/skills/dev3-project-config/`, `~/.agents/skills/dev3-bug-hunter/` |
| OpenCode | — | `~/.opencode/skills/dev3/`, `~/.config/opencode/skills/dev3/`, `~/.opencode/skills/dev3-project-config/`, `~/.config/opencode/skills/dev3-project-config/`, `~/.opencode/skills/dev3-bug-hunter/`, `~/.config/opencode/skills/dev3-bug-hunter/` |

## Feature Matrix

| Feature | Claude Code | Cursor Agent | Codex | Gemini CLI | OpenCode |
|---------|:-----------:|:------------:|:-----:|:----------:|:--------:|
| **Skill injection** | Yes (`!` command syntax) | Yes (generic) | Yes (generic) | Yes (generic) | Yes (generic) |
| **System prompt injection** | `--append-system-prompt` | via prompt arg | `-c developer_instructions=...` (developer-role message; covers scratch + resume — see decision 115) | — | via `--prompt` |
| **Session resume** | `--continue` | `--continue` | `resume --last` | `--resume latest` | `--continue` |
| **Permission mode** | `--permission-mode` | `--mode plan` / `--force` | `--permission-mode` | `--approval-mode` | — |
| **Effort level** | `--effort` | — | `--effort` | — | — |
| **Max budget** | `--max-budget-usd` | — | `--max-budget-usd` | — | — |
| **Model selection** | `--model` (omitted on a third-party provider — see below) | `--model` | `--model` | `--model` | `--model` |
| **LLM provider (backend)** | Anthropic / Amazon Bedrock (per-agent toggle) | — | — | — | — |
| **Agent selection** | — | — | — | — | `--agent` |
| **Auto-trust worktree** | Yes (`ensureClaudeTrust`) | — | Yes (`ensureCodexTrust`) | Yes (`ensureGeminiTrust`) | — |
| **Status hooks (automatic)** | Yes (4 hooks) | — | Yes (6 worktree-local hooks, automatically trusted) | — | — |
| **Status management** | Automatic via hooks | Manual (SKILL.md) | Automatic via hooks with `user-questions`/legacy-session fallback | Manual (SKILL.md) | Manual (SKILL.md) |
| **Rate-limit tracking** | Yes (statusLine wrapper injected via `--settings`, `dev3 statusline`) | — | Yes (rollout files + cached live monthly credits via `codex app-server`) | — | — |
| **dev3 artifact starter** | Yes (`DEV3_ARTIFACT_TEMPLATE_DIR`) | Yes | Yes | Yes | Yes |

## Status Hooks

Injected per-worktree at task launch.

### Claude Code

Injected into `.claude/settings.local.json`.

| Hook event | Status transition | Purpose |
|------------|------------------|---------|
| `UserPromptSubmit` | → `in-progress` | User sent a message, agent starts working |
| `PreToolUse` | → `in-progress` | Agent is about to call a tool (also catches post-permission resume) |
| `PermissionRequest` | → `user-questions` | Agent needs user approval for a tool call |
| `Stop` | → `review-by-user` | Agent finished its turn |

### Codex

Generated in each task's `.codex/hooks.json` and enabled via `~/.codex/config.toml` (`[features] hooks = true` on Codex 0.129+, `codex_hooks = true` before that). Current Codex deliberately reads project hooks from the root checkout instead of a linked worktree, so dev3 also injects the same definitions as session flags into every Codex pane. On Codex 0.129+, dev3 asks `hooks/list` for authoritative hashes and adds trust state to that session override only; it never changes `~/.codex/hooks.json`, persists hook trust, or trusts unrelated user/project/plugin hooks. The Codex skill forbids duplicate manual normal-lifecycle moves; semantic questions, custom columns, and explicit completion remain manual. `PermissionRequest` runs on Codex 0.122+; older hook parsers ignore that unknown event while retaining the others.

| Hook event | Status transition | Purpose |
|------------|------------------|---------|
| `SessionStart` | → `in-progress` | Marks startup/resume turns as active |
| `UserPromptSubmit` | → `in-progress` | User sent a message, agent starts working |
| `PreToolUse` | → `in-progress` | Agent is about to use Bash, apply a patch, or call an MCP tool |
| `PermissionRequest` | → `user-questions` | Codex is waiting for a tool or network approval |
| `PostToolUse` | → `in-progress` | Clears the waiting state after an approved tool finishes |
| `Stop` | → `review-by-ai` / `review-by-user` | One atomic server-side transition selects the correct review target and returns valid JSON to Codex |

## Skill Differences

### dev3 (task lifecycle)

The dev3 skill (`SKILL.md`) is installed into each agent's skill directory. Three variants exist:

- **Claude variant** — deliberately short: the full protocol body is already injected into the system prompt via `--append-system-prompt`, so `SKILL.md` only auto-sets the status and shows `dev3 current --brief` (via `!` command injection, zero tool calls). The full body is written to `PROTOCOL.md` next to it as a fallback for sessions started outside the dev3 launcher. See decision 114.
- **Codex variant** — full body; hook-aware status section with manual fallback for older sessions, keeps the `/bin/bash` shell note. The same body is also injected out-of-band as a developer message via `-c developer_instructions=...` on every dev3 launch, including scratch tasks and resume (decision 115); the skill file remains the fallback for sessions started outside the dev3 launcher
- **Generic variant** — full body (for Gemini it is the only protocol channel); full manual status management instructions ("CRITICAL — NON-NEGOTIABLE"), requires agents to run `dev3 task move` at start/end of every turn

All variants teach the same two-step dev3 bug-feedback flow: send the private anonymous vent first, then offer to create a public `h0x91b/dev-3.0` GitHub issue with the `Reported by AI` label after explicit user approval. They also treat an unqualified interactive artifact/report/dashboard request as a likely dev3 HTML artifact, while preserving explicit Claude Artifact and build/package meanings, and require agents to copy the task-local starter before editing it.

### dev3-project-config (project configuration)

A supplementary skill that teaches agents about `.dev3/config.json` and `.dev3/config.local.json`. Covers the schema, merge priority, when to create/modify config files, and CLI commands (`dev3 config show`, `dev3 config export`). Same content for all agents (no variant differences).

### dev3-bug-hunter (displayed as "dev3 Bug Hunter")

A user-invocable skill that turns the agent into a seeded bug hunter. It generates a random seed, derives an identity letter, chooses a starting area plus analysis style, and then forces the hunt to begin from that assigned area before branching out. The skill is read-only, uses a terminal-friendly findings format with a compact ASCII summary table plus detail sections, asks whether `critical` and `medium` findings should become separate dev3 tasks, and requires those follow-up tasks to validate and reproduce the bug before any fix is attempted. Same content for all agents.

For Gemini CLI specifically, dev-3.0 installs these managed skills only via the shared `~/.agents/skills/` alias. Gemini also discovers `~/.gemini/skills/`, but duplicating the same skill name in both user-scope directories triggers same-tier conflict warnings and the alias already has precedence.

## LLM provider (per-agent backend)

Each agent can run against its **native API** (default) or a registered
third-party backend (today: **Amazon Bedrock** for Claude), chosen via a
**per-agent** toggle inside that agent's row in **Settings → Coding Agents**
(`CodingAgent.llmProvider` / `CodingAgent.providerConfig`). dev3's built-in
configs select a model with `--model` using native aliases (e.g.
`claude-opus-4-8[1m]`); third-party providers reject those, so when one is
selected dev3 **omits `--model`** for that agent and injects the provider env
instead. Agents on their native provider — and agents with no registered
backend at all (Codex, Gemini, …, which show no toggle) — are unaffected.

Providers are data, not code: each one is a `ProviderDefinition` in the
`PROVIDER_REGISTRY` (`src/shared/llm-provider.ts`), keyed by an `LLM_PROVIDER` id
(`src/shared/types.ts`) and bound to an agent via its `agentCommand`. Adding a
backend = one id + one registry entry + i18n labels; the toggle, env injection,
and model table all read the registry. The toggle only appears on agents that
have ≥1 registered backend.

dev3 injects only the provider's enable flag + the pinned model (merged into the
launch env; a config's own `envVars` still win). **Credentials, AWS
region/profile are NOT set by dev3** — the customer configures those in their own
global agent setup (shell env / `~/.claude/settings.json`).

| Provider | Injected env | Model id source |
|----------|--------------|-----------------|
| Anthropic | _(none)_ | `--model <alias>` as usual |
| Bedrock | `CLAUDE_CODE_USE_BEDROCK=1`, `ANTHROPIC_MODEL` | alias→`<geo>.anthropic.*` map (geo = `global`/`us`/`eu`/`apac` toggle), or the per-model override |

Known model aliases map to provider-native ids automatically
(`src/shared/llm-provider.ts`); unknown/new models are derived from the alias so
dev3 **always pins the model** (the agent never falls back to a different default
than dev3 expects). The settings model-mapping table is pre-populated and
inline-editable per model (Manual badge + Revert); a geo-aware provider's geo
toggle re-prefixes all non-overridden rows. See [decision 089](decisions/089-llm-provider-toggle.md).

## Additional Integrations

| Integration | Agents | Details |
|-------------|--------|---------|
| `~/.agents/AGENTS.md` | All (fallback) | Appended rule block for agents that read `AGENTS.md` |
| `~/.agents/skills/*/agents/openai.yaml` | Shared skill UI | Managed display metadata for `dev3`, `dev3-project-config`, and `dev3 Bug Hunter` |
| `~/.claude/settings.json` | Claude Code | Auto-adds `Bash(~/.dev3.0/bin/dev3 *)` permission |
| `~/.codex/config.toml` | Codex | Configures trust, creates a fallback `permissions.workspace` default when missing, patches dev3 sandbox access, and enables the Codex hook feature with version-compatible key names |
| `<worktree>/.codex/hooks.json` | Codex | Generated, gitignored lifecycle definitions mirrored into each dev3-launched Codex pane as session flags |
