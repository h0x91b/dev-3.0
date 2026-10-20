# Shared tmux PTY sizes to the last active viewer

## Context

Every viewer of a tmux task shares one PTY, which `applyClientSizes()` sized to the
smallest connected viewer (`decisions/2026/06/03/shared-pty-smallest-client-size.md`).
One forgotten narrow tab — another browser window, a phone left open — clamped the
terminal for everyone, with nothing in the UI saying why (h0x91b/dev-3.0#2000). The
"matches tmux" justification was stale: since 3.1 tmux defaults to `window-size latest`.

## Decision

- **Last active visible viewer wins** — `pickSizingViewer` in `src/shared/resize-protocol.ts`.
  Ties keep the earliest-connected viewer, so connecting or resizing alone never takes over
  (no flip-flop between two idle windows). Hidden viewers count only when nobody visible has
  a size.
- **Presence is explicit, not inferred from input.** The renderer sends
  `ESC ] dev3viewer ; active|hidden BEL` on focus, pointerdown/keydown in the terminal,
  composer input, tab made visible, and on connect only if the page is visible AND focused.
  Raw PTY input is not used: ghostty answers terminal queries through the same channel, so
  every idle viewer would "type" whenever tmux asked something.
- **Followers render at the shared grid** (`ESC ] dev3sizing ; cols ; rows ; 0|1 BEL`,
  server → viewer, deduped per viewer), like a native observer, but keep reporting their own
  viewport so a takeover applies at once. `SharedSizeNotice` says so and offers "Fit here" —
  an overlay, not a row above the canvas: a row changed the terminal's own height, so the size
  a follower reported was a row short once it took over (caught in browser QA). The whole pill is one
  44px-tall button at the top: a small chip at the bottom edge was missed on a real phone.
  `TerminalView` renders it inside its own wrapper, so it sits over the canvas on every surface
  (the phone layout's container also holds the window switcher).
- **Every size change goes through the role-aware refit**, zoom and terminal-font changes
  included. They used to call `FitAddon.fit()`, which fits the terminal to its own container
  and reports through `term.onResize` — the one path a follower suppresses. So a zoomed
  follower both stopped rendering at the shared grid and told the server nothing, and the
  size it then took over with was its PRE-zoom one — and stayed there, because the role
  flip's refit is a no-op on a terminal `fit()` has already resized (browser A/B, 2026-10-20).
- The redraw jiggle now fires only for a socket's FIRST resize report (a new viewer's first
  paint), and its 16ms restore re-applies the size current when it fires. Browser QA caught
  the old shape: a new follower's own report jiggled the PTY, and the restore of the captured
  size undid the new sizer's real resize landing inside those 16ms.
- Native is unchanged: the writer lease still owns its geometry.

## Risks

- An inactive viewer narrower than the active one sees cropped content (wider: blank
  margin) until used. Accepted in #2000 over one stale viewer clamping everyone.
- Two visible windows used alternately reflow the shell on each switch — same as tmux.
- A viewer that reconnects while focused (e.g. a laptop waking) takes the size back.

## Alternatives considered

- **Keep smallest-wins, add a "who is clamping" hint** — explains the bug without fixing it.
- **Last to resize/connect wins** — a background tab reconnecting would steal the size.
- **One tmux attach per viewer** — still the "correct" model, still a large refactor of the
  broadcast/replay path; not needed to fix this.
