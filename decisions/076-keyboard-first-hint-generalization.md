# 076 — Keyboard-first hint generalization + go-to layer

## Context

PR #704 shipped a Vimium-style `f` hint overlay scoped to the Kanban board (`[data-task-id]` cards only). We wanted the same jump-by-hint on the dashboard and the task-view sidebar, and the user reported two problems with the `f` hotkey: it does nothing on non-Latin keyboard layouts (Cyrillic/Hebrew), and a lone bare letter reads oddly in the published shortcut list.

## Investigation

Both the activation and the hint-letter matching read `e.key`, which is layout-dependent — on a Cyrillic layout the physical `F` key yields `"а"`, so neither activation nor hint typing fired. The fix is to match on `e.code` (physical position, `"KeyF"`/`"KeyA"`…), which is layout-independent.

## Decision

- **Overlay is now surface-agnostic.** `TaskHintOverlay` → `HintOverlay`; it scans `[data-hint-id]` (placed only on the innermost clickable element) and commits via `element.click()`. Targets today: task cards (`TaskCard`), dashboard project rows + attention tasks (`ActivityOverview`), sidebar task rows (`ActiveTasksSidebar`). Policy: **a hint maps to a navigation/open destination only — never a mutation or destructive action** (so settings/remove/reorder buttons are not hinted).
- **Layout independence:** activation and hint typing match on `e.code`; `codeToHintChar()` in `utils/hintLabels.ts` maps `KeyA`–`KeyZ` → `a`–`z`.
- **Hotkey:** bare `F` (kept — the world-standard Vimium key) plus a Mac-friendly `⌘G` alias. Activation is data-driven (`document.querySelector("[data-hint-id]")`) instead of gated to `screen === "project"`, so it auto-extends to any screen with targets.
- **`g`-prefix go-to layer** (Linear/GitHub convention): bare `g` arms a 1.5s sequence, the next physical key picks `d`/`p`/`t`/`s` → dashboard/project/tasks/settings. Bare `g` is reserved for this; hints never use it.
- **`/`** focuses the first visible `[data-search-input]`; **`c`** is a bare-key alias for new task (`openCreateTaskModal`). All bare keys are gated by `isTypingContext()` and matched on `e.code`. Handlers live in the `App.tsx` `useGlobalShortcut` chain; registry rows added to `keymap.ts`.

## Risks

- Bare keys (`f`/`g`/`c`/`/`) are global when no field/terminal is focused; `isTypingContext()` is the only guard. A new focusable surface that isn't an input/textarea/contenteditable/terminal could leak keystrokes — extend `isTypingContext()` if that happens.
- `g`-prefix is invisible (no HUD); discoverability rests on the tip + keymap overlay.

## Alternatives considered

- **Bare `g` for hints / drop `f`:** rejected — it would burn `g`, which the go-to layer needs, and `f` is the established hint key.
- **Chord-only activation (⌘G, no bare key):** rejected — loses the single-keystroke speed that makes hint mode worthwhile; kept both.
- **Per-surface overlays:** rejected — "new component for old pattern" anti-pattern; one generic overlay + a `data-hint-id` contract instead.
