# omp as a first-class agent

## Context

h0x91b/dev-3.0#1544 asks for native support for [oh-my-pi](https://github.com/can1357/oh-my-pi)
(`omp`) and [pi](https://github.com/earendil-works/pi), with parity with Claude Code. This change
covers omp alone, to keep the first surface small enough to validate; pi follows separately. omp
already launches as a custom agent, but `GenericAdapter` delivers no dev3 protocol, cannot resume,
and emits `--permission-mode`, `--effort` and `--max-budget-usd`, none of which omp defines.

## Investigation

Checked against omp/18.1.18, not just its docs:

- **`--append-system-prompt` reads a file** when the value names one — verified by putting a
  distinctive instruction in a file and watching the model obey it.
- **Credentials live in SQLite** (`~/.omp/agent/agent.db`, table `auth_credentials`). There is no
  `auth.json`.
- **An invalid `--approval-mode` is ignored silently**: no error, no warning, and the session runs at
  its configured default, which upstream ships as `yolo`.

omp also takes `--model`, `--thinking` (dev3's four effort levels are all valid), a positional prompt
after `--`, `-c` to continue and `--resume <id>`, and space-separated flag values despite its
`=`-style help. It has no flag to pre-assign a session id. Skills come from `~/.omp/agent/skills/`,
with the other tools' directories at lower precedence. Automatic status would come from TypeScript
extension modules loaded with `--hook`, which expose `session_start`, `turn_start`/`turn_end`,
`tool_execution_*` and `agent_end`.

## Decision

One adapter (`src/shared/agent-adapters/omp.ts`), a `DEFAULT_AGENTS` entry, the `AgentFamily`
union, and omp's skill directories. Choices worth recording:

- **Every permission mode maps onto an approval tier, and the map is total** (`omp-flags.ts`,
  typed on `PermissionMode`): `acceptEdits` → `write`, `bypassPermissions` and `dontAsk` → `yolo`,
  and `default`, `plan` and `auto` → `always-ask`. On every other CLI "no flag" means "ask me", so
  an unmapped mode is harmless there; on omp it means the configured tier, `yolo` out of the box,
  so the adapter always emits the flag and the modes without a tier of their own fail closed.
  There is no plan preset, because omp enters plan mode from its `plan.defaultOnStartup` setting,
  not a launch flag; `auto` has no classifier-gated tier to land on. A preset whose
  `additionalArgs` already names `--approval-mode` or `--thinking` keeps its own value and the
  adapter adds nothing, so the shipped Bypass presets never carry `--thinking` twice.
- **Presets follow Claude's shape.** The unattended mode, Bypass (`yolo`), comes at every thinking
  level from `off` to `max`; Default and Accept Edits appear once, with no thinking variants —
  just as Claude's Auto and Bypass carry the effort range while Default, Plan and Accept Edits do
  not. The levels ride `additionalArgs`, because `EffortLevel` has no `off` or `max`.
- **No preset pins a model.** omp reaches 60+ providers, so a pinned id may be one the user holds no
  credentials for. The picker already labels a model-less preset "Agent's own default", localized.
- **The protocol travels as a file.** `systemPromptFileFor` in `src/bun/agents.ts` now covers omp;
  an inline copy sits in argv, which is what `pkill -f` matches (h0x91b/dev-3.0#1734).
- **Skills are invoked as `/skill:<name>`**, so `skillInvocationPrefix` gained that value. Without it
  the bug-hunter launcher types a slash command omp does not recognize. The generic protocol body
  still spells `/dev3-share-artifact`, `/dev3-project-config` and `/dev3-tmux` as bare slash
  commands, which omp does not resolve; Codex has the same gap (it wants `$`), and a per-harness
  body is a change of its own, so the prefix reaches only the launcher today.
- **No sign-in probe.** `harness-readiness.ts` reads JSON credential stores and omp has none; a
  guessed path would report a working install as logged out and block the sandbox on our ignorance.
- **The install hint is the upstream curl installer, not the Homebrew tap.** The tap's formula
  installs the binary read-only (`chmod 0555`), which fights omp's own self-updater (`omp update`);
  the installer puts a user-owned binary in `~/.local/bin` that `omp update` replaces in place.
- **No worktree trust.** The status-hook work needs omp's project-trust gate anyway, so it lands there.

Status stays manual, via the generic `SKILL.md`.

## Risks

Because a bad approval value fails silently into `yolo`, a typo in `OMP_APPROVAL_MODE` would
auto-approve everything rather than error; the adapter test pins the exact strings for that reason,
and `additionalArgs` remains the one way to hand omp a tier the map does not — deliberately, since
that is the user's own word.
Recovery resumes omp's most recent session (`-c`), so two omp sessions in one worktree can come back
as the wrong conversation. A future sign-in probe reading `agent.db` would be betting on a SQLite
schema that carries its own `auth_schema_version`.

## Alternatives considered

*Leave omp as a custom agent* — rejected: no protocol, no resume, and flags omp does not define.
*Land pi in the same change* — rejected: pi differs exactly where dev3 cares (no permission modes at
all, a pre-assignable session id), and one agent is a smaller surface to validate first.
*Automatic status in the same change* — rejected: it means shipping and maintaining a TypeScript
extension against a fast-moving plugin API, which is a decision of its own.
