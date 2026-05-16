# 049 — Global Menu Redesign

## Context

The native macOS menu bar (File / Edit / View / Window) was barely used: only ~10
items across 5 top-level menus, while the app exposes ~70 user-facing features
(task lifecycle, git operations, tmux pane / window / session management, dev
server control, theme & locale switching, etc.). Most features were reachable
only through buttons inside the renderer — cramming the `GlobalHeader` (12+
icons) and hiding tmux operations entirely from new users.

The native menu is the canonical discoverability surface on macOS. It also
delivers global keyboard shortcuts through `NSMenu`, which work even when focus
is inside a tmux pane.

## Decision

Move from 5 to 9 top-level menus, organised as a hybrid of macOS HIG conventions
and the app's domain model:

```
dev-3.0  File  Edit  Task  Project  View  Terminal  Window  Help
```

Conventional menus (`File`, `Edit`, `View`, `Window`, `Help`) keep their
standard semantics; domain menus (`Task`, `Project`, `Terminal`) are
context-aware — disabled when no current task / project / terminal is in scope.

Highlights:

- `File` — task creation, project add / clone, project switcher (dynamic
  submenu, `⌘1..9`).
- `Task` — rename, overview, notes, status moves, labels, spawn variants,
  open in IDE, copy worktree path.
- `Project` — git operations (pull / push / PR / merge / rebase), dev server
  control, project settings, custom columns / labels.
- `Terminal` — full tmux exposure: pane split / select / **swap (mark + swap
  pattern)** / resize / break / join / synchronize / capture, layouts (incl.
  preset save / apply), windows (new / rename / mark + swap / find), sessions
  (new / rename / detach / kill others), copy mode & buffers. Plus
  `Show Tmux Cheat Sheet` rendered through `tmux display-popup` (overlay
  preserves layout, single `less` invocation).
- `View` — navigation (Dashboard / Kanban / Changelog / Tips), zoom, theme,
  language, full-screen, dev tools.
- `Help` — docs, shortcuts, cheat sheet, GitHub, bug report, remote-access QR,
  diagnostics.

Domain menus rebuild dynamically on state push (current task, current project,
projects list, labels, custom columns, dev-server state) via
`ApplicationMenu.setApplicationMenu(template)`.

Implementation lives in `src/bun/application-menu.ts` (builders split per
menu); dispatch routed through `Electrobun.events.on("application-menu-clicked")`
in `src/bun/index.ts`, fanning out to existing RPC handlers
(`spawnVariants`, `tmuxAction`, `pullProjectMain`, etc.).

### What does *not* land in the menu

- `display-popup` is used **only** for the cheat sheet. Sessions are managed
  through the existing React modal — popup `choose-tree -Z` was evaluated and
  rejected for the session manager (monospaced, off-brand, no badges).
- Header is slimmed in a follow-up: 6 icons (QR, tmux sessions popover, GitHub,
  Bug, Changelog, Project Settings) move into the menu; what remains in the
  header is the visual-state stuff (project switcher, terminal toggles with
  running indicators, git-pull with "behind by N" indicator, update countdown,
  unified settings icon).

## Risks

- **Shortcut collisions.** All accelerators were audited against tmux defaults
  (`⌃B` prefix is untouched) and macOS system shortcuts. Future additions must
  re-check.
- **Dynamic submenu rebuild cost.** `setApplicationMenu` is called every time
  state changes; if profile reveals jank, we batch through a 100 ms debounce.
- **Context staleness.** Native menu reflects the renderer's last pushed state.
  We push on every project / task / dev-server change, but the menu can lag a
  frame during transitions — acceptable for the "disabled" affordance.

## Alternatives considered

- **Document-centric (5 menus)** — minimum churn, but loses every domain
  feature. Rejected: ~60 features remain hidden.
- **Object-centric (Task / Project / Terminal as the only menus, no File /
  Edit / View)** — breaks macOS conventions; users hunt for "Quit" /
  "Preferences" / clipboard ops.
- **Mode-centric (menus change per view)** — context-shifting menus violate
  macOS HIG and confuse keyboard-shortcut muscle memory.
- **Native tmux `display-popup choose-tree -Z` as the session manager** — has
  live pane preview, mouse, search, kill, rename for free. Rejected: visual
  style doesn't match the rest of the UI and tmux session names
  (`dev3-324d2bb1`) are unreadable without a renaming layer. Kept as an
  internal trick for the cheat sheet only.

## References

- `src/bun/application-menu.ts` — menu builder
- `src/bun/index.ts` — `application-menu-clicked` dispatch
- `src/bun/menu-actions.ts` — side-effects (open logs, etc.)
- `vendor-docs/electrobun/apis/application-menu.md` — Electrobun menu API
- macOS HIG — App Menus and Menu Bar Menus
