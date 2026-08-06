# 210 — The tmux pane-style foreground is not an app-chosen color

## Context

`src/mainview/utils/ansi-theme-adapt.ts` emulates SGR dim as a muted gray, because ghostty-web
renders dim as 50% alpha (illegible on dark, washed out on white). The rule was: dim over the
*default* foreground becomes gray; dim under an explicit color keeps the color at full strength.
In practice dim died everywhere — Claude Code's input placeholder, hints and select-prompt
descriptions all rendered as bright as typed input, and Codex behaved the same.

## Investigation

Captured what tmux actually sends a client (`capture-pty.ts` attaching to a scratch tmux
session) instead of what the agent writes. Two findings, both invisible from the app side:

1. tmux repaints a dim run as `38;5;241` `2` … `39` — color first, dim second, default fg only
   later. The dim arrived while a color was active, was dropped, and never came back.
2. `window-active-style "bg=#1e1e2e,fg=#cdd6f4"` (`src/bun/tmux/themes.ts`) means tmux paints
   **every** default-fg cell with an explicit truecolor `38;2;205;214;244`. A bare default
   foreground never reaches the filter at all, so "dim under an explicit color" matched
   universally.

Confirmed against pixels in the running app: before the fix the placeholder row and a plain
text row sampled identically; after it they sample `112,120,150` vs `205,214,244`.

## Decision

In `transformSgrParams`: dim (`dimOn`) and "an explicit fg is active" (`fgExplicit`) are now
independent, persistent state reconciled at the end of every SGR sequence, so a dim that
arrives under a color still turns gray when the color is dropped. The four tmux pane-style
foregrounds (Mocha/Latte `@thm_fg` and `@thm_overlay_1`, active and inactive panes) are matched
by exact RGB in `TMUX_PANE_DEFAULT_FGS` and treated as "no color chosen", and ending dim
restores that pane foreground instead of SGR 39.

## Risks

The RGB list couples the renderer filter to `src/bun/tmux/themes.ts`: changing the Catppuccin
palette or the pane styles silently kills dim again. An app that genuinely paints text in
`#cdd6f4` and dims it gets our gray instead of a dimmed `#cdd6f4` — the intended reading
anyway.

## Alternatives considered

Implementing dim properly — blending whatever foreground is active toward the background —
is semantically right and needs no color table, but it changes every dim+color run in every
agent UI at once (Claude's box borders, Codex's muted rows) and needs the pre-dim color kept
so SGR 22 can restore it. Rejected as too broad for a contrast fix; it stays the option if the
color table proves brittle.
