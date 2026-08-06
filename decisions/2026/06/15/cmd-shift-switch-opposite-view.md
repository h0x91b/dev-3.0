# 068 — Cmd+Shift+1..9 switches project to the opposite view

## Context

`Cmd/Ctrl+1..9` switches to a project by index while *preserving* the current
view mode (decision in `UX_DECISIONS.md`, 2026-06-03). We wanted a sibling chord
that switches to a project but *flips* to the other view: board → task view,
task view → board.

## Decision

Added a `Cmd/Ctrl+Shift+1..9` branch to the global keydown handler in
`src/mainview/App.tsx` (right next to the `Cmd+1..9` branch). In a task view it
navigates to `{ screen: "project", projectId }` (board); on the board it
navigates to `{ screen: "project", projectId, taskView: true }` (split task-view
layout with an empty terminal placeholder, the same surface Cmd+1..9 uses).

## Risks

- **macOS reserves Cmd+Shift+3/4/5 for screenshots.** Those combos may be
  intercepted by the OS before reaching the renderer unless the user disabled the
  system shortcut. Cmd+Shift+1/2 (and 6..9) are unaffected. This is an OS
  limitation, not a bug — documented here so future agents don't chase it.
- The split task-view empty-state is shown even for `dev3-task-open-mode =
  fullscreen` users. This is intentional: the explicit Shift means "give me the
  other view" and overrides the open-mode preference (unlike Cmd+1..9, which
  respects it).

## Alternatives considered

- **Match the digit via `e.key`** (like the Cmd+1..9 branch): rejected. With
  Shift held, `e.key` is the shifted symbol (`!`, `@`, …), not the digit — the
  same reason the Cmd+Shift+` toggle keys on `e.key === "~"`. We match `e.code`
  (`Digit1`..`Digit9`) instead, which is layout/shift independent.
- **Respect open-mode and no-op from the board in fullscreen mode**: rejected —
  it would make Cmd+Shift+N do nothing from the board for fullscreen users,
  defeating the purpose of the chord.
