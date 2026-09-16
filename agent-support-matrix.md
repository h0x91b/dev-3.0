# Agent Support Matrix

Feature compatibility across supported AI coding agents.

Last updated: 2026-09-16

> **This matrix is now an interface, not prose.** The per-agent launch/trust/
> hooks/skill differences live behind one `AgentAdapter` per agent
> ([decision 124](decisions/2026/07/11/agent-adapter-interface.md)), in
> `src/shared/agent-adapters/` (pure descriptors + registry, keyed by base
> command with an explicit `GenericAdapter` fallback), applied by thin executors
> in `src/bun`. Column → interface member: *System prompt injection / Session
> resume / Targeted recovery / Permission mode / Effort / Max budget / Model
> selection / Agent selection* → `launchArgs()` (plus `supportsResume` /
> `supportsPreAssignedSessionId` / `buildResumeCommand`); *Auto-trust worktree* →
> `trustKinds`; *Status hooks* → `hooksSpec()`; *Skill injection* → `skillBody`.
> Adding an agent is one new adapter file registered in `registry.ts`, and the
> type-checker enumerates every member to fill in. The Claude-only rows (*LLM
> provider*, *Rate-limit tracking*, managed accounts, MCP pre-approval) stay
> outside the seam, keyed by `isClaudeCommand`.

## Agents

| Agent | CLI binary | Skill directories |
|-------|-----------|-------------------|
| Claude Code | `claude` | `~/.claude/skills/dev3/`, `~/.claude/skills/dev3-project-config/`, `~/.claude/skills/dev3-tmux/`, `~/.claude/skills/dev3-bug-hunter/`, `~/.claude/skills/ask-dev3/`, `~/.claude/skills/dev3-share-artifact/`, `~/.claude/skills/dev3-coordinator/` |
| Cursor Agent | `agent` | `~/.cursor/skills/dev3/`, `~/.cursor/skills/dev3-project-config/`, `~/.cursor/skills/dev3-tmux/`, `~/.cursor/skills/dev3-bug-hunter/`, `~/.cursor/skills/ask-dev3/`, `~/.cursor/skills/dev3-share-artifact/`, `~/.cursor/skills/dev3-coordinator/` |
| Codex | `codex` | `~/.codex/skills/dev3/`, `~/.codex/skills/dev3-project-config/`, `~/.codex/skills/dev3-tmux/`, `~/.codex/skills/dev3-bug-hunter/`, `~/.codex/skills/ask-dev3/`, `~/.codex/skills/dev3-share-artifact/`, `~/.codex/skills/dev3-coordinator/` |
| Gemini CLI | `gemini` | `~/.agents/skills/dev3/`, `~/.agents/skills/dev3-project-config/`, `~/.agents/skills/dev3-tmux/`, `~/.agents/skills/dev3-bug-hunter/`, `~/.agents/skills/ask-dev3/`, `~/.agents/skills/dev3-share-artifact/`, `~/.agents/skills/dev3-coordinator/` |
| GitHub Copilot CLI | `copilot` | `~/.agents/skills/dev3/`, `~/.agents/skills/dev3-project-config/`, `~/.agents/skills/dev3-tmux/`, `~/.agents/skills/dev3-bug-hunter/`, `~/.agents/skills/ask-dev3/`, `~/.agents/skills/dev3-share-artifact/`, `~/.agents/skills/dev3-coordinator/` |
| OpenCode | — | `~/.opencode/skills/dev3/`, `~/.config/opencode/skills/dev3/`, `~/.opencode/skills/dev3-project-config/`, `~/.config/opencode/skills/dev3-project-config/`, `~/.opencode/skills/dev3-tmux/`, `~/.config/opencode/skills/dev3-tmux/`, `~/.opencode/skills/dev3-bug-hunter/`, `~/.config/opencode/skills/dev3-bug-hunter/`, `~/.opencode/skills/ask-dev3/`, `~/.config/opencode/skills/ask-dev3/`, `~/.opencode/skills/dev3-share-artifact/`, `~/.config/opencode/skills/dev3-share-artifact/`, `~/.opencode/skills/dev3-coordinator/`, `~/.config/opencode/skills/dev3-coordinator/` |
| Oh My Pi | `omp` | `~/.omp/agent/skills/dev3/`, `~/.omp/agent/skills/dev3-project-config/`, `~/.omp/agent/skills/dev3-tmux/`, `~/.omp/agent/skills/dev3-bug-hunter/`, `~/.omp/agent/skills/ask-dev3/`, `~/.omp/agent/skills/dev3-share-artifact/`, `~/.omp/agent/skills/dev3-coordinator/` |

