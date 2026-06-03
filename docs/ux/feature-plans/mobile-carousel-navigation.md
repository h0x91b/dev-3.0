# UX Principal Report: Mobile / Remote carousel navigation

Date: 2026-06-03
Mode: planning only
Manifest status: updated
Confidence: high
Idea credit: Ittai Zeidman (original concept)

## 0. One-paragraph framing

On a phone (reached through `dev3 remote`) or any sub-1024px viewport, the desktop
board and terminal do not fit. The fix is a single responsive pattern applied at two
levels: **show exactly one element at a time and move between siblings by swipe**.
Level 1 turns the Kanban board into a 2D carousel (horizontal = which column,
vertical = which task in it). Level 2 turns the task terminal into a pane carousel
(always one zoomed pane, swipe/pager moves to the next pane). This is a **view-mode
adaptation of existing screens**, not a new destination, action, or nav entry.

## 1. Feature understanding

- **User job:** Drive tasks and watch/steer agent terminals from a phone with one thumb,
  without pinch-zooming a desktop layout.
- **Owning object or workflow:** Two existing screens — `project` (Kanban board) and
  `task` (full-screen terminal). No new object.
- **Feature class:** `view_mode` (responsive layout variant). NOT destination / primary
  action / configuration.
- **Scope:** Page-level rendering on narrow viewports (`isNarrow`). Global gating signal,
  per-screen layout.
- **Frequency:** Constant whenever the active viewport is narrow.
- **Risk:** Safe / reversible (layout only). The one behavioural sub-piece — moving a task
  between columns without drag — reuses the existing status-change path, no new mutation.
- **Discoverability need:** Medium. Swipe is discoverable but must always have a visible
  button equivalent (pager arrows / dots) so it is never the *only* way.
- **Assumptions:**
  - Narrow = `screen.width < 1024` (the existing `useMobile()` threshold) OR a deliberately
    narrowed browser window. We gate on viewport, **not** on transport, so it also covers a
    hypothetical Electrobun-mobile build and a narrow desktop test window.
  - A task's tmux session typically has 1–3 panes (agent, dev server, scratch).

## 2. UX placement decision

Recommended placement:

- **Route/screen:** unchanged — `project` (board) and `task` (terminal). Reuse routes.
- **Surface:** new responsive variants of two existing surfaces:
  - `kanban_board` → **board carousel** variant under `isNarrow`.
  - task terminal workspace → **pane carousel** variant under `isNarrow`.
- **Menu/nav group:** none. No new destination, no nav item.
- **Entry point:** automatic — chosen by viewport width at render time. No toggle, no setting
  (a manual "force desktop layout" escape hatch is an optional follow-up, not in scope).
- **Visibility rule:** carousel layouts render iff `isNarrow === true`; otherwise the existing
  desktop board / terminal render unchanged.

Rejected placements:

- **New "Mobile" top-level destination** — rejected. Navigation holds places, not render
  modes. A responsive variant of an existing screen must not become a nav entry
  (bible §4 budget, anti-pattern "actions/state in nav").
- **A user setting "Use mobile layout"** — rejected as the *primary* mechanism. Layout must
  follow the viewport automatically; a manual override can come later as an expert escape
  hatch, not the entry point.
- **Full-surface horizontal swipe inside the terminal** — rejected (see §6). The terminal is
  interactive (vim/htop/less consume touch + horizontal motion); a swipe-to-change-pane that
  covers the whole pane fights the running program. Pane switching gets an **explicit pager**,
  with full-surface swipe allowed only on the board (where column bodies scroll vertically
  only, so a horizontal swipe is unambiguous).
- **A JS drag-carousel library** — rejected. The board carousel is built on native CSS
  `scroll-snap`, which gives momentum, axis disambiguation, and accessibility for free.

Rationale:

- The concept is fundamentally "one screen-width element + swipe to siblings" — that is a
  responsive presentation of data we already have, so it belongs *inside* the screens that own
  that data, switched by breakpoint.
- Gating on viewport (not on `isElectrobun`) keeps a single code path for every narrow context
  and makes it testable by shrinking a desktop browser window.

Evidence:

- `src/mainview/hooks/useMobile.tsx` (1024px screen-width threshold, `MobileProvider`).
- `src/mainview/hooks/useViewport.ts` (per-route viewport meta switching; browser-remote
  currently pinned to `width=1024`).
