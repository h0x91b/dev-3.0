# UX Principal Report: Narrow-viewport (mobile) doctrine

Date: 2026-06-28
Mode: planning only (doctrine + implementation roadmap)
Manifest status: updated (bible §12 rewritten, ux-architecture `responsive` block expanded, anti-patterns + decision added)
Confidence: high (grounded in a 3-agent code audit; see Evidence)
Idea credit: Ittai Zeidman (carousel reference implementation)

## 0. Scope

Make the whole app usable on a phone reached over `dev3 remote` (any sub-768px viewport) by
**generalising the board carousel into a product-wide doctrine** — without forking a separate mobile
app. This document is the authoritative ruleset's companion implementation brief. The canonical rules
live in `PRODUCT_UX_BIBLE.md` §12 and `ux-architecture.yaml` `responsive`. The narrower carousel
feature plan (`mobile-carousel-navigation.md`) is the Level-1/Level-2 reference; this plan governs
everything else.

## 1. The one principle

On a narrow viewport, show exactly **one sibling at a time** and move between siblings by **swipe +
a visible pager**. Columns, tasks-in-a-column, terminal panes, active tasks, settings sections, diff
files — all collapse to the same one-at-a-time idiom. It is a **responsive view-mode of existing
screens**, never a new destination, route, nav item, or "mobile mode" setting. Layout follows the
viewport automatically.

## 2. Breakpoint ladder (reconciled — fixes a real inconsistency)

| Name | Width | Hook | Reactive | Governs |
|---|---:|---|---|---|
| **narrow (mobile)** | `< 768px` | `useNarrowViewport(768)` (`CAROUSEL_MAX_WIDTH`) | yes | **THE layout gate** (carousel/stack/sheet). Tailwind `md`. |
| compact | `< 1600px` | `useCompact()` | yes | dense-desktop label hide + header kebab. NOT mobile. |
| device-class | `screen.width < 1024` | `useMobile()` | no | ONLY `<meta viewport>` choice. NOT a layout gate. |

Rules: gate **layout** on `useNarrowViewport`; use `useMobile` only for the viewport meta; never gate
layout on `isElectrobun`. The earlier doc said "<1024 / useMobile" — wrong; the shipped gate is
"768 / useNarrowViewport". `useViewport()` serves **device-width** to the browser so a phone reports
its true width.

## 3. Gesture law

- **scroll-body** surfaces (board, lists, settings sections): one sibling = 100vw via CSS
  `scroll-snap`, body scrolls the other axis → **full-surface swipe allowed**.
- **live-content** surfaces (terminal pane, diff stream, any canvas/TUI): one element at a time +
  position indicator (dots). Full-surface swipe **is allowed but must arbitrate by axis in the
  capture phase** — a clearly-horizontal drag is the carousel (preventDefault + stopPropagation so
  the canvas never sees it; cancel any nascent selection), while a vertical drag or a tap falls
  through to the content untouched. Native CSS `scroll-snap` cannot do this (a single canvas has no
  sibling slides), so it is a manual gesture. (Superseded the original "swipe forbidden, explicit
  pager only" rule for the terminal — see Level 2 / decision 090. A bottom pager bar collides with
  the mobile keyboard + ExtraKeyBar.)
- Always: every swipe has a button + keyboard (Arrow Left/Right) equivalent; focus follows the active
  sibling; `aria-live` announces it; `prefers-reduced-motion` snaps instantly — **everywhere**.

## 4. Per-surface adaptation (the work list)

| Surface | Narrow form | Status |
|---|---|---|
| Kanban board | column carousel | done |
| Task move (drag) | "Move to <status>" bottom action sheet (long-press) | to build |
| Board filters/search | bottom sheet behind a header funnel | to build |
| Terminal panes | swipe carousel (axis-arbitrated) + top dots, keep-zoom | done (Level 2) |
| Active tasks | `ActiveTasksStrip` (already used in `ProjectView` browser mode) — formalise | done (strip) |
| Task inspector (2×2) | one summary bar + "task actions" bottom sheet | to build |
| Diff viewer | files-aside → bottom-sheet file picker; diff stream owns screen | to build |
| Modals | full-bleed sheet: `max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)]` (or BottomSheet) | to build |
| Context menu | bottom action sheet (long-press) | to build |
| Settings | tabs → one section at a time (carousel/`<select>`/accordion) | to build |
| Dashboard | already a vertical list — ensure full-width cards | ok |
| Command palette | touch entry + `w-full max-w-[calc(100vw-2rem)]` | to build |
| Global header | logo + truncated breadcrumb + 1 overflow kebab | to build |
| Hover terminal preview | disabled on touch/narrow | done |
| Toast | already clamped | ok |

## 5. Navigation & action reachability on touch (the hardest gap)

Keyboard-only and dead on a phone: Cmd+K / Cmd+Shift+P palettes, Cmd+1..9, the Cmd+/ hint overlay.
The **native application menu is absent in remote mode entirely.**

- The **breadcrumb spine** stays the touch nav backbone (logo→dashboard, project→board,
  chevron→switcher, back/forward). Keep targets ≥44px and the switcher dropdown `right-0`-safe so it
  is never pushed off-screen by a long task title.
