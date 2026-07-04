# 103 — tmux clients spawn from DEV3_HOME so the server cwd never dies

## Context

After Homebrew upgraded tmux to 3.7, every new pane (task sessions, setup,
git-op/rebase panes, user splits) started in a wrong, already-deleted
directory: `shell-init: getcwd: cannot access parent directories`,
`bun install` → "current working directory was deleted", `git rebase` →
exit 128. Setup and rebase were effectively broken for all new tasks.

## Investigation

The dev3 tmux server daemonizes with the cwd of the first client that starts
it — until now, a task worktree (spawnPty passed `cwd: session.cwd`). When
that task completes, dev3 deletes the worktree, leaving the server with a
deleted-inode cwd. Under tmux 3.7 that state makes the server silently ignore
`-c` on `new-session`/`split-window`: `#{session_path}` is set correctly, but
the pane process inherits the server's dead cwd (likely the server fails to
save/restore its own cwd around the spawn chdir dance and skips it). Verified
with a minimal repro: fresh 3.7 server honors `-c`; delete the server's cwd
and `-c` is ignored server-wide. tmux ≤3.5a tolerated this, which is why the
bug appeared only after the Jul 1 Homebrew upgrade — no dev3 PR caused it.

## Decision

Invariant: the tmux server's cwd must be immortal. All tmux client spawns that
can start a server (`new-session` in `pty-server.ts` spawnPty, cleanup session
in `task-lifecycle.ts`, dev-server session in `tmux-pty.ts`) now run from
`tmuxClientCwd()` (= `DEV3_HOME`, exported from `pty-server.ts`), and the pane
cwd always travels via an explicit `-c` flag (added to spawnPty's
new-session, which previously relied on the client cwd).

## Risks

An already-poisoned running server cannot be healed (a process cwd cannot be
changed externally) — it needs a one-time `tmux -L dev3 kill-server` or
machine reboot. If DEV3_HOME were ever deleted while the app runs, the same
failure returns; `tmuxClientCwd()` re-creates it defensively on every call.

## Alternatives considered

- **`-c` on new-session only, keep client cwd = worktree** — fixes nothing:
  whichever mortal-cwd client starts the server still poisons it.
- **Explicit `start-server` at app boot from a safe dir** — dies instantly
  with `exit-empty on`, and doesn't cover servers started by older versions.
- **Auto-kill a poisoned server on startup** — would destroy live agent
  sessions; not acceptable.
