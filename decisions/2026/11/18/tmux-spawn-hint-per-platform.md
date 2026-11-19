# The tmux spawn-failure hint is per platform and checks the binary again

## Context

`TmuxSpawnError` (`src/bun/tmux/errors.ts`) told every non-Windows user that "the path resolves" and that dev3 probably lost Full Disk Access. That advice comes from macOS (see `graceful-devserver-status-on-tmux-failure.md`). Linux has no Full Disk Access.

Seen 2026-11-17 on WSL: Homebrew removed the keg-only `h0x91b/dev3/tmux@3.6` formula while dev3 was running. dev3 pins its tmux path once at startup (`selectTmuxBinary`) and again on each `checkSystemRequirements` call, so it kept spawning the deleted keg path. Each spawn failed with ENOENT, and the message sent the user to a macOS settings pane for a file that no longer existed. A browser reload ran `checkSystemRequirements`, which fell back to the PATH tmux.

## Decision

The hint depends on the platform:

- macOS keeps the Full Disk Access hint unchanged. Under lost Full Disk Access, the dev3 process itself may not see the file, so an existence check there would hide the real cause.
- On Linux, the error checks the path again when the error is built. A missing file, or a bare `tmux` that failed the PATH lookup, gets "No tmux binary exists ... it was probably uninstalled", with the reinstall command and a reload, which re-resolves tmux. A file that exists but cannot run gets a short "could not be executed" hint.
- Windows keeps its POSIX-only message.

The existence check is an injectable constructor argument (default `existsSync`), so tests pin both cases without touching the file system.

## Alternatives considered

- Re-resolving the binary before every spawn adds a `stat` to every tmux command and still needs a server-compatibility probe before it can switch binaries (`selectTmuxBinary`). The failure is rare and a reload fixes it, so the message carries the fix instead.
- Re-resolving and retrying once inside the spawn catch would hide the uninstall from the user, and the tmux module cannot reach the settings-backed resolution in `rpc-handlers/settings-config.ts` without a new dependency in the wrong direction.
