# omp defaults to Nerd Font symbols through a conditional `--config` overlay

## Context

omp's `symbolPreset` defaults to `unicode`, which looks broken in dev3's terminal next to the bundled Nerd Font. Every terminal font dev3 offers either is a Nerd Font or falls back to one (`DEFAULT_TERMINAL_FONT_STACK`), so `nerd` always renders there.

## Investigation

omp's settings precedence (`Settings.getProvenance`, can1357/oh-my-pi @a536558) is runtime → `--config` overlay → project → global → default. An overlay therefore beats the user's own `config.yml`. omp has no env var for the preset.

## Decision

`src/bun/omp-launch-defaults.ts` writes `data/agent-hooks/omp-defaults.yml` and `withOmpLaunchDefaults` in `src/bun/agents.ts` passes it as `--config` only when neither the launch's agent dir `config.yml` (an account dir links the user's) nor the worktree's `.omp/config.yml` sets the key at top level. The persisted setting is never written, so omp in other terminals keeps its own default.

## Risks

- Changing the preset with `/settings` inside a running dev3 session saves it, but the overlay keeps winning until the next launch, which then sees the key and drops the overlay.
- The key check is a top-level-line regex, not a YAML parse; an unreadable file counts as "set".

## Alternatives considered

- An unconditional overlay: overrides a user who picked ASCII on purpose.
- Writing `symbolPreset: nerd` into the user's `config.yml`: changes omp everywhere, including terminals without the font — exactly what omp's own Glyph Protocol upgrade avoids persisting.
