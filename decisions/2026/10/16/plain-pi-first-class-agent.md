# Plain pi as a first-class agent

## Context

h0x91b/dev-3.0#1544 asked for native support for both oh-my-pi (`omp`) and its upstream, pi
(earendil-works/pi). omp landed first (`decisions/2026/09/12/omp-first-class-agent.md`,
`decisions/2026/09/20/omp-status-extension.md`); plain pi still ran only as a custom command — no
protocol, no resume, no status. omp stays exactly as it was; pi is a separate harness, not an alias.

## Investigation

Read against pi `main` 99fe148 (v1.3.0, package `@earendil-works/pi-coding-agent`, binary `pi`) and
driven for real on pi 0.99.2 (the newest the npm mirror serves) in an isolated `HOME`, against a mock
OpenAI-compatible endpoint, with a stand-in dev3 CLI:

- `--append-system-prompt <file>` reads the file (the model received the dev3 protocol).
- `--session-id <id>` opens that project session or creates it; a relaunch with the same id restored
  the transcript. `ctx.sessionManager.getSessionId()` returns it from `session_start` on.
- `--extension <path>` loads the module before project trust; pi has **no** `--hook` and exits on
  an unknown flag. Events used: `session_start`, `input`, `agent_start`, `tool_execution_*`,
  `ui_prompt_start/end`, `agent_settled`.
- `/quit` exits after Ctrl-C. No bare BEL in the pane's raw output across a full turn.
- After `--`, an argument starting with `@` is still read as a file to attach.
- No approval tiers at all (`docs/security.md`): pi runs every tool without asking.

## Decision

`src/shared/agent-adapters/pi.ts`, a `builtin-pi` entry, `"pi"` in `AgentFamily`. Status reuses omp's
runtime, extracted into `src/shared/status-extension-core.ts` (omp's generated module is byte-identical
before and after), with pi's wiring in `src/shared/pi-status-extension.ts`, flag `--extension`, and
`dev3 hook pi` (`src/cli/commands/extension-hook.ts`, shared with omp). Choices:

- **`agent_settled` is the stop**, not `agent_end`, which upstream says retries/compaction can follow.
- **`ui_prompt_*` is the only wait**, mapped to `user-questions`; answered while idle it settles again.
- **Pre-assigned session ids** (`supportsPreAssignedSessionId: true`) make recovery exact.
- **One preset, `Bypass` (id `pi-default`), carrying `bypassPermissions`** — the truth about pi, and the adapter emits
  no permission flag for any mode. No model pinned; effort maps to `--thinking`.
- **No pi skill directory.** pi reads `~/.agents/skills/` (exempt from its trust prompt), where every
  dev3 skill already lives; `/skill:` is the invocation prefix.
- **No sign-in probe or rate limits** for the system login: `auth.json` is one of several credential
  sources (env vars, `models.json`), so absence proves nothing. Managed accounts came later, see
  `pi-managed-accounts-share-the-agent-dir-engine`. Install hint: the README's `pi.dev`
  installers, Windows command verbatim.
- A prompt opening with `@` gets one leading space so pi does not swallow it as a path.

## Risks

The extension API moves; a renamed event silently stops reports. Behaviour was exercised on 0.99.2,
read (not run) on 1.3.0. The fallback `SKILL.md` a pi session sees outside dev3 is the generic,
manual-status one. A user whose repo carries `.pi/` or `.agents/skills` still meets pi's trust prompt
at launch — deliberately left to them, since trusting runs that repo's extensions.

## Alternatives considered

*Reuse the omp adapter/flags* — rejected: `--hook` and `--approval-mode` do not exist in pi.
*Copy omp's extension* — rejected: two diverging copies of the same runtime. *A pi skill directory
under `~/.pi/agent/skills`* — rejected: writes into the user's pi profile for no gain over the shared
alias. *Auto-approve project trust (`--approve`)* — rejected: it would execute repo-supplied code.
