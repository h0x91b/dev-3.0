# 104 — shell-env login shell runs with `+m`: interactive zsh stole the tty foreground group

## Context

Under `bun run dev`, Ctrl+C stopped working entirely: no `[electrobun dev]` graceful-shutdown message, the app kept running, `^C` was just echoed. The app process has a controlling terminal in this mode (the terminal/tmux pane that ran `electrobun dev`).

## Investigation

Sampling the tty's foreground process group (`ps -o tpgid=`) during app startup showed: `electrobun dev` correctly takes the foreground (its `takeoverForeground`), then our `resolveShellEnv` (`zsh -ilc <env dump>` in `src/bun/shell-env.ts`) grabs it — an interactive zsh with job control (monitor) calls `tcsetpgrp` for itself and for every external job its rc files run (e.g. `jenv refresh-plugins`). When that zsh exits, the tty's foreground pgid points at a dead process group, so the kernel delivers Ctrl+C's SIGINT to nobody. A minimal `/bin/zsh` without rc files does NOT reproduce — zsh only engages tcsetpgrp when rc files actually run external jobs, which is why this depends on the user's dotfiles.

## Decision

Spawn the env-dump shell as `[shell, "+m", "-ilc", CMD]` (`resolveShellEnv`). `+m` disables the monitor option in both zsh and bash at invocation, so the shell never touches the tty foreground group; `-i` is kept because zsh reads `.zshrc` only for interactive shells. Separately, SIGINT/SIGTERM now bypass the GUI quit-confirmation gate (`installSignalQuitConfirmation` in `src/bun/quit-manager.ts`, prepended before Electrobun's runtime signal handlers) — without that, a delivered SIGINT just popped the quit dialog.

## Risks

If a user's rc files explicitly `setopt monitor`, the shell could still grab the tty (unlikely; rc files run after option parsing but re-enabling monitor in scripts is rare). Verified `+m` keeps rc loading intact (PATH, functions) for zsh and bash.

## Alternatives considered

- `setsid`-style detach from the controlling tty: no setsid(1) on macOS, Bun.spawn has no `detached` option.
- Restoring the foreground group after the dump: racy (Ctrl+C broken during the window) and requires FFI `tcsetpgrp` in the app.
- Dropping `-i`: regresses #638/#691 (rc-file env such as `GH_CONFIG_DIR`, credentials would be lost).
