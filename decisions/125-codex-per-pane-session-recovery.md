# 125 — Codex per-pane session recovery via lifecycle hook; Gemini pre-assign

## Context

Automatic session recovery (decision-era PR #431) does *targeted* resume — pin a
session UUID at launch, later `--resume <id>` the exact session — only for agents
that accept a pre-assigned id at launch (`supportsPreAssignedSessionId`: Claude
`--session-id`, Cursor `--resume <uuid>`). Codex, Gemini and OpenCode fell back to
resume-last (`codex resume --last`, `gemini --resume latest`, `opencode --continue`).

For a worktree with one agent that is fine — Codex's `resume` is cwd-scoped, so
`--last` lands on the right session. It breaks with **multiple sessions in one
worktree** (e.g. several bug hunters): every null-id Codex pane resumed
`--last`, i.e. the *same* newest session, instead of each pane's own.

## Investigation (2026-07-11, verified against real binaries)

- **Gemini** now accepts a launch-time `--session-id <uuid>` (gemini-cli PR
  #26060, merged 2026-04-27), semantics like Claude's (rejects a reused UUID).
- **Codex** still has no launch-time session-id flag (canonical openai/codex#7801
  open; 0.144.1 `codex --help`/`codex exec --help` show none). But the dev3 Codex
  lifecycle hook (`dev3 hook codex`, `-c hooks=…`) fires with a payload that
  carries `session_id` (== the resumable rollout id — `transcript_path` in the
  payload is `…/rollout-<ts>-<session_id>.jsonl`), and Codex propagates
  `$TMUX_PANE` to the hook subprocess. Confirmed on `SessionStart` and
  `UserPromptSubmit`. The rollout file (and id) only exist after turn 1, but the
  hook is the natural trigger, so timing is a non-issue: no turn ⇒ nothing to
  recover.
- **OpenCode** `-s, --session` is documented "session id to **continue**"
  (resume-only, not create-with-id), so it cannot pre-assign either; left as-is.

## Decision

1. **Gemini → pre-assign.** Add `isGeminiCommand` to
   `supportsPreAssignedSessionId` (`src/bun/agents.ts`). The existing fresh-launch
   injection emits `--session-id <uuid>` and the resume path emits `--resume <id>`,
   so no other change. **Not version-guarded** (deliberate, per product call): a
   gemini older than PR #26060 will reject `--session-id` at launch — those users
   must upgrade gemini-cli.

2. **Codex → capture, don't pre-assign.** `src/cli/commands/codex-hook.ts` adds
   `paneId` (from `process.env.TMUX_PANE`) to the `task.agentHook` RPC.
   `cli-socket-server.ts` `captureCodexPaneSession` persists the payload's
   `session_id` onto the matching `sessionState.panes` entry: match by `paneId`;
   if none matches and exactly one entry has no paneId, adopt it (the main pane —
   persisted without a paneId, assigned lazily by pane-exit reconciliation),
   recording both its paneId and session id; ambiguous cases are skipped (a later
   hook retries). `resumeTask` already resumes each pane by its stored `sessionId`,
   so once captured Codex resumes with `codex resume <id>` per pane automatically.
   `supportsPreAssignedSessionId` stays **false** for Codex.

## Risks

- Gemini launch breaks on pre-#26060 builds (accepted; documented above).
- Codex capture depends on hooks being enabled (Codex ≥ 0.129) and firing before
  a crash; if not captured, `sessionId` stays null and resume degrades to today's
  `resume --last` — no regression.
- Hook `session_id` must equal the resumable id; verified via `transcript_path`.
  If it ever diverged, `codex resume <id>` would error visibly and the user can
  Start Fresh.

## Alternatives considered

- **Rollout-file scanning + per-pane marker / timestamp matching** to associate a
  Codex session with a pane: rejected — the hook already hands us `(paneId,
  session_id)` directly, no markers, no fs scanning, no heuristics.
- **Version-guarded Gemini `--session-id` via a cached `--help` probe**: designed,
  then dropped at the user's request to keep it simple.
- **OpenCode read-back** via `opencode session list`/storage: deferred — least-used
  agent, `--session` is resume-only, and `--continue` already covers the common case.