- `src/mainview/rpc.ts` (`isElectrobun`, `browser-mode` class on `<html>`).
- `src/mainview/components/KanbanBoard.tsx`, `KanbanColumn.tsx`, `hooks/useColumnCollapse`.
- `src/mainview/components/TaskWorkspacePane.tsx`, `TaskTerminal.tsx`, `TerminalView.tsx`.
- `src/bun/rpc-handlers/tmux-pty.ts` `tmuxAction` — already supports
  `nextPane` (`select-pane -t :.+`), `prevPane` (`:.-`), `zoom` (`resize-pane -Z`).

## 3. Navigation and menu changes

- **Add:** nothing to global nav.
- **Rename:** none.
- **Move:** none.
- **Remove:** none.
- **No change:** breadcrumbs, application menu, Route union. On `task` the existing back
  affordance returns to the board carousel.

In-screen navigation introduced (local to the carousels, not global):

- **Board column pager** — sticky header on the board carousel: column name + task count +
  position (`3 / 8`) + `‹`/`›` chevrons + dot indicators; tapping the name opens a
  bottom-sheet column list for direct jump.
- **Terminal pane pager** — docked bar in the terminal: `‹` prev · `pane 2 / 3` + dots · `›` next.

## 4. Action hierarchy and token decisions

| Element | Label | Semantic role | Concrete variant/token | Visibility | Notes |
|---|---|---|---|---|---|
| Column prev/next | (icon `‹` / `›`) | icon | ghost, `text-fg-muted hover:text-accent` | persistent in pager | accessible name `t("mobile.prevColumn")` / `nextColumn` |
| Column dots / position | `3 / 8` | neutral status | `text-fg-3`; active dot `bg-accent`, rest `bg-edge` | persistent | status surface, not a button row |
| Column jump (open list) | column name | link | `text-fg hover:text-accent` | persistent | opens bottom-sheet list |
| Create in column | `+` | secondary | existing create-in-column affordance, `text-accent bg-accent/10` | persistent in column header | reuse existing per-column create |
| Filter/search entry | (icon funnel) | icon | ghost | persistent in board header | opens filter bottom sheet (wraps `LabelFilterBar` + search) |
| Card → move-to | `Move to →` + status list | object_action | row items in action sheet; current status disabled | in card long-press action sheet | **drag replacement**; uses existing status-change RPC |
| Pane prev/next | (icon `‹` / `›`) | icon | ghost | persistent in pane pager | reuse `tmuxAction` prev/next + keep-zoom |
| Pane dots / position | `2 / 3` | neutral status | as column dots | persistent | |
| Back to board | (icon `‹` + task title) | link | `text-fg hover:text-accent` | persistent top bar | existing back navigation |

No new color tokens. Status-list rows in the move sheet use existing `STATUS_COLORS` dots
(the documented hex exception).

## 5. Layout and component plan

- **Screen pattern:** responsive variants of the existing list screen (board) and detail
  screen (terminal).
- **Board carousel structure:**
  - Horizontal track: `display:flex; overflow-x:auto; scroll-snap-type:x mandatory;
    overscroll-behavior-x:contain`. Each column = `width:100vw; scroll-snap-align:start`.
  - Column body: vertical `overflow-y:auto` list of existing `TaskCard`s. Axis
    disambiguation is delegated to the browser (outer x-snap vs inner y-scroll) — no manual
    touch math.
  - Collapsed columns (`useColumnCollapse`) are **excluded** from the track (they are already
    user-hidden). Empty columns **stay** in the track for position stability and show the
    existing compact empty state.
- **Pane carousel structure:** one tmux session rendered by the existing `TerminalView`/ghostty
  canvas; the active pane is kept zoomed via tmux. A `MobilePanePager` bar drives prev/next.
- **Components to reuse:** `TaskCard`, `KanbanColumn` (body/list portion), `LabelFilterBar`,
  `useColumnCollapse`, `TerminalView`, `tmuxAction`, existing status-change handler, `confirm()`
  / bottom-sheet pattern.
- **New components allowed (narrow-only, thin):**
  - `useNarrow()` hook (derives the single gating boolean from `useMobile()`).
  - `MobileBoardCarousel.tsx` — the scroll-snap track + `BoardColumnPager` header.
  - `BoardColumnPager.tsx` — name/count/position/chevrons/dots + jump sheet.
  - `MobilePanePager.tsx` — pane prev/next/position bar.
  - `BottomSheet.tsx` — if no reusable sheet exists yet (column list, filters, move-to).