## Feature Matrix

| Feature | Claude Code | Cursor Agent | Codex | Gemini CLI | OpenCode | GitHub Copilot CLI | Oh My Pi |
|---------|:-----------:|:------------:|:-----:|:----------:|:--------:|:------------------:|:--------:|
| **Skill injection** | Yes (`!` command syntax) | Yes (generic) | Yes (generic) | Yes (generic) | Yes (generic) | Yes (generic, via the shared `~/.agents/skills/` alias) | Yes (generic, `/skill:` prefix) |
| **System prompt injection** | `--append-system-prompt` | via prompt arg | `-c developer_instructions=...` (developer-role message; covers scratch + resume — see decision 115) | — | via `--prompt` | `sessionStart` hook `additionalContext` (covers scratch + resume; never on the command line) | `--append-system-prompt <file>` |
| **Session resume** | `--resume <id>` / `--continue` | `--resume <id>` / `--continue` | `resume <id>` / `resume --last` | `--resume <id>` / `--resume latest` | `--continue` | `--resume=<id>` / `--continue` | `--resume <id>` / `-c` |
| **Targeted recovery** (resume the *exact* session, incl. multi-session worktrees) | Yes — pre-assign `--session-id` | Yes — pre-assign `--resume <uuid>` | Yes — session id captured per-pane from the lifecycle hook (`session_id` + `$TMUX_PANE`); no launch flag exists (see decision 125) | Yes — pre-assign `--session-id` (gemini-cli #26060; **not** version-guarded) | No — resume-last only (`--session` is resume-only) | Yes — pre-assign `--session-id <uuid>` (a non-UUID string is refused), and the hooks also report the id per pane | No — `--resume` selects an existing session |
| **Permission mode** | `--permission-mode` | `--mode plan` / `--force` | `--permission-mode` | `--approval-mode` | — | `--mode plan` / `--allow-tool write` / `--allow-all-tools` (`--no-ask-user`) / `--allow-all` | `--approval-mode always-ask\|write\|yolo`, always explicit — `default`, `plan` and `auto` say `always-ask`, since no flag means omp's own tier (`yolo` out of the box) |
| **Effort level** | `--effort` | — | `--effort` | — | — | `--effort`, on a named reasoning model only — `--model auto` refuses it and the launch never starts, so the adapter drops it there | `--thinking` |
| **Max budget** | `--max-budget-usd` | — | `--max-budget-usd` | — | — | — (Copilot budgets in AI credits, not dollars) | — |
| **Model selection** | `--model` (omitted on a third-party provider — see below) | `--model` | `--model` | `--model` | `--model` | `--model` (the account's plan decides which names it will accept; `auto` always does). Copilot also persists its own default in `~/.copilot/settings.json` via `/config model`; dev3's flag overrides it per launch | `--model` |
| **LLM provider (backend)** | Anthropic / Amazon Bedrock (per-agent toggle) | — | — | — | — | — | — |
| **Model roles (model catalog)** | Yes — Fable / Opus / Sonnet / Haiku slots, delivered as `ANTHROPIC_DEFAULT_<SLOT>_MODEL` + a rewritten `--model` | — | Yes — main / default-subagent / review, delivered as `-c` overrides (never written to `~/.codex`) | — | — | — | — (omp's 9 roles unbound) |
| **Agent selection** | — | — | — | — | `--agent` | — | — |
| **Auto-trust worktree** | Yes (`ensureClaudeTrust`) | — | Yes (`ensureCodexTrust`) | Yes (`ensureGeminiTrust`) | — | Yes (`ensureCopilotTrust` → `config.json` `trustedFolders`) | — |
| **Status hooks (automatic)** | Yes (6 hooks) | — | Yes (6 worktree-local hooks, automatically trusted) | — | — | Yes (5 hooks inline in `~/.copilot/settings.json`, guarded on `DEV3_TASK_ID`) | — (extension, planned) |
| **Status management** | Automatic via hooks | Manual (SKILL.md) | Automatic via hooks with `user-questions`/legacy-session fallback | Manual (SKILL.md) | Manual (SKILL.md) | Automatic via hooks, `user-questions` included (read off the `ask_user` tool, not an event) | Manual (SKILL.md) |
| **Rate-limit tracking** | Yes (statusLine wrapper injected via `--settings`, `dev3 statusline`) | — | Yes (rollout files + cached live monthly credits via `codex app-server`) | — | — | — | — (`omp usage` unread) |
| **dev3 artifact starter** | Yes (`DEV3_ARTIFACT_TEMPLATE_DIR`, restored by `dev3 artifact-template`) | Yes | Yes | Yes | Yes | Yes |

## Status Hooks

Injected per-worktree at task launch.

### Claude Code

Injected into `.claude/settings.local.json`.

| Hook event | Status transition | Purpose |
|------------|------------------|---------|
| `UserPromptSubmit` | → `in-progress` | User sent a message, agent starts working. A **second** entry on the same event, `dev3 hook claude-prompt`, reads the payload's `prompt` and `prompt_id` and reports the submission for Agent traffic; the status-move entry above is untouched, so recording can never cost a task its board position |
| `PreToolUse` | → `in-progress` | Agent is about to call a tool (also catches post-permission resume) |
| `PostToolUse` | → `in-progress` | A tool finished, including answers submitted to `AskUserQuestion` |
| `PermissionRequest` | → `user-questions` | Agent needs user approval for a tool call |
| `Stop` | → `review-by-user` | Agent finished its turn |
| `StopFailure` | → `user-questions` | An API error (usage limit, auth, billing, server) ended the turn. Fires **instead of** `Stop`, so without it the task would keep claiming the agent is working. Routed through `dev3 hook claude-stop-failure`, which also raises the attention badge and a desktop notification naming the reset time |

Codex has no equivalent event — a Codex session that runs out of quota is still only visible in the rate-limit indicator.

### Codex

Generated in each task's `.codex/hooks.json` and **declared in `~/.codex/config.toml`**, enabled there by `[features] hooks = true` (`codex_hooks = true` before Codex 0.129). Current Codex deliberately reads project hooks from the root checkout instead of a linked worktree, so the user-level config is the only source that reaches a dev3 worktree at all. That source is loaded in *every* Codex session on the machine, so each declared command is guarded on `DEV3_TASK_ID` — the env var dev3 injects into every task pane — and a session the user started themselves spawns no dev3 process (h0x91b/dev-3.0#1527). The guard is POSIX-only: on Windows Codex may run hook commands through `cmd.exe` or PowerShell depending on the session shell, so the command stays bare there and the hooks still wake up in unrelated Windows sessions. dev3 never persists hook trust and never trusts unrelated user/project/plugin hooks; its own launches pass `--dangerously-bypass-hook-trust`, and an untrusted declaration is simply skipped by Codex everywhere else. The Codex skill forbids duplicate manual normal-lifecycle moves; semantic questions, custom columns, and explicit completion remain manual. `PermissionRequest` runs on Codex 0.122+; older hook parsers ignore that unknown event while retaining the others.

| Hook event | Status transition | Purpose |
|------------|------------------|---------|
| `SessionStart` | → `in-progress` | Marks startup/resume turns as active |
| `UserPromptSubmit` | → `in-progress` | User sent a message, agent starts working |
| `PreToolUse` | → `in-progress` | Agent is about to use Bash, apply a patch, or call an MCP tool |
| `PermissionRequest` | → `user-questions` | Codex is waiting for a tool or network approval |
| `PostToolUse` | → `in-progress` | Clears the waiting state after an approved tool finishes |
| `Stop` | → `review-by-ai` / `review-by-user` | One atomic server-side transition selects the correct review target and returns valid JSON to Codex |

The `UserPromptSubmit` payload also carries the submitted `prompt` and a `turn_id`, both forwarded on the existing `task.agentHook` request so a human's terminal prompt reaches Agent traffic without a second dev3 process per prompt. Whether a submission was the human is decided app-side against the receipts dev3 leaves for everything it types itself (`decisions/2026/09/10/prove-a-terminal-prompt-is-the-user.md`).

Beyond status, the `SessionStart`/`UserPromptSubmit` hook payloads carry the Codex `session_id` (the resumable rollout id), and the hook process inherits `$TMUX_PANE`. dev3 records that id onto the matching `sessionState` pane so recovery can `codex resume <id>` the exact per-pane session — Codex has no launch-time session-id flag, so this is the only way to target a specific session (see decision 125).

### GitHub Copilot CLI

Merged into the `hooks` field of `~/.copilot/settings.json` (or
`$COPILOT_HOME/settings.json`), replacing dev3's previous entries and leaving
everyone else's alone.

**Not** a private `~/.copilot/hooks/dev3.json`, which is the tidier-looking option
and the one this shipped with first: that directory can belong to **root**. A
managed machine's MDM creates it to drop its own policy hook in, and every later
write by the user's own processes dies with `EACCES` — so the hooks were silently
never installed and the board simply stopped following Copilot tasks. `settings.json`
lives in the Copilot home itself, which Copilot maintains as the user, so it is
writable wherever Copilot runs at all. The documented repository-level
`.github/hooks/` source was **not** consulted in a fresh checkout on 1.0.83 either.

Like Codex's, this source loads in *every* Copilot session on the machine, so each
command is guarded on `DEV3_TASK_ID` and a session the user started themselves
spawns no dev3 process. Copilot picks the `bash` or the `powershell` entry by
platform itself, so only this machine's dialect is ever written.

Folder trust lives in the *other* file. `ensureCopilotTrust` registers each
worktree's resolved path in `trustedFolders` in `~/.copilot/config.json`, so the
agent does not open on **Confirm folder trust** in a pane nobody is watching.
Measured on 1.0.83 with one variable changed at a time: the same folder listed in
`settings.json` still shows the dialog, and listed in `config.json` does not.
That file also carries the signed-in account, so dev3 merges into it and leaves
one it cannot parse untouched.

| Hook event | Status transition | Purpose |
|------------|------------------|---------|
| `sessionStart` | → `in-progress` | Marks startup/resume turns as active — **and answers with the dev3 protocol as `additionalContext`**, which is Copilot's only out-of-band instruction channel |
| `userPromptSubmitted` | → `in-progress` | User sent a message. The payload carries the `prompt`; Copilot has no per-submission id, so its millisecond `timestamp` stands in as the de-duplication key |
| `preToolUse` | → `in-progress`, or → `user-questions` when `toolName` is `ask_user` | Agent is about to call a tool. Copilot has no "blocked on the human" *event* — asking is a **tool** (`ask_user`, the one `--no-ask-user` disables) and it does not return until the human answers, so its `preToolUse` is that signal |
| `postToolUse` | → `in-progress` | A tool finished — including `ask_user`, which is what releases the task from Has Questions once the answer is in |
| `agentStop` | → `review-by-ai` / `review-by-user` | Agent finished its turn |

`permissionRequest` is deliberately **not** subscribed to. Verified on 1.0.83: it
fires on every permission evaluation, including the ones `--allow-all-tools`
approves without ever showing the user anything, so treating it as "waiting for a
human" would park a working task in Has Questions on its first tool call. Copilot
exposes no event that means the agent is blocked on the user, so a Copilot task
never moves itself into `user-questions`; the skill's manual instruction is the
only route there.

`dev3 hook copilot` always exits 0 with JSON on stdout. That is not politeness:
Copilot treats a non-zero `preToolUse` hook as **fail-closed** and blocks the tool
call outright, so a dev3 that is merely closed must never be able to wedge the
agent. (A hook *timeout* is fail-open for every event, including `preToolUse`.)

`COPILOT_CUSTOM_INSTRUCTIONS_DIRS` was measured and rejected as the protocol
channel: it only lists an `AGENTS.md` for the model to open later — the file's text
never reaches the prompt — so an agent that never opens it never sees the protocol.

## Windows: how generated commands are spelled

Hook commands, the `!`-injected skill lines, and the Claude permission rule are
built from one platform dialect (`hookCliDialect` in `src/shared/dev3-cli-path.ts`).
POSIX output is frozen; Windows differs in three ways:

| Aspect | POSIX (macOS / Linux) | Windows |
|--------|----------------------|---------|
| CLI invocation | `~/.dev3.0/bin/dev3` | absolute path to the bundled `dev3.exe` (`<exec dir>\cli\`, then `Resources\app\cli\`, then `%USERPROFILE%\.dev3.0\bin\`), double-quoted only if it contains spaces |
| App-offline tolerance in Claude hooks | `<cmd> \|\| [ $? -eq 2 ]` | `<cmd> --tolerate-app-offline` (no shell operators; the CLI exits 0 for that one condition) |
| Claude skill `!` injection | `… --if-status-not review-by-ai 2>&1` | same command without `2>&1` |

Codex hooks are identical in shape on both platforms — `dev3 hook codex` always
exits 0, so they never needed a shell fallback. See
[decision 172](decisions/2026/07/26/windows-hook-command-dialect.md).

## Skill Differences

### dev3 (task lifecycle)

The dev3 skill (`SKILL.md`) is installed into each agent's skill directory. Three variants exist:

- **Claude variant** — deliberately short: the full protocol body is already injected into the system prompt via `--append-system-prompt`, so `SKILL.md` only auto-sets the status and shows `dev3 current --brief` (via `!` command injection, zero tool calls). The full body is written to `PROTOCOL.md` next to it as a fallback for sessions started outside the dev3 launcher. See decision 114.
- **Codex variant** — full body; hook-aware status section with manual fallback for older sessions, keeps the `/bin/bash` shell note. The same body is also injected out-of-band as a developer message via `-c developer_instructions=...` on every dev3 launch, including scratch tasks and resume (decision 115); the skill file remains the fallback for sessions started outside the dev3 launcher
- **Generic variant** — full body (for Gemini it is the only protocol channel); full manual status management instructions ("CRITICAL — NON-NEGOTIABLE"), requires agents to run `dev3 task move` at start/end of every turn

All variants teach the same two-step dev3 bug-feedback flow: send the private anonymous vent first, then offer to create a public `h0x91b/dev-3.0` GitHub issue with the `Reported by AI` label after explicit user approval. They also treat an unqualified interactive artifact/report/dashboard request as a likely dev3 HTML artifact while preserving explicit Claude Artifact and build/package meanings. Each receives the same fixed six-file starter map, exact copy command, two-file edit boundary, and `dev3 show-artifact --assets` publish command.

### dev3-project-config (project configuration)

A supplementary skill that teaches agents about `.dev3/config.json` and `.dev3/config.local.json`. Covers the schema, merge priority, when to create/modify config files, and CLI commands (`dev3 config show`, `dev3 config export`). Same content for all agents (no variant differences).

### dev3-bug-hunter (displayed as "dev3 Bug Hunter")

A user-invocable skill that turns the agent into a seeded bug hunter. It generates a random seed, derives an identity letter, chooses a starting area plus analysis style, and then forces the hunt to begin from that assigned area before branching out. The skill is read-only, uses a terminal-friendly findings format with a compact ASCII summary table plus detail sections, asks whether `critical` and `medium` findings should become separate dev3 tasks, and requires those follow-up tasks to validate and reproduce the bug before any fix is attempted. When launched inside an existing task, it skips the main agent's session-start/lifecycle duties and may write only confirmed findings through `dev3 note add`. Same content for all agents.

### dev3-share-artifact (displayed as "dev3 Share Artifact")

A user-invocable skill that publishes a local HTML report — typically a dev3 artifact — as a GitHub gist and hands back a preview URL it has actually opened. It folds the multi-file report into one self-contained file with `dev3 inline-html` (gists are flat and text-only), reuses a recorded `.gist-id` so a re-share updates the same URL instead of duplicating it, defaults to a secret gist, and refuses to publish a page carrying a credential-shaped string (CLI exit `14`) or a missing local asset (exit `13`). Same content for all agents; it carries no machine-specific account mapping and asks the user which `gh` account to publish under when several are authenticated.

### dev3-coordinator (displayed as "dev3 Coordinator")

A user-invocable skill that turns the task the agent is **already running in** into a coordinator, mid-conversation, without touching its history, branch, worktree, title, labels or priority. It carries no copy of the coordinator brief: it runs `dev3 task update --type coordinator --print-role`, which sets the board type, rewrites the description's role preamble as the ordinary type-update path already does, and prints the *effective* brief (project override → Settings override → built-in `COORDINATOR_PROMPT`) to stdout. Printing rather than delivering is the point — the caller is the agent being promoted, so a pane delivery would arrive as a second copy in a second turn. Re-running it is idempotent and re-prints the brief; `--print-role` is refused against any task but the caller's own. The body also names the stale-CLI case — a machine whose `dev3` predates the flag answers `error: Unknown option: --print-role` before writing anything, and the fallback is the plain `dev3 task update --type coordinator`, which promotes identically but delivers the brief into the pane instead of printing it. Nothing promotes a task on install or discovery: the body has no `!`-injected command. Same content for all agents.

**Mid-conversation discovery limit:** a harness lists its skills when the session starts. A session that was already running when dev-3.0 first wrote this file will not offer `/dev3-coordinator` until it restarts; the underlying command works regardless.

For Gemini CLI specifically, dev-3.0 installs these managed skills only via the shared `~/.agents/skills/` alias. Gemini also discovers `~/.gemini/skills/`, but duplicating the same skill name in both user-scope directories triggers same-tier conflict warnings and the alias already has precedence.

omp does not read that shared `~/.agents/skills/` alias; it reads `~/.omp/agent/skills/` plus the
other tools' directories (`~/.claude`, `~/.codex`, `~/.gemini`) at lower precedence, so it gets an
explicit native copy of the generic body rather than inheriting Claude's short variant.

omp is not wired for automatic status yet. It loads TypeScript extension modules through `--hook`,
exposing turn and tool events, which is the channel a future hooks implementation would use; see
[`omp-first-class-agent`](decisions/2026/09/12/omp-first-class-agent.md).

## LLM provider (per-agent backend)

Each agent can run against its **native API** (default) or a registered
third-party backend (today: **Amazon Bedrock** for Claude and for Codex), chosen via a
**per-agent** toggle inside that agent's row in **Settings → Coding Agents**
(`CodingAgent.llmProvider` / `CodingAgent.providerConfig`). dev3's built-in
configs select a model with `--model` using native aliases (e.g.
`claude-opus-4-8[1m]`); third-party providers reject those, so when one is
selected dev3 **omits `--model`** for that agent and injects the provider env
instead (Claude), or rewrites `--model` to the mapped id and appends the routing
args (Codex). Agents on their native provider — and agents with no registered
backend at all (Gemini, …, which show no toggle) — are unaffected.

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
| Bedrock (Claude) | `CLAUDE_CODE_USE_BEDROCK=1`, `ANTHROPIC_MODEL` | alias→`<geo>.anthropic.*` map (geo = `global`/`us`/`eu`/`jp` toggle), or the per-model override |
| Bedrock (Codex) | _(none — `--model <geo>.openai.<family>` + `-c model_provider="amazon-bedrock-runtime"`)_ | same geo toggle; per-model override |

Known model aliases map to provider-native ids automatically
(`src/shared/llm-provider.ts`); unknown/new models are derived from the alias so
dev3 **always pins the model** (the agent never falls back to a different default
than dev3 expects). The settings model-mapping table is pre-populated and
inline-editable per model (Manual badge + Revert); a geo-aware provider's geo
toggle re-prefixes all non-overridden rows. See [decision 089](decisions/2026/07/06/llm-provider-toggle.md).

## Additional Integrations

| Integration | Agents | Details |
|-------------|--------|---------|
| `~/.agents/AGENTS.md` | All (fallback) | Appended rule block for agents that read `AGENTS.md` |
| `~/.agents/skills/*/agents/openai.yaml` | Shared skill UI | Managed display metadata for `dev3`, `dev3-project-config`, `dev3 tmux`, `dev3 Bug Hunter`, `Ask dev3`, and `dev3 Share Artifact` |
| `~/.claude/settings.json` | Claude Code | Auto-adds a `Bash(<dev3 cli> *)` permission — `Bash(~/.dev3.0/bin/dev3 *)` on POSIX, `Bash(<abs path>\dev3.exe *)` on Windows |
| `~/.codex/config.toml` | Codex | Configures trust, creates a fallback `permissions.workspace` default when missing, patches dev3 sandbox access, and enables the Codex hook feature with version-compatible key names. Also holds dev3's status-hook declarations between marker comments; the block is rewritten in place on every launch, dev3 hook entries left outside it (a lost marker) are collected so copies cannot pile up, and hooks the user wrote themselves are never touched. Paths are written as escaped TOML basic strings with native separators, and a config an earlier dev3 made unparsable on Windows is repaired in place on next launch (original copied to `config.toml.dev3-backup`) |
| `<worktree>/.codex/hooks.json` | Codex | Generated, gitignored lifecycle definitions mirrored into each dev3-launched Codex pane as session flags |
| `~/.copilot/settings.json` | GitHub Copilot CLI | dev3 merges its lifecycle hooks into the user's own settings file, replacing only what dev3 wrote before. Nothing is written under `~/.copilot/hooks/`, which can be root-owned on a managed machine |
| `~/.copilot/permissions-config.json` | GitHub Copilot CLI | dev3 pre-approves its own CLI for the project, so an agent is not stopped by "Do you want to run this command?" on the status move its protocol just told it to make. Keyed by the repository's main working tree — which is what Copilot itself writes when the user approves from inside a worktree, so one entry covers every task of that project. Approvals the user granted themselves, and every other repository, are left untouched |
| `~/.copilot/config.json` | GitHub Copilot CLI | dev3 appends the worktree's resolved path to `trustedFolders`, the only place Copilot reads folder trust from. Every other key — including `loggedInUsers` — is copied through untouched, the `//` header is preserved, and a file dev3 cannot parse is left exactly as found rather than risking the login. dev3 honours `COPILOT_HOME` rather than setting it |
