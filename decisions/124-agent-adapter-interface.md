# 124 — AgentAdapter interface for per-agent behavior (design)

**Status:** Implemented (2026-07). Design crystallized from a grilling session
on candidate #02 of the `/improve-codebase-architecture` review; realized in
`src/shared/agent-adapters/` (pure adapters + registry) with thin executors in
`src/bun` (command assembly in `agents.ts` `resolveAgentCommand`, trust in
`tmux-pty.ts` `ensureAgentTrust`, hooks in `agent-hooks.ts` `setupAgentHooks`).
See **Implementation notes** below for the refinements to the sketched interface.

## Context

Support for the five coding agents (claude / codex / gemini / cursor / opencode)
is expressed as inline `if (isCodexCommand()) … else if (isGeminiCommand()) …`
ladders repeated across ≥4 files:

- `src/bun/agents.ts` `resolveAgentCommand` (~477-687) — resume flags,
  pre-assigned session id, `--model`/skip-model, permission-mode mapping (each
  agent uses a different flag), effort, budget, system-prompt channel, prompt
  style, the Codex theme profile and resume subcommand.
- `src/bun/rpc-handlers/tmux-pty.ts` `ensureAgentTrust` (~330-371) — Claude vs
  Codex vs Gemini trust setup.
- `src/bun/agent-hooks.ts` `setupAgentHooks` (37-54) — hooks by agent kind.
- `src/bun/agent-skills.ts` — per-agent skill-body constants.

Agent identity is **checked** everywhere instead of **delegated** once. Five
agents already justify a seam; a sixth means hunting down every ladder.

## Investigation

- `src/shared/llm-provider.ts` already implements this exact "registry over
  ladder" pattern for the **provider** axis: `PROVIDER_REGISTRY` +
  `ProviderDefinition.mapFamily()`, with the documented property "no call site
  special-cases a provider." Live precedent for the same move on the agent axis.
- The **descriptor / executor** split already exists in the codebase:
  `buildClaudeHooks`/`buildCodexHooks` are pure (return `HookMap` data) while
  `writeClaudeHooks`/`writeCodexHooks` do the I/O; `ensureCodexConfig(content)→string`
  is pure while `ensureCodexTrust` does the file read/write. The design follows
  this existing grain rather than inventing a shape.
- Predicate usage: `isClaudeCommand` has ~20 uses, many in **Claude-only feature**
  code that is orthogonal to per-agent launch (managed accounts, statusLine,
  Bedrock provider, `CLAUDE_DEFAULT_ENV`, MCP pre-approval). The other four
  predicates have 7-9 uses each, concentrated on the launch/trust/hooks axes.
- Cursor and OpenCode are **not** "generic": they have real per-agent command
  flags (`--mode`/`--force`, `--prompt`, `--session`, `--agent`, …), so they need
  full adapters — `GenericAdapter` is only the fallback for unknown/custom commands.

## Decision

Introduce an `AgentAdapter` abstraction, one implementation per agent
(`Claude`, `Codex`, `Gemini`, `Cursor`, `OpenCode`) plus an explicit
`GenericAdapter` base case, selected by the base-command last segment (reusing
the `agentKey` pattern from `llm-provider.ts`). Call sites become
`adapter.launchArgs(...)` / `adapter.trustPatch(...)` etc. — no more `is*Command`
ladders on the launch/trust/hooks/skill axes.

Concrete choices (from the grilling tree):

1. **Shape — descriptor + executor (pure core).** Adapters are pure and return
   *data*: `launchArgs(): string[]`, hook specs, trust patches (data, not
   writes), `skillBody` string. A thin executor in `src/bun` applies the fs/spawn
   I/O. Delivers "unit-test each adapter without a PTY" and mirrors the existing
   `build*`/`write*` split.
2. **Seam width — full per-agent launch surface.** Behind the seam: command-arg
   construction (resume, session-id, model/skip-model, permission-mode mapping,
   effort, budget, system-prompt channel, prompt style), capability predicates
   (`supportsResume`, `supportsPreAssignedSessionId`), trust setup, hooks, skill
   body. **In front of the seam (stay Claude-specific):** env defaults, managed
   account env, LLM provider/Bedrock coordination, statusLine, MCP pre-approval —
   these are Claude *features*, not per-agent-identity axes, and the provider one
   already has its own registry.
3. **Command cutting — each adapter builds its whole arg list.** Once untangled,
   almost every flag is agent-specific, so a single `launchArgs()` per adapter is
   the truest locality ("all of Codex lives in `CodexAdapter`"). Shared low-level
   helpers (`shellEscape`, `quoteIfUnsafe`) remain shared utilities.
4. **Predicates — remove four, keep `isClaudeCommand`.** codex/gemini/cursor/
   opencode predicates are absorbed into adapters and deleted; `isClaudeCommand`
   survives for the excluded Claude-feature code above.
