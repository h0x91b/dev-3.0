# UX Principal Report: Option+Tab task switcher

Date: 2026-06-15
Mode: planning only
Manifest status: updated (added `task_switcher` surface)
Confidence: high

## 1. Feature understanding

- **User job:** Jump between active tasks from the keyboard without touching the mouse; quick toggle between the two most recent; scan many with an intermediate highlighted state before committing.
- **Owning workflow:** Task navigation (`task_jump`). The active-tasks sidebar already owns this action class; this feature is a transient keyboard presentation of it.
- **Feature class:** `expert_shortcut` (keyboard) rendered as a transient HUD overlay.
- **Scope:** Project (Option+Tab) and global / all projects (Option+Shift+Tab).
- **Frequency:** Constant (power-user core loop).
- **Risk:** Safe — navigation only, no mutation.
- **Discoverability need:** Low intrinsically (hidden shortcut). Mitigate with a feature tip and an entry in the native application menu `View`.
- **Assumptions:** "Active" = `ACTIVE_STATUSES` (`src/shared/types.ts:29`). Terminal previews already exist (`useTerminalPreview`, `TerminalPreviewPopover`).

## 2. UX placement decision

Recommended placement:

- **Route/screen:** None — global, screen-independent (mounted in `App.tsx`, available from any screen).
- **Surface:** New transient **`task_switcher`** HUD overlay — centered, `bg-overlay`, high z-index. A presentation of `task_jump`, not a navigation surface.
- **Menu/nav group:** Mirror as an entry under native menu `View` for discoverability (no DOM nav change).
- **Entry point:** Keyboard only. macOS: `Option+Tab` (project) / `Option+Shift+Tab` (global). Linux: `Ctrl+Tab` / `Ctrl+Shift+Tab` (platform-detected — Alt+Tab is grabbed by the WM before the webview).
- **Visibility rule:** Hidden until summoned; visible only while the switch session is active.

Rejected placements:

- **Command palette (Cmd+K)** — net-new global surface that duplicates the sidebar's `task_jump`+`search`; triggers the #1 project anti-pattern (surface creep / "new component for old pattern"). The app has no palette and this feature does not justify introducing one.
- **Cmd+Shift+1..9** — caps at 9, does not scale to "tens of tasks".
- **Vimium link-hints on the board** — legitimate `expert_shortcut` but a different mechanism/surface. Separate ticket (see §9).
- **Global header / breadcrumbs** — navigation = destinations, not commands (budget ≤7).

Rationale:

- The manifest already assigns `task_jump` to the sidebar; an Option+Tab HUD is the same action class in a transient keyboard form, so it extends an existing pattern instead of inventing a parallel one.
- It is not a command runner (no actions are executed), so it is not a command palette and does not open that surface category.

Evidence:

- `src/mainview/components/ActiveTasksSidebar.tsx`, `src/mainview/components/ActiveTasksStrip.tsx` (existing jump-list + row rendering to reuse)
- `src/mainview/App.tsx:242-339` (existing `useGlobalShortcut` block; Cmd+1..9 commit/view-mode logic at :310-334)
- `src/mainview/hooks/useGlobalShortcut.ts` (capture-phase listener)
- `src/mainview/TerminalView.tsx:884`, `src/mainview/shift-key-sequences.ts:45` (alt-modified keys are intentionally ignored by the terminal → Option+Tab is free to capture)

## 3. Navigation and menu changes

- **Add:** native menu `View` entries "Switch Task" / "Switch Task (All Projects)" with the platform accelerator, for discoverability.
- **Rename / Move / Remove:** none.
- **No change:** global header, breadcrumbs, sidebar, board.

## 4. Action hierarchy and token decisions

The overlay is a **status surface** (no CTAs). All via semantic tokens, zero hardcoded color.

| Element | Label | Semantic role | Concrete variant/token | Visibility | Notes |
|---|---|---|---|---|---|
| Overlay container | — | neutral | `bg-overlay`, `border-edge`, shadow | while session active | centered HUD |
| Highlighted row | — | accent (selection) | `bg-accent/15`, `text-fg` | follows cursor | the to-be-committed task |
| Row title | task title | neutral | `text-fg` | persistent in overlay | bold |
| Row overview | overview | neutral | `text-fg-muted`, 1 line, truncate | persistent | empty → omit line |
| Row status dot | — | status | `STATUS_COLORS` (documented hex exception) | persistent | |
| Project name (global only) | project name | neutral | `text-fg-3` | global mode only | |

No primary/destructive buttons.

## 5. Layout and component plan

- **Screen pattern:** transient modal-less HUD overlay (new for this project, recorded in the manifest).
- **Row content (locked with user):** terminal screenshot · task title · overview. Global mode adds project name.
- **Components to reuse:** terminal preview (`useTerminalPreview` / `TerminalPreviewPopover` image source), row bits from `ActiveTasksStrip` / `ActiveTasksSidebar` (status dot, `LabelChip`, `getTaskAgentMeta`, bell counts), commit/view-mode logic from `App.tsx` Cmd+1..9 (`dev3-task-open-mode`).
- **New components allowed:** `TaskSwitcherOverlay.tsx` + a switcher hook (cycle state machine). One new transient surface only.
- **Components not allowed:** any command-palette / global action-runner; no new persistent nav.
- **Data density:** low — it is a transient HUD, not the inspector. Cap rows visible; scroll/condense beyond a threshold.
- **Progressive disclosure:** overview is a single truncated line; full detail stays in the inspector.

## 6. Interaction contract

