# 068 — Option+Tab task switcher

## Context

Users wanted a fast keyboard way to jump between active tasks (Slack thread): a quick toggle between the two you're juggling, plus a way to reach any task when you have many. We rejected a command palette — the active-tasks sidebar already owns `task_jump`, and a new global palette would be surface creep (see `docs/ux/feature-plans/option-tab-task-switcher.md` and the 2026-06-15 UX decision).

## Decision

A transient HUD overlay (`TaskSwitcherOverlay`) driven by `useTaskSwitcher` (`src/mainview/hooks/`). Hold the modifier, tap Tab to advance (wrap-around), release to commit; arrows ↑/↓ move both ways; Enter commits; Esc cancels. Order is MRU (`AppState.taskMru`, bumped in the reducer's `navigate`/`goBack`/`goForward`), so a quick tap-tap toggles the two most recent tasks. Rows show a live ANSI terminal snapshot (`getTerminalPreview` → `ansiToHtml`), title, and overview. Commit honors `dev3-task-open-mode` (split/fullscreen), same as Cmd+1..9.

Bindings differ by platform: **Option(Alt)+Tab / Option+Shift+Tab** on macOS, **Ctrl+Tab / Ctrl+Shift+Tab** on Linux (`isMac()` in `src/mainview/utils/platform.ts`).

## Risks

- **Linux WM grab:** Alt+Tab is intercepted by most Linux window managers before the webview, hence the Ctrl+Tab fallback. Ctrl+Tab is rarely bound by shells, but if a future conflict appears the binding lives in one place.
- **keyup reliability:** the hold-release commit depends on the modifier `keyup` reaching the window. WKWebView can drop it (e.g. focus change); Enter/Esc/click are explicit fallbacks that always work.
- The keydown listener is capture-phase and `preventDefault`s Tab only while a session is open, so it does not interfere with normal Tab focus traversal or the terminal (which already ignores alt-modified keys).

## Alternatives considered

- **Command palette (Cmd+K):** rejected — net-new surface duplicating the sidebar's jump+search; the project's #1 anti-pattern.
- **Shift to reverse-cycle:** unavailable — Shift selects global scope (Option+Shift+Tab), so reverse uses arrows instead.
- **Status-priority order instead of MRU:** rejected — breaks the alt-tab tap-tap toggle the users explicitly asked for.

