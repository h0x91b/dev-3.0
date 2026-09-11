# Seed Codex's `tui.whimsy = false` once, never force it

## Context

Codex draws "Astra composer stars" — sparse braille dots — over the area behind the
input, and repaints them every 150 ms for as long as the composer is on screen
(`codex-rs/tui/src/bottom_pane/chat_composer/sparkle.rs`, `FRAME_TICK`). Measured on
codex-cli 0.154.0 inside a dev3 pane: an **idle** pane emits 187 581 bytes in 20 s,
and 3 677 of those braille glyphs appeared in one 20 s capture. In dev3 that traffic
crosses a PTY, a WebSocket and a canvas renderer for decoration nobody asked for.

The effect exists only because the model happens to be named `*astra*` — that is one
of its four gates, alongside `tui.whimsy`, `tui.animations`, and a TrueColor stdout.

## Investigation

`tui.whimsy` is the precise switch: *"Enable decorative effects such as Astra
composer stars"* (`codex-rs/config/src/types.rs`), default `true`.
`tui.animations = false` would also kill it but takes the welcome screen, shimmer and
spinners with it. The `terminal_resize_reflow` feature flag next to it is stage
`removed`, so feature flags are not a route here at all.

## Decision

`ensureCodexConfig` (`src/bun/codex-config.ts`, step 6) writes
`[tui] whimsy = false` — but **only when the key is absent**, checked against the
parsed config, not the raw text. Both existing callers reach it: app startup
(`ensureCodexConfigFile`, `src/bun/index.ts`) and worktree creation
(`ensureCodexTrust`, `src/bun/agents.ts`). Managed Codex accounts symlink
`config.toml` from `~/.codex`, so they inherit it.

Seed-once rather than force, because forcing would silently undo the choice of a user
who puts the stars back, on every single app start. Codex's own default is `true` and
nobody writes it out explicitly, so in practice every install still gets the quiet
default.

## Risks

- A user who liked the stars and never wrote the key loses them once, with no
  announcement. Re-enabling is one line in their own config and dev3 then leaves it
  alone — pinned by `codex-config.test.ts`.
- A managed account whose `config.toml` is a real file instead of a symlink (it
  happens when `~/.codex/config.toml` did not exist at account-creation time, see
  `ensureCodexAccountHome`) never receives this, or any other, patch. That is a
  pre-existing gap in account setup, deliberately not fixed here.

## Alternatives considered

- **Force it on every start.** Simple, and the reason it was rejected is above.
- **`tui.animations = false`.** Wider blast radius for the same symptom.
- **A dev3 setting with a UI toggle.** A whole surface for one decorative loop; the
  user's own `config.toml` already is the toggle.
- **Leave it and document it.** The cost is per-frame and permanent, and a user who
  has never read `sparkle.rs` cannot connect an idle pane's traffic to it.
