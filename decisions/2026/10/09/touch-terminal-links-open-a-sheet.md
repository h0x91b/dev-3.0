# Touch taps on terminal links open an Open / Copy sheet

> Partly superseded on 2026-10-10 by `decisions/2026/10/08/terminal-refocus-only-when-focus-falls-to-body.md`: the focus keeper now leaves focus on any element that took it, not only inside a `role="dialog"`.

## Context
Every terminal link provider (OSC 8, ghostty's plain-URL regex, `dev3://`, file paths) activates only on `ctrlKey || metaKey`, which a touch screen never sets (h0x91b/dev-3.0#1811). Worse, in touch compose mode the container's capture-phase blocker stops `touchend`, so a tap reached nothing at all.

## Decision
`installTouchLinkTap` (`src/mainview/terminal-touch-links.ts`) adds capture-phase touch listeners on the terminal container. A tap (one finger, ≤ 8px, never past the slop) on a cell that any source resolves is claimed with `preventDefault` + `stopPropagation`, so ghostty's own touchend focus, the tap→mouse translation and the browser's compat click never run; `TerminalLinkSheet` then shows the destination with Open and Copy. Sources reuse each provider's `linkAt` and the same activation the modifier click runs, so URL validation is the existing `safe*Uri` set. A tap anywhere else is untouched, and the providers' Cmd/Ctrl gate is unchanged. The raw-mode hidden-textarea focus keeper now re-checks focus when its 50ms timer fires and leaves it inside a `role="dialog"` element: during `blur` Chromium reports `<body>` even for a move into the sheet, so it used to steal focus back out of every modal.

## Risks
In raw mode a tap on a link no longer clicks into tmux or opens the keyboard — tap beside it for that. Plain URLs are matched by our own regex because ghostty-web does not export its URL provider; the two can drift slightly. Verified only in emulated mobile Chromium, not on a physical iPhone/Android.

## Alternatives considered
Opening the link directly on tap: a mis-tap while reading would navigate, and the destination of an OSC 8 label is invisible before it happens. Long-press: undiscoverable and fights iOS's own long-press callout. Faking `ctrlKey` on synthesized touch clicks: would open without confirmation and still be swallowed in compose mode.
