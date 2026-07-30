# 183 — Native terminal rollout controls: a forward-only global preference plus a per-task override

## Context

The native terminal backend exists behind `Task.terminalBackend` and could only be
selected per task with `dev3 task terminal-backend`. Rolling it out needed a
machine-local way to opt NEW tasks in without touching current defaults (POSIX
leaves the field absent ⇒ tmux, Windows stamps `native`), without rewriting any
existing task, and without ever silently falling back to tmux.

## Investigation

`newTaskTerminalBackend()` in `src/bun/data.ts` was already the single creation
seam, and `decodeTerminalBackend` in `src/shared/terminal-backend-identity` is a
frozen codec where an absent field means legacy tmux. The live-session guard for
switching lived inline in the CLI socket handler, so a second (GUI) caller would
have duplicated it.

## Decision

- The preference lives in its OWN versioned sidecar,
  `~/.dev3.0/terminal-backend.json`, owned by `src/bun/terminal-backend-preference.ts`:

      { "version": 1, "newTaskBackend": "tmux" | "native" }

  Missing file, corrupt JSON, an unknown `version`, or an unrecognised identity
  all mean **no preference**, and the platform default stands. Writes are atomic
  (temp file + rename) and machine-local; an unreadable sidecar is left alone
  rather than repaired.
- It is read per creation inside `addTask` and passed to `newTaskTerminalBackend()`.
  **Only `native` writes a marker.** A `tmux` preference — like no preference —
  leaves the record field-less, byte-identical to what every previous build wrote,
  so older versions on the same machine keep reading it. Windows stays `native`
  regardless of the preference.
- The live-session gate moved to `src/bun/task-terminal-backend-switch.ts`
  (`liveTaskTerminalBackend`, `readTaskTerminalBackendState`,
  `switchTaskTerminalBackend`, `nativeTerminalAvailability`). The CLI handler
  (`task.terminalBackend`) and the new `getTaskTerminalBackend` /
  `setTaskTerminalBackend` / `getNativeTerminalAvailability` RPCs all go through it.
- `nativeTerminalAvailability()` is a non-throwing probe around
  `resolveNativeHostRuntime()`; it also reports `tmuxSupported`, answered by the
  HOST platform so a browser attached from another OS is not asked.
- UI: `TerminalBackendSetting` in Global Settings → Terminal, and
  `TaskTerminalBackendRow` in the Task Detail modal. Unavailable choices stay
  visible but disabled with their reason, never hidden.

## Why not `settings.json`

The first cut of this change put the preference in `GlobalSettings`. That is
wrong, and it was caught on a real machine: `loadSettings` is a **field
whitelist**, so a build that predates the key rebuilds settings.json without it
on its next save. An older app installed side by side therefore *deletes* the
rollout choice — the exact shared-state breakage the on-disk invariants forbid. A
file older builds neither read nor rewrite is the only durable home for it, and
because this change is unmerged the `GlobalSettings` field was removed outright
rather than kept as a second code path.

## Risks

Selecting `native` while the host image is missing stamps `native` anyway and the
launch fails loudly. That is deliberate — the alternative is a silent tmux
fallback, which is exactly what the seam forbids. The UI gates the choice, so it
takes an out-of-band settings edit or a build that loses its host image after the
choice was made.

## Alternatives considered

- **Stamp an explicit `tmux` for a tmux preference.** Rejected: it changes the
  on-disk shape for the common case with no behavioural gain, and an older build
  that never learned the field would be reading a value it does not expect.
- **Thread the preference through every `addTask` caller.** Rejected: the seam
  exists so GUI, CLI, automations, duplicates, and variants cannot drift.
- **Fall back to tmux when the native host cannot be resolved.** Rejected by the
  backend contract (decision 165 / `task-terminal-backend.ts`).