5. **Placement — pure core in `src/shared/agent-adapters/`, executor in
   `src/bun`.** The skill-body constants move from `src/bun/agent-skills.ts` into
   `src/shared` (they are pure strings; `src/shared` must not import `src/bun`),
   so an adapter's `launchArgs` can inject the system prompt itself and stay
   self-contained.
6. **Migration — incremental.** (1) introduce interface + registry +
   `GenericAdapter`; (2) migrate `resolveAgentCommand` first under a golden test;
   (3) trust + hooks; (4) remove the four predicates last. `is*Command` stay as
   delegating wrappers during the transition.
7. **Regression safety — golden/characterization test.** Snapshot
   `resolveAgentCommand` output across an (agent × config × options) matrix
   *before* the refactor; the refactor must reproduce byte-identical strings.
   Plus per-adapter contract tests. Command strings are load-bearing — a reordered
   flag or lost quote breaks launches.

## Risks

- **Flag order is load-bearing.** "Each adapter builds its own list" risks
  drifting the common structure/order between agents — mitigated by shared helpers
  and, decisively, the byte-identical golden test taken before the refactor.
- **The seam is intentionally not 100%.** `isClaudeCommand` survives for
  accounts/statusLine/provider/env/MCP. Accepted: those are orthogonal features,
  not the agent-identity axis this seam targets.
- **Moving skill bodies to `src/shared`** touches the installer imports in
  `agent-skills.ts` — mechanical, but must keep the launcher's system-prompt
  injection identical (covered by the golden test).
- Untouched invariants: no change to the `~/.dev3.0/` on-disk layout
  (decision 040) and no rewiring of the task lifecycle. `src/shared ↛ src/bun`
  dependency direction is preserved.

## Alternatives considered

- **OO interface whose methods do their own I/O** — closest 1:1 with today's
  functions, but needs fs/spawn mocks to test and forces the whole thing into
  `src/bun`. Rejected in favor of the pure descriptor + executor split.
- **Pure-data registry only (à la `ProviderDefinition`)** — cannot hold the real
  I/O behavior (trust/hook writes); would leave those ladders alive.
- **Declarative-trio-only seam** (trust+hooks+skill, leave the command ladder) —
  leaves the largest, most-repeated ladder in place; fails the candidate's own
  deletion test.
- **Remove all five predicates** — drags the orthogonal env/provider axes into the
  adapter, contradicting the chosen seam width.
- **Big-bang migration in one PR** — a risky diff on the load-bearing launch path;
  harder to review and to catch regressions than the incremental sequence.
- **Nullable adapter + call-site guards** — keeps conditional noise and re-admits
  per-site divergence; the explicit `GenericAdapter` base case removes all null
  checks.

## Implementation notes

Refinements to the sketched interface, decided while making the migration
byte-identical (guarded by the Seam A golden test,
`src/bun/__tests__/agent-command-golden.test.ts`):

- **`launchArgs` returns the whole command token list (base command first)**, not
  just the args, because Codex's resume form injects a `resume <id>` subcommand
  *between* the base command and the rest. The executor just `.join(" ")`s it.
- **Trust is data via `readonly trustKinds: TrustKind[]`**, not a `trustPatch()`
  method. Each adapter declares the trust routines it needs *in order*, and every
  adapter's list starts with `"claude"` — the pre-refactor `ensureAgentTrust`
  applied `ensureClaudeTrust` to *every* agent (a harmless `~/.claude.json`
  superset + MCP pre-approval), so encoding it per-adapter keeps behavior
  byte-identical while still removing the `isCodexCommand`/`isGeminiCommand`
  branches. The executor iterates and calls the matching `ensure*` I/O.
- **`hooksSpec()` returns a discriminated `{kind}` descriptor**; the executor
  dispatches to the existing pure `build*Hooks` + `write*Hooks` split rather than
  a generic writer, since Claude and Codex hook I/O differ substantially.
- **`GenericAdapter` injects NO skill body.** The decision text says "generic
  skill delivered via the prompt argument," but that describes Cursor/OpenCode
  (which have full adapters). The true unknown-command fall-through never appended
  a body — only emitted `--model`/`--permission-mode`/`--effort`/`--max-budget-usd`
  + a positional prompt — so `GenericAdapter` matches that exactly. Byte-identity
  wins over the prose.
- **Codex's impure runtime is threaded in via options.** The active-UI-theme →
  profile/theme mapping and the feature-detected `--profile`/`--profile-v2` flag
  (a `codex --help` probe) are resolved in `resolveAgentCommand` and passed as
  `AdapterLaunchOptions.codex`, so `CodexAdapter` stays pure.
- **`isClaudeCommand` kept; the other four predicates deleted.** The Codex
  account-env feature (orthogonal to the seam) now gates on `agentKey(cmd) ===
  "codex"` instead of `isCodexCommand`, so no per-agent predicate survives outside
  `isClaudeCommand`.