- **Components not allowed:** any new global-nav element; a JS drag-and-drop carousel; a second
  copy of the board logic (the carousel wraps the same data/handlers, it does not fork them).
- **Data density:** one column or one pane fills the viewport; everything else is a swipe away.
- **Progressive disclosure:** filters, the column list, and per-card move/actions live in
  bottom sheets / action sheets, not always-visible chrome.

## 6. Interaction contract

- **Trigger:** automatic at render when `isNarrow`.
- **Preconditions:** a project is open (board) / a task is open (terminal).
- **Default state:**
  - Board: lands on the column the user last viewed, else the first non-collapsed column
    (`todo`). Pager shows name + `n / N`.
  - Terminal: lands on the active (last-focused) tmux pane, zoomed.
- **Loading state:** board reuses existing skeleton/empty handling; terminal shows the existing
  connecting state. Pager renders once pane count is known.
- **Empty state:** an empty column keeps its slot and shows the existing compact empty state. A
  single-pane session hides the pane pager (nothing to switch to).
- **Error state:** carousel navigation never blocks; a failed `tmuxAction` surfaces via the
  existing toast, position indicator does not advance.
- **Permission-denied state:** n/a (no new permissions).
- **Success state:** swipe / chevron snaps to the next sibling; `aria-live` announces the new
  column or pane.
- **Confirmation/undo:** "Move to <status>" for a task with completion side effects reuses the
  existing `confirmTaskCompletion` flow. Plain status moves are immediate (matching desktop drag).
- **Keyboard and focus:** chevrons are real buttons (Tab/Enter/Space). On column/pane change,
  move focus to the new region's heading and announce via `aria-live="polite"`.
- **Responsive behavior — the two key asymmetries (these resolve the raw idea):**
  1. **Board = full-surface swipe is allowed.** Column bodies scroll vertically only, so a
     horizontal swipe is unambiguous → drive it with native CSS x-snap.
  2. **Terminal = full-surface swipe is NOT allowed.** The pane runs interactive TUIs that
     consume touch and horizontal motion. Pane switching is driven by the **explicit pager**;
     an optional left/right 24px edge-swipe gutter may map to prev/next as a shortcut, but the
     pane body stays free for the running program.
  3. **tmux zoom-keep gotcha:** selecting another pane in tmux auto-unzooms. A carousel step
     must therefore be `select-pane :.+ / :.-` **then** `resize-pane -Z`, ideally as one
     combined backend action (a `keepZoom` flag on `tmuxAction`, or a new `cyclePaneZoomed`),
     to avoid a visible unzoom flash and a double round-trip.
- **Viewport meta:** extend `useViewport()` so a narrow browser uses **device-width** on the
  board/list screens (so one column == one screen), while the terminal screen keeps a stable
  readable width for tmux sizing. Today browser-remote is pinned to `width=1024` for every
  screen — that must relax for the board.

## 7. Accessibility requirements

- **Accessible names:** every chevron/icon button has a `t()` label + tooltip; dots/position
  are decorative with an `aria-live` text equivalent.
- **Focus management:** focus follows the active column/pane heading on change; bottom sheets
  trap focus and restore it on close.
- **Keyboard support:** Left/Right arrow (when the pager region is focused) = prev/next column or
  pane; the pager buttons are the canonical keyboard path. Swipe is never the only way.
- **ARIA / semantic HTML:** board carousel as `aria-roledescription="carousel"` with each column
  `role="group"`/`tabpanel` and the pager as the tablist; pane pager as a labelled `group` with
  prev/next buttons.
- **Contrast and token notes:** semantic tokens only (`text-fg*`, `bg-accent`, `bg-edge`);
  active-dot contrast must meet AA against the column header surface.
- **Motion notes:** honour `prefers-reduced-motion` — snap instantly (no smooth scroll
  animation) when reduced motion is requested.

## 8. Manifest updates

Files updated:

- `docs/ux/ux-architecture.yaml`: add a `responsive` block (breakpoint `narrow < 1024`,
  `board_carousel` and `pane_carousel` view-mode variants, the no-new-nav rule, the
  board-swipe-yes / terminal-swipe-no asymmetry, accessibility requirements).
