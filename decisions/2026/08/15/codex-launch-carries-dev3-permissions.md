# A Codex launch that decides nothing gets dev3's own permissions and profile

Status: implemented in `src/shared/agent-adapters/codex.ts`
(`applyDev3Permissions`, and the profile injection inside `applyCodexTheme`).

## Context

A hand-built Codex preset — the `+ New preset` button seeds `{ id, name }` and nothing else —
launched an agent that came up, answered, and could not talk to dev3 at all: `dev3 current` died
with `EPERM: operation not permitted, scandir '~/.dev3.0/sockets'`, `ls ~/.dev3.0` reported
`total 0`, and the task's status never moved. Reported against a preset that bound model roles,
which made it look like a model-catalog regression.

## Investigation

It is not the catalog. dev3 writes the user's `~/.codex/config.toml` itself
(`ensureCodexConfig`), and when the user has no `default_permissions` of their own it creates a
generic preset and makes it the default so Codex will accept a config that defines
`[permissions.*]` at all:

```toml
default_permissions = "workspace"
[permissions.workspace.filesystem]
":minimal" = "read"
```

`:minimal` does not include `~/.dev3.0`. The dedicated preset does:

```toml
[permissions.dev3.filesystem]
"~/.dev3.0" = "write"
```

Every built-in Codex preset carries `-c default_permissions="dev3"` or
`--sandbox danger-full-access` in its `additionalArgs`, so the gap was invisible until a preset
was built by hand. In other words dev3's own config change is what closes `~/.dev3.0` to any
launch that does not explicitly re-open it.

(A `codex sandbox` probe reads `~/.dev3.0` fine and rejects `-c default_permissions` with
"requires a `[permissions]` table" — that subcommand goes through the older seatbelt path and
measures something else. It neither confirms nor refutes the above; the config does.)

## Decision

Reaching `~/.dev3.0` is infrastructure, not a preference, so the adapter supplies it when the
launch says nothing about permissions: `-c default_permissions="dev3"` unless an arg already
decides (`-s`/`--sandbox`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`, or a `-c`
naming `default_permissions` / `sandbox_mode` / `sandbox_permissions`), in either the spaced or
the `--flag=value` form clap accepts. An approval flag (`-a` / `--ask-for-approval`) deliberately
does **not** count: it decides when Codex stops to ask, not what the process may touch, and
dropping our preset there would cost the agent `~/.dev3.0` for nothing. The same rule adds the dev3
profile when the preset names none, because that file is where the hook trust hashes live — an
agent with untrusted hooks is deaf in the same way. This mirrors what the Claude adapter already
does with `--append-system-prompt`: protocol delivery belongs to the adapter, not to a preset's
raw args.

## Risks

- A user who wants a sandboxed Codex must say so — but any of the sandbox flags counts as saying
  so, including `-s read-only`, so the escape hatch is the obvious one.
- The injected `-c` lands before the preset's own theme override and after its `additionalArgs`,
  relying on codex's repeated-`-c` last-wins semantics (decision 163) for anything that overlaps.

## Alternatives considered

- **Seed `+ New preset` from the agent's default preset.** Fixes new presets, leaves every
  already-broken one broken, and makes "new" mean "copy".
- **Set `default_permissions = "dev3"` globally in the user's config.** Reaches existing presets,
  but silently widens permissions for the user's own non-dev3 Codex sessions.
- **Block the launch with a preflight.** Names the problem but leaves the user to fix flags they
  never chose to omit.
