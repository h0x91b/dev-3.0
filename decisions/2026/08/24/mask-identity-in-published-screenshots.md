# Mask identity in published screenshots with an OCR-driven blur

## Context

`docs/first-task.html` publishes 17 screenshots of a live tour run. Streamer mode
(`&streamer=on`, see `decisions/2026/07/23/streamer-mode-css-blur-masking.md`) blurs app chrome
through CSS, but it cannot touch **terminal content** — that is pixels drawn by an agent CLI, not
DOM the app controls.

## Investigation

macOS Vision OCR over the raw PNGs found three leaks the naked eye skips:

- `arsenyp worktree ⌥ <branch>` — Claude Code's own status footer, on 7 of 17 images.
- `IL-M760HGJW4F` — the machine name in the tmux status line, on 5 images.
- `/private/var/folders/04/ym_…/T/dev3-qa/…` — the QA temp home, 15 boxes across 3 images.

All identity text sat in one fixed strip (x 255, y 942, 560×44 in a 1600×1000 frame); the paths were
scattered inline in scrolling terminal output, so a fixed band could not cover them.

## Decision

Two passes, both driven by OCR boxes rather than by eye, then a re-scan of the **shipping JPGs** (not
the PNGs) until zero matches:

1. One blur over the fixed identity strip.
2. Per-box blurs over every box whose text matches a path pattern, looped until a pass comes back
   clean — one pass is not enough, because OCR splits a long path across boxes and only the box
   holding the literal gets hit on the first round.

The originals stay untouched: masking reads from `dev3-artifact-tour/img/*.png` and writes JPEGs into
`docs/first-task/img/`.

## Risks

OCR is the verifier as well as the targeting tool, so text it cannot read is text it cannot flag. It
is a floor, not a proof — a human still looks at the frames. Blurred line strips also read as
redaction, which is fine here and would not be fine in a marketing shot.

## Alternatives considered

- **Crop the bottom band off.** Kills the tmux window tabs, which the dev-server step is about.
- **Re-shoot with a clean status line.** The username in Claude Code's footer is the real user on any
  machine; a fresh profile does not change it.
- **Extend streamer mode to cover the terminal.** The right long-term fix for the app, not for
  screenshots already taken; tracked in this task's notes.