- The **command/action palette gains a touch entry + responsive width** on narrow. Because the native
  menu is gone in remote, the action palette + per-object action sheets become the **canonical mobile
  action surface** — the one sanctioned exception to "palettes are keyboard-only / no button".
- **Hard rule: no feature may be touch-unreachable.** Any action whose only desktop path is a
  keyboard shortcut or the native menu MUST get a touch path on narrow.

## 6. New primitive — `BottomSheet` (mandated; none exists)

One reusable React bottom-sheet, used for: context-menu→action-sheet, board filters, column-jump
list, "Move to", inspector actions, diff file picker, and the narrow form of action-style modals.
Requirements: slide from bottom; `env(safe-area-inset-bottom)`; trap + restore focus; dismiss on
backdrop tap / swipe-down / Esc; **pure React** (no native dialog — works in desktop and browser).
Build once; no ad-hoc sheets.

## 7. Narrow budgets & touch targets

- Global header: logo + breadcrumb + **1** overflow kebab; rest into the kebab/sheet.
- Page primary action: 1 (FAB or header button); rest into a bottom sheet.
- Inspector: 1 summary bar; all actions into the actions sheet.
- Any toolbar/action row: wrap or sheet — **never** a non-wrapping overflow row.
- Touch target ≥ **44×44px** (many controls are 32px / `p-0.5` today).

## 8. Implementation roadmap (suggested order; each is its own PR)

1. **`BottomSheet` primitive** + responsive modal clamp (all `*Modal` get
   `max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)]`; `PaletteShell`/`confirm()` too). Unblocks the rest.
2. **Global header narrow reflow** (kebab for all utilities under `useNarrowViewport`).
3. **Command palette touch entry** + responsive width (the action fallback for the absent native menu).
4. **Board move-to + filters** as bottom sheets (completes board Level 1 touch parity).
5. **Inspector** → summary bar + actions sheet on narrow.
6. ~~**Terminal pane carousel** (Level 2: axis-arbitrated swipe + top dots + tmux keep-zoom backend).~~ done
7. **Diff viewer** narrow stack (file-picker sheet).
8. **Settings** one-section-at-a-time.
9. Site-wide `prefers-reduced-motion`; touch-target audit; `env(safe-area-inset-*)`.

## 9. Do NOT

- Add any new destination / route / nav item / "mobile mode" setting.
- Gate layout on `isElectrobun` or on `useMobile` (mount-once). Gate on `useNarrowViewport`.
- Hijack swipe over the terminal/diff stream **without axis arbitration** — a horizontal carousel
  swipe is fine, but it must let vertical drags and taps fall through to the content (capture-phase,
  preventDefault only once the gesture is clearly horizontal).
- Ship ad-hoc bottom sheets — use the one primitive.
- Leave any action reachable only by keyboard or native menu on narrow.
- Change `projectSlug()` or anything under `~/.dev3.0/` (unrelated invariant, noted for safety).

## 10. Likely files

`hooks/useNarrowViewport.ts`, `useViewport.ts`, `useMobile.tsx`, `useCompact.ts`; new
`components/BottomSheet.tsx`; `GlobalHeader.tsx`, `PaletteShell.tsx`/`CommandPaletteModal.tsx`,
`*Modal.tsx`, `confirm.tsx`, `KanbanBoard.tsx`/`MobileBoardCarousel.tsx`, `TaskInfoPanel.tsx`,
`TaskWorkspacePane.tsx`/`TerminalView.tsx` + `bun/rpc-handlers/tmux-pty.ts`, `TaskDiffViewer.tsx`,
`GlobalSettings.tsx`/`ProjectSettings.tsx`, `index.css`, i18n en/ru/es.

## 11. Acceptance (doctrine-level)

- Every §5 surface has a defined, non-overflowing narrow form at 390px.
- No action is reachable only by keyboard or the native menu on narrow.
- One `BottomSheet` primitive backs every sheet usage.
- Layout switches are driven by `useNarrowViewport`, reduced-motion honoured throughout, touch targets ≥44px.

## Evidence (3-agent code audit, 2026-06-28)

- **Nav/chrome:** `GlobalHeader.tsx` single non-wrapping row, ≤9 right-side icon buttons; `useCompact()` (1600) only hides labels + folds 3 into a kebab; palettes keyboard-only (`App.tsx`), `PaletteShell.tsx` `w-[34rem]`; `SplitLayout.tsx` unusable <~600px; `ProjectView.tsx` `isBrowserMode` → stacked `ActiveTasksStrip`; native menu absent in remote.
- **Surfaces:** `*Modal.tsx` fixed 26–35rem; no BottomSheet exists (only Modal/confirm/toast/popover); `TaskInfoPanel` 2×2 crowds <768; `TaskDiffViewer` `w-[22rem]` aside; `TaskCard` footer no `flex-wrap`; Dashboard list OK; toast already clamped.
- **Primitives/gestures:** `useMobile` 1024 mount-once (`screen.width`); `useNarrowViewport` reactive matchMedia; only ~13 Tailwind responsive prefixes in the whole renderer (Tailwind defaults, no custom breakpoints); `.browser-mode` 16px input rule; `TerminalView` touch→mouse bridge; `ExtraKeyBar` vw sizing; `prefers-reduced-motion` honoured only in `MobileBoardCarousel`.