- `docs/ux/UX_DECISIONS.md`: append the dated decision (this report's core decisions).
- `docs/ux/PRODUCT_UX_BIBLE.md`: add §13 "Responsive / narrow-viewport behaviour".
- `docs/ux/UX_MANIFEST_CHANGELOG.md`: changelog entry.

Summary of changes:

- Establishes a first-class **responsive view-mode layer** in the manifest: narrow viewports get
  one-element-at-a-time carousels of existing screens, with no new navigation and a documented
  rule that the terminal never hijacks full-surface swipe.

## 9. Implementation brief for coding agent

Implement exactly this (when the user asks to build it — this report is planning-only):

1. **Gating** — add `src/mainview/hooks/useNarrow.ts` deriving one boolean from `useMobile()`
   (and exposing it for tests via a forced-narrow path). Do not branch on `isElectrobun`.
2. **Viewport** — in `useViewport.ts`, when narrow + browser, use device-width on board/list
   screens; keep a stable width on the terminal screen.
3. **Board carousel** — add `MobileBoardCarousel.tsx` + `BoardColumnPager.tsx`. In
   `KanbanBoard.tsx`, when `useNarrow()`, render the carousel wrapper around the **same** column
   data, handlers, filters and `TaskCard`s. CSS `scroll-snap` track (one column = 100vw) with a
   vertically scrolling body. Exclude collapsed columns; keep empty columns. Persist last-viewed
   column index.
4. **Move-without-drag** — card long-press opens an action sheet with a "Move to <status>" list
   (current status disabled) wired to the existing status-change handler;
   `confirmTaskCompletion` for completion-side-effect targets.
5. **Filters sheet** — wrap `LabelFilterBar` + search into a `BottomSheet` opened from a board
   header funnel button.
6. **Pane carousel** — add `MobilePanePager.tsx` docked in the terminal workspace (narrow only).
   Wire prev/next/dots to `tmuxAction`. Add a **keep-zoom** combined step in
   `src/bun/rpc-handlers/tmux-pty.ts` (`select-pane :.+`/`:.-` then `resize-pane -Z`, or a
   `keepZoom` flag) so the single zoomed pane stays zoomed across steps. Hide the pager when the
   session has one pane.
7. **i18n** — add `mobile.*` keys (prevColumn/nextColumn/prevPane/nextPane/moveTo/columnList/…)
   to en/ru/es domain files.
8. **a11y/motion** — pager buttons + arrow keys + `aria-live`; honour `prefers-reduced-motion`.
9. **Tests** — `useNarrow` gating, carousel column inclusion/exclusion (collapsed excluded, empty
   kept), move-to action-sheet calls the status handler, pane pager calls `tmuxAction` with
   keep-zoom, pager hidden for single pane.
10. **Docs** — one changelog entry under `change-logs/…`, a feature tip ("Swipe between columns"),
    and a decision record if the tmux keep-zoom/viewport change proves non-obvious.

Do not implement:

- Any new top-level navigation destination, nav item, or "mobile mode" setting as the entry point.
- Full-surface horizontal swipe over the terminal pane body.
- A JS drag-and-drop carousel or a forked second board implementation.
- Any change to `projectSlug()` or anything under `~/.dev3.0/` (on-disk invariants).
- New tmux pane primitives beyond combining the existing `nextPane`/`prevPane`/`zoom`.

Likely files to inspect or modify:

- `src/mainview/hooks/useMobile.tsx`, `hooks/useViewport.ts`, new `hooks/useNarrow.ts`
- `src/mainview/components/KanbanBoard.tsx`, `KanbanColumn.tsx`, `LabelFilterBar.tsx`,
  `hooks/useColumnCollapse.ts`, new `MobileBoardCarousel.tsx` / `BoardColumnPager.tsx` /
  `BottomSheet.tsx`
- `src/mainview/components/TaskWorkspacePane.tsx`, `TaskTerminal.tsx`, `TerminalView.tsx`,
  new `MobilePanePager.tsx`
- `src/bun/rpc-handlers/tmux-pty.ts` (`tmuxAction` keep-zoom)
- `src/mainview/index.css` (scroll-snap + `browser-mode` rules), i18n domain files, `src/mainview/tips.ts`

Acceptance criteria:

- On a <1024px viewport the board shows exactly one column; horizontal swipe / chevrons change
  column, vertical scroll lists tasks; pager shows name + `n / N`; collapsed columns are absent,
  empty columns present.
- A task can be moved between columns without drag (action sheet), reusing the existing status
  path; completion targets still confirm.
- Opening a task shows one zoomed pane; pager moves between panes and the target pane stays
  zoomed (no unzoom flash); pager hidden when only one pane exists.
- Desktop (≥1024px) layout is byte-for-byte unchanged.
- Every swipe action has a working button + keyboard equivalent; reduced-motion users get
  instant snaps.
