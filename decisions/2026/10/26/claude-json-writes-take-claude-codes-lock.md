# Claude trust writes take Claude Code's lock; the launch handoff waits for SessionStart

## Context

Issue #2034: two Claude tasks launched about a second apart, and one died at Claude Code's trust dialog. Two defects combine. dev3's `writeClaudeTrustEntry` did a plain read-modify-write of `~/.claude.json`, and a concurrent Claude save erased the new entry. Then `deliverLaunchHandoff` typed the peer-launch note as soon as a pane existed, and its Enter picked the dialog's default `No, exit`. No hook fires for a session that never started, so the card stayed on "Agent is Working". #1792 had fixed the typing half with a task-wide readiness gate on every dev3-typed prompt. #1794 reverted it because long-lived, reattached and resumed agents had their messages refused.

## Investigation

From the Claude Code 2.1.310 binary and on disk: Claude saves `.claude.json` under a proper-lockfile mkdir lock at `<file>.lock` (stale after 10 s, retries 200 ms…4 s), re-reads the file under that lock, and replaces it by rename. Measured with an isolated `CLAUDE_CONFIG_DIR` and HOME:

- `SessionStart` does not fire while the trust dialog is up. It fires about 0.5 s after the dialog is accepted, and its `session_id` is the id passed with `--session-id`.
- Typed text plus Enter at the dialog exits 1. Esc exits 0.
- Twelve real Claudes booting while 400 trust keys were written: the old writer lost 190 keys, the locked writer lost 11 to 112. The remaining losses came from Claude itself, logged as `Config lock compromised: Unable to update lock within the stale threshold`. A stalled holder renames its stale snapshot after its lock was taken over. dev3 cannot prevent that.

## Decision

- `src/bun/claude-json-update.ts` is the way dev3 changes a `.claude.json`. It takes Claude's lock and waits out a live lock rather than writing around it, polling every 25 ms because a slow poller loses the mkdir race. It re-reads under the lock, renames into place only if mtime and size are unchanged, and never rewrites an unparsable file. `writeClaudeTrustEntry` uses it. This is mitigation, not elimination.
- `src/bun/agent-session-receipts.ts` records per pre-assigned session id: launched (`launchTaskPty`, a fresh Claude spawn whose worktree carries dev3's SessionStart hook, never a reconnect or resume), started (`agent.sessionStarted` from `dev3 hook claude-session-start`, or any later prompt or turn end), and exited (`dev3 hook agent-exited`, appended to the launch wrapper by `buildCmdScript({ exitReport })`).
- Only two readers. `deliverLaunchHandoff` types into a registered session only after it started, and only into the pane the receipt came from. Past 2 min it badges the card, and past 30 min it drops the note with a toast. It never types blind. `agent.exited` moves the card from in-progress to user-questions with a badge, but only for a session this process launched that never started. Ordinary messages are untouched.

## Risks

- Claude builds that skip the lock, Claude's own compromised-lock writes, and Claude's unlocked fallback can still erase an entry. The handoff gate is what keeps the dialog safe when they do.
- An older installed CLI sends no receipt, so a peer-launched Claude gets a badge and a toast instead of its note. The CLI also prints "Unknown command" on exit. The app reinstalls its CLI at startup.
- Receipts live in memory. After an app restart nothing is registered, so both readers fall back to the old behaviour or do nothing.
- A live lock that never frees blocks a launch for up to 12 s before a verified unlocked write.

## Alternatives considered

- **Restore #1792's gate.** It blocked every message task-wide, which is the regression that reverted it.
- **Pre-trust the main repository root or the worktrees dir.** That entry is stable, so it would survive the race, but it silently extends trust to foreign-code worktrees.
- **Screen-scrape the pane for the dialog.** Works on tmux only (native has no capture), and it breaks on any wording change.
- **Retry or re-verify the trust write after a delay.** The new Claude has usually read its config by then, and a timed retry cannot be shown to close the race.
