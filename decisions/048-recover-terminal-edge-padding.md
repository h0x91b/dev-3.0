# 048 — Recover terminal edge padding (drop WKWebView clip workarounds, patch FitAddon)

## Context

User reported visible empty space at the bottom and right of the terminal pane (~1 row and ~1-2 columns). On a small viewport that real estate matters; the gap was previously not visible.

## Investigation

Three independent contributors:

1. **`pb-7` (28px padding-bottom) on the screen wrapper in `src/mainview/App.tsx`** — added Mar 2026 (PR #202) as a workaround for an Electrobun/WKWebView bug that clipped ~16px from the bottom of the viewport after any window resize. Originally landed alongside an Electrobun bump to 1.14.4 (see `change-logs/2026/03/09/fix-terminal-bottom-clipping.md`).
2. **Startup resize nudge in `src/bun/index.ts`** — set `(w, h-1)` then back to `(w, h)` on startup, forcing the app into the "post-resize clipped" state so `pb-7` would compensate consistently. Pairs with (1).
3. **`gA = 15` scrollbar reservation in `ghostty-web@0.4.0` FitAddon.proposeDimensions** — subtracts 15px from container width "for scrollbar". ghostty actually renders its scrollbar overlaid on the canvas, so no native scrollbar takes that space. The reservation silently dropped ~2 columns of usable terminal width.

After Electrobun bump 1.14.4 → 1.18.1 (commit 53feb5c9), the WKWebView clip bug appears no longer present, but the workarounds (1) and (2) were still in place — visibly wasting space.

## Decision

Removed all three:
- `src/mainview/App.tsx` line 702: dropped `pb-7` from the screen wrapper.
- `src/bun/index.ts`: removed the startup `setSize(w, h-1) → setSize(w, h)` nudge block.
- `src/mainview/TerminalView.tsx`: monkey-patch `fitAddon.proposeDimensions` per-instance with a version that mirrors upstream logic minus the 15px scrollbar reservation. Applied right after `new FitAddon()` so it propagates through `fit()` and `observeResize()` automatically.

## Risks

- If WKWebView clipping reappears under Electrobun 1.18.1, the last row (e.g. tmux status line) will be cut off after a window resize. Revert (1) and (2) together if observed.
- The FitAddon patch relies on the private `_terminal` field name in the minified ghostty-web bundle. Any future ghostty-web upgrade can rename it — the override gracefully returns `undefined` if the field is missing, falling back to no fit (terminal stays at its last sized dimensions). Re-verify when bumping ghostty-web.

## Alternatives considered

- **Keep `pb-7`, just drop the nudge.** Inconsistent: nudge alone is what makes pb-7 stable; pb-7 alone wastes 28px always.
- **Fork ghostty-web / patch-package.** Higher maintenance cost than an instance-level method override.
- **Round up rows / overflow last row.** Causes half-clipped characters at the bottom — ugly.
