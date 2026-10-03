# `dev3 doctor` probes repository access from the terminal's own process

## Context

On 2026-10-03 task terminals on macOS lost access to projects under `~/Desktop`: Git printed `not a git repository` and `ls ~/Desktop` gave `Operation not permitted`, while the app's own Git calls kept working. Granting Full Disk Access to the bundled `tmux` binary restored access; toggling the app's entry did not.

## Investigation

- A synthetic fixture (worktree `.git` file pointing at a git dir) shows Git prints the same `fatal: not a git repository` for a deleted git dir (ENOENT), `chmod 000` (EACCES) and a `sandbox-exec` deny (EPERM). The message cannot tell the user which one happened.
- A synthetic `.app` probe using `responsibility_get_pid_responsible_for_pid` shows macOS responsibility survives fork, `setsid`, tmux's bootstrap-port swap and exec — but once the starting app exits, the daemon and every child it spawns afterwards report themselves as responsible. The live dev3 tmux server had been running for 8 days across app updates and reported itself.
- Apple DTS ("On File System Permissions", developer.apple.com/forums/thread/678819) states that BSD permissions and ACLs fail with EACCES while anything else fails with EPERM, and that the responsible-code link between an app and its helper is heuristic and "most often breaks when the child process … tries to daemonise itself" — which tmux does (`proc_fork_and_daemon` in tmux 3.6a `proc.c`).
- `tccd` logs still attributed pane processes to `dev3.electrobun.dev` via the launcher path, so the exact rule that made the tmux grant matter is not established. Terminal processes and the app process are not guaranteed the same TCC verdict, which is the only fact this check relies on.

## Decision

`checkRepositoryAccess` (`src/cli/commands/doctor-repo-access.ts`) runs inside `dev3 doctor` whenever the current directory is in a git checkout. It reads the `.git` file, lists the real git dir from the caller's process, and classifies the errno: ENOENT → repository missing, EACCES → file permissions, EPERM → access denied. EPERM does not identify the policy that denied it (macOS privacy protection, an agent sandbox or an MDM policy all return it), so the check lists possible causes and adds the Full Disk Access hint only for a macOS privacy-protected folder. It walks the parent chain to name the hosting tmux server, native terminal host or app binary. Run from a task terminal, the probe inherits exactly the shell's attribution, which the app process cannot observe.

## Risks

- The check reports a denial, not its cause; the user still has to compare against a plain terminal to tell a sandbox from privacy protection.
- The protected-folder list follows Apple's documentation and may lag a future macOS release.

## Alternatives considered

- **Parse Git's stderr** — the three causes print the same text, so there is nothing to parse.
- **Probe from the app process** — it has a different TCC attribution than the terminals, which is the very confusion being diagnosed. Probing through `tmux run-shell` would match the server's attribution and is the candidate for a future in-app warning.
