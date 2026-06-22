# Feature plan — Multi-surface tip distribution (and the select-to-copy case)

Status: Plan (no code yet)
Date: 2026-06-22
Owner: UX Principal

## The real problem (reframed)

The trigger was "users don't know that selecting text in a tmux pane auto-copies"
(`TerminalView.tsx` → `setupNativeSelectionClipboardBridge` → `onMouseUp` →
`api.request.copyTerminalSelection`, ~line 674 — real, works, but invisible).

But that is one instance of a structural gap: **the tip engine only reaches the Kanban
board.** `TipCard` is mounted exclusively in `KanbanColumn.tsx` (line 640). The
highest-pain users live in the **task / terminal / diff** surfaces, where there is **no
tip carrier at all**. So the most useful "did you know" facts (terminal copy, diff review,
ports, dev server) never reach the people standing right next to the feature.

`Tip` (`tips.ts`) is a flat global pool with only `score` — no notion of *where* a tip is
relevant.

## Goal

A tip-distribution backbone that surfaces contextual tips **beyond the board**, using
existing idle/dead-time moments instead of new chrome, and a permanent pull home — without
a ticker/marquee (rejected: annoying) and without violating chrome-creep budgets.

## Decision

### 1. Make tips surface-aware

Add an optional `contexts?: TipContext[]` to `Tip` (`board | terminal | diff | settings |
preparing | any`). Untagged ⇒ `any` (board, as today). `selectTip()` gains an optional
context filter: pick highest-score tip whose `contexts` include the current surface (fall
back to `any`). Backward compatible — existing tips keep showing on the board.

### 2. Primary persistent carrier: a tip slot in the Active Tasks sidebar

Mount a compact `TipCard` **at the top of `ActiveTasksSidebar.tsx`, directly under the
search input** (between the search block ending ~line 483 and the task list `flex-1`
container at line 485): `<div className="px-3 py-2 border-b border-edge flex-shrink-0">`.

Why this is the right anchor:
- The sidebar is mounted in `ProjectView.tsx` → **visible on the board AND in task view**,
  so it reaches the terminal-dwelling users the board-only `TipCard` never touches. This is
  the structural fix.
- It is help/onboarding content, not durable config, so it does not violate the Sidebar
  surface contract — but it must be **compact (one line), dismissible, and rotating**, and
  it must not crowd the task list (it competes for sidebar vertical space).

Secondary zero-chrome carriers (optional, later):
- **`TaskPreparingView.tsx`** — captive dead-time screen while the worktree is prepared;
  a tip line here is free attention.
- **Terminal idle/transition states** (`connecting`, `sessionEnded`) — contextual tip
  without touching the live full-bleed grid.
- **Board `TipCard`** — unchanged (or scope it to `board` context once tags exist).

### 3. Moment-of-action coachmark for the top-pain behavior (copy)

One-time `toast.info()` the **first** time an auto-copy succeeds on a machine (in
`onMouseUp` success path), gated by a localStorage flag. Do **not** pre-set the flag for
existing users — confused users catch it on their next copy. This is surgical, reserved for
the highest-value behavior; it is NOT wired per-feature everywhere.

### 4. Permanent pull home: Help → Tips

A "Tips & tricks" list reached via **Help menu + command palette (⇧⌘P)** — same policy as
`KeyboardShortcutsModal` (help content lives in Help/palette, never a toolbar/header
button). Reuses the changelog/"what's new" pattern. One canonical place that lists every
tip; replaces any need for a ticker.

### 5. Add the copy tip NOW, surfaced first

New tip `id: "terminal-select-copies"`, `contexts: ["terminal", "preparing"]`.
**score 5** at the user's explicit request ("максимально, очень важно") so it leads.
Honest note: by the AGENTS.md rubric this is a basic affordance (would be ~3), not a
flagship — but context-tagging means it leads *within the terminal context* without
crowding out board flagship tips, so score 5 is defensible here. Copy:
title "Select to copy", body "Just select text in any terminal pane — it's copied to your
clipboard automatically."

## Rejected

- **Ticker / running status bar** — annoying (user agrees). Rejected.
- **Persistent always-on hint line under the terminal** — chrome creep on the densest,
  full-bleed surface (anti-pattern #1). Only one-time/dismissible carriers allowed.
- **New "💡" header button** — toolbar-button-creep; help content belongs in Help/palette.
- **Native dialog / modal coachmark** — banned (breaks browser/remote) / too much friction.

## Token / role

- Toast: `info` (neutral teaching), auto-dismiss.
- Tip lines on preparing/terminal: reuse `TipCard` visual language (muted card, dismiss),
  no new tokens.

## Files likely to change (implementation phase, not now)

- `src/mainview/tips.ts` — add `TipContext`, `contexts` field, context-filtered
  `selectTip`; add `terminal-select-copies` tip.
- `src/shared/types.ts` — `TipState` already exists; confirm no schema change needed.
- `src/mainview/components/TipCard.tsx` — optional compact/inline variant for narrow
  carriers.
- `src/mainview/components/TaskPreparingView.tsx` — mount a contextual tip.
- `src/mainview/components/TaskTerminal.tsx` / `ProjectTerminal.tsx` / `HomeTerminal.tsx` —
  contextual tip in idle/ended states.
- `src/mainview/TerminalView.tsx` — one-time copy toast.
- Help menu (`application-menu.ts`) + command palette (`commands.ts`) — "Tips & tricks"
  entry → Tips list surface.
- i18n `tips.ts` + `terminal.ts` (en/ru/es), one changelog entry.

## Decision record

Append to `docs/ux/UX_DECISIONS.md`: tips become surface-aware and are distributed across
dead-time/idle carriers + a Help/palette pull home; ticker rejected; chrome-creep budgets
preserved.
