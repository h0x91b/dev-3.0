# Embedded account sign-in terminal

## Context
Adding a managed Claude Code / Codex account handed the user a shell command to run in some other terminal, then a "Verify" button. The login must run on the dev3 backend host (desktop and `dev3 remote` alike), in the staged account dir, without tmux (Windows has none) and without a Kanban task.

## Decision
`src/bun/account-login-terminal.ts` owns one sign-in per CLI: it spawns the provider command with `Bun.spawn({ terminal })` (ConPTY on Windows; `.cmd`/`.ps1` shims go through their interpreter, `loginArgv`), scoped only by `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Viewers attach through `registerExternalPtySession` in `pty-server.ts`, so the remote `/pty` proxy works unchanged and nothing joins the tmux/native session map. The host polls the staged dir and calls the existing `completeClaudeLogin` / `completeCodexLogin`; `LoginNotReadyError` means keep waiting, any other error is final. Process exit is reported, never treated as success, and the watch continues so a manual login in another terminal still lands. The modal leaves Escape to the CLI (Claude uses it) and its X only hides it — the Settings row reopens the running login; Cancel/Close/Done, a 20-minute TTL and app shutdown stop only the owned process and remove only an unregistered staged dir (`discardStagedLogin` refuses saved accounts). A remote viewer gets Codex `--device-auth`, since the localhost:1455 callback lands on the host.

## Risks
A hard-killed app (crash, `dev-server restart`) never runs `closeAll`: the CLI dies with its PTY, but the staged dir stays. Every staged dir carries `.dev3-staged-login`; the next Add account sweeps only marked, unregistered dirs older than the TTL (`sweepAbandonedStagedLogins`) — never at load time, never an unmarked dir from an older build, never a live sign-in of another instance.
Untested on Windows. Output is replayed from a 64 KB in-memory buffer only (never logged or pushed). Known open issue: on macOS Claude Code keys a `CLAUDE_CONFIG_DIR` login's Keychain item by a hash of the dir, while `ensureClaudeCredentialsFile` falls back to the default item — verification can succeed with the system login's token copied in. Left as-is pending a separate decision.

## Alternatives considered
Reusing the tmux project terminal (POSIX-only), the native host (task-bound, survives restarts, needs a task), an inline settings card (too small, steals scroll and Escape), and a task per login (rejected by the brief).