- **Trigger:** macOS `Option(Alt)+Tab` (project) / `Option+Shift+Tab` (global); Linux `Ctrl+Tab` / `Ctrl+Shift+Tab`.
- **Preconditions:** ≥1 active task in the chosen scope.
- **Open + cycle model (locked):** classic **hold** — hold the modifier, each Tab advances the highlight with wrap-around; **arrows ↑/↓** move bidirectionally; **release the modifier commits** the highlighted task.
- **Reverse:** arrows ↑/↓ (Shift is unavailable — it selects global scope).
- **Live scope toggle:** while the overlay is open, holding Shift widens to global (all projects) and releasing it narrows back to the current project; the highlighted task is preserved across the switch when it still exists in the new scope.
- **MRU order (locked):** in-memory stack of recently-focused task IDs; most recent first; first Tab lands on the previous task so tap-tap toggles the last two. Resets on app reload.
- **Commit:** release modifier → navigate to highlighted task honoring `dev3-task-open-mode`. **Enter** / click also commit; these double as a fallback if the WKWebView modifier `keyup` is dropped.
- **Cancel:** **Esc** → close, no navigation, restore prior focus.
- **Default state:** hidden.
- **Loading state:** terminal screenshot may lag — show a placeholder tile, never block cycling.
- **Empty state:** 0 active tasks → do not open (optional brief toast).
- **Single-task state:** 1 active task → show the one row; cycling is a no-op; release commits to it (no-op if already there).
- **Error/permission states:** n/a (read-only navigation).
- **Keyboard and focus:** capture-phase listener so the terminal cannot swallow it; `preventDefault` on Tab to stop focus traversal; restore focus to the prior element on cancel.
- **Responsive behavior:** fixed centered overlay; cap width; long titles/overviews truncate.

## 7. Accessibility requirements

- **Accessible names:** overlay `role="dialog"` / listbox semantics; each row exposes title + status as accessible name.
- **Focus management:** trap nothing destructive; on cancel restore prior focus; on commit move focus into the opened task surface.
- **Keyboard support:** Tab (forward+wrap), ↑/↓ (bidirectional), Enter (commit), Esc (cancel), modifier-release (commit).
- **ARIA / semantic HTML:** active row marked `aria-selected`; live region announces the highlighted task title.
- **Contrast and token notes:** selection `bg-accent/15` over `bg-overlay` must meet contrast in both themes; status dots from `STATUS_COLORS`.
- **Motion notes:** no large motion; fade/scale ≤120ms; respect reduced-motion.

## 8. Manifest updates

Files updated:

- `docs/ux/ux-architecture.yaml`: added `task_switcher` surface.
- `docs/ux/UX_DECISIONS.md`: appended the 2026-06-15 decision.
- `docs/ux/UX_MANIFEST_CHANGELOG.md`: appended the surface-addition entry.
- `docs/ux/feature-plans/option-tab-task-switcher.md`: this file.

## 9. Implementation brief for coding agent

Implement exactly this:

1. **MRU tracking:** an in-memory stack of recently-focused task IDs, updated wherever a task becomes the active/open task (e.g. on `navigate` to a task). Store in app state (`state.ts`), not persisted.
2. **Switcher hook + state machine:** open on the platform binding, hold-cycle with Tab/arrows, commit on modifier-release/Enter/click, cancel on Esc. Capture-phase `useGlobalShortcut`, gate on `altKey` (mac) / `ctrlKey` (linux) + `e.key === "Tab"`, `preventDefault`. Detect platform to pick the modifier.
3. **`TaskSwitcherOverlay.tsx`:** centered HUD listing the scoped active tasks (project vs global) in MRU order; each row = terminal screenshot + title + overview (+ project name in global). Selection styling via tokens.
4. **Commit:** navigate to the highlighted task reusing the `dev3-task-open-mode` logic from `App.tsx` Cmd+1..9.
5. **Discoverability:** native menu `View` entries + a feature tip (`tips.ts` + en/ru/es).
6. **i18n:** all strings via `t()` in en/ru/es.
7. **Tests:** state-machine cycle (forward/wrap/reverse), scope selection, MRU ordering + tap-tap toggle, commit/cancel, empty/single-task, platform-binding selection.

Do not implement:

- A command palette or any global action-runner.
- A new persistent navigation surface or header control.
- Vimium-style board link-hints (separate ticket).

Likely files to inspect or modify:

- `src/mainview/App.tsx` (mount overlay, shortcut wiring, reuse Cmd+1..9 commit logic)
- `src/mainview/state.ts` (MRU stack, switcher session state)
- `src/mainview/components/TaskSwitcherOverlay.tsx` (new)
- `src/mainview/components/ActiveTasksStrip.tsx` / `ActiveTasksSidebar.tsx` (row-render reuse)
- `src/mainview/hooks/useTerminalPreview.ts` (terminal screenshot source)
- `src/bun/application-menu.ts` + `menu-actions.ts` (View entries)
- `src/mainview/tips.ts`, `src/mainview/i18n/translations/{en,ru,es}/*`

Acceptance criteria:

- Option+Tab (mac) / Ctrl+Tab (linux) opens the overlay scoped to the current project's active tasks; Shift variant scopes to all projects.
- Holding the modifier and tapping the key advances with wrap-around; arrows move both ways; release commits; Enter/click commit; Esc cancels.
- Order is MRU; a quick double-tap toggles the two most recent tasks.
- Each row shows terminal screenshot + title + overview (project name in global mode).
- No new persistent UI; no command palette; all strings localized; tests green; `bun run lint` + `bun run test` pass.
