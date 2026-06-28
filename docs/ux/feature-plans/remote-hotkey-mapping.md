# Feature plan — Remote-mode keyboard shortcut mapping

## Feature classification

- **User job:** drive dev3 from a browser tab (`dev3 remote`) using the keyboard as effectively as on desktop, without the browser silently eating app shortcuts.
- **Owning object:** the app shell (global keymap), not any single screen.
- **Feature class:** configuration / expert-shortcut behavior that adapts per transport (desktop WKWebView vs browser).
- **Scope:** global. **Frequency:** constant (every keystroke). **Risk:** safe (no data mutation), but a wrong binding silently no-ops or fires the browser's own action.

## Context — how shortcuts work today

Shortcuts are dispatched through **two paths**:

1. **Renderer keydown** — `useGlobalShortcut` chains in `App.tsx` + `hooks/useTaskSwitcher.ts`. These are plain `window` keydown listeners in the React app. The **same** renderer is served to the browser over the WebSocket transport, so these handlers **do run in remote mode**.
2. **Native-menu accelerators** — `src/bun/application-menu.ts`. These fire through the macOS menu bar in the Electrobun desktop shell. **In browser remote mode there is no native menu**, so menu-only accelerators never fire, and the menu's discoverability role disappears.

A single dispatcher, `handleMenuAction` (`src/mainview/menuRouter.ts`), is shared by both the native menu (`rpc:menuAction` push → `App.tsx` listener) and the Command Palette (`CommandPaletteModal` → `onRun`). The palette command set is `ALL_COMMANDS` in `src/mainview/commands.ts`.

**Remote detection already exists:** `isElectrobun` in `src/mainview/rpc.ts:50` (`typeof window.__electrobunWebviewId !== "undefined"`). `!isElectrobun` === browser remote. No new primitive needed.

**Conclusion:** the problem is not "shortcuts don't run in the browser" — most renderer keydown handlers do. The real problems are:

- **A. The browser/OS steals certain combos** before they reach JS (or `preventDefault` is unreliable): `⌘1–9` (tab switch), `⌘N` (new window), `⌘P` (print), `⌘W`/`⌘T`/`⌘L`, browser zoom `⌘±/0`, and on Linux `Ctrl+Tab`/`Ctrl+1–9`.
- **B. Desktop-shell-only shortcuts are meaningless remotely:** `⌘Q` (quits the browser), `⌘H` (hides the browser), New Window, hard-refresh, native zoom, Reveal in Finder, Open in IDE.
- **C. The native menu — a primary discoverability + command surface — is gone.** Its renderer-domain commands must be reachable via the palette or a React surface.

## The remote keymap fate table

Source: `src/mainview/keymap.ts` (`APP_SHORTCUTS`). Fate ∈ {**keep** = leave as-is, **alias** = bind a browser-safe key in remote, **drop** = unbind in remote, **browser** = deliberately yield to the browser's native action}.

| Shortcut | Action | Remote fate | Reason / mitigation |
|---|---|---|---|
| `⌘K` | go-to-project | keep | Free in Chrome/Safari (Firefox `⌘K` = search bar — minor). |
| `⇧⌘P` | command palette | keep | Free; the universal fallback surface. |
| `⌘[` / `⌘]` | back / forward | keep (capture+preventDefault) | Aligns with browser history; we own app-route history, preventDefault in capture phase. |
| `⌘1–9` | switch project | **alias** | Chrome tab-switch can't be prevented. Already aliased: `⌥Tab` switcher + `G` then `1–9` + `⌘K`. Surface these in remote help. |
| `⇧⌘1–9` | switch project (flip) | keep | `⇧⌘`+digit not bound to browser tabs (macOS reserves `⇧⌘3/4/5` for screenshots — pre-existing). |
| `⌘0` | jump to Operations | **alias** | `⌘0` = browser reset-zoom. Remote alias: reachable via `⌘K`/`G` then `0`. |
| `⌥Tab` / `⌥⇧Tab` | task switcher | keep (mac) / **alias** (linux) | Mac `⌥Tab` free; Linux `Ctrl+Tab` cycles browser tabs → needs a Linux-remote alias. |
| `F` / `⌘G` | task hints | keep | Bare `F` works; `⌘G` (find-next) only matters after a find. |
| `G then D/P/T/S/1–9` | go-to chords | keep | Bare keys — fully browser-safe. **The recommended remote nav primitive.** |
| `/` | focus search | keep | Works (Firefox `/` quick-find — minor). |
| `Esc` | escape | keep | Works. |
| `⌘N` / `C` | new task | **alias → C** | `⌘N` = browser new window (hard). Bare `C` already works → it is the remote path. |
| `⌘P` | add project | **alias** | `⌘P` = browser print (hard). No bare alias today → add one (e.g. remote help points to palette "Add project", or bind a safe combo). |
| `⇧⌘N` | new window | **drop** | A 2nd app window is meaningless over one browser tab; collides with incognito. |
| `⌘,` | settings | keep | Browser doesn't use `⌘,`. |
| `⌘=` / `⌘-` / `⇧⌘0` | zoom | **browser** | Yield to the browser's native zoom; drop the app handlers in remote. |
| `⌘R` | hard refresh | **browser** | Yield to browser reload. |
| `⌘/` | keyboard shortcuts | keep | Works. |
| `` ⌘` `` | toggle project terminal | keep | Single browser window → mostly free; preventDefault works. |
| `` ⇧⌘` `` | quick shell | keep | Free. |
| `⌘Q` | quit | **drop** | Quits the browser; no concept of "quit" for a remote session. |
| `⌘H` | hide | **drop** | Hides the browser; meaningless remotely. |

## Command Palette coverage audit

The palette (`ALL_COMMANDS`, 33 entries) + React surfaces are the **only** command entry points in remote (menu is gone). Audit of every native-menu / `MENU_ACTIONS` command:

### Reachable in remote — no action needed

- **In the palette already:** new-task, add-project, dashboard/kanban/changelog nav, settings, project-settings, back/forward, theme ×3, locale ×3, pull-main, create-pr, dev-server start/stop/restart/status, toggle-watch, copy-worktree-path, run-script, move-todo/in-progress/user-questions/review-ai/review-user, toggle-project-terminal, quick-shell, tmux cheat-sheet, keyboard-shortcuts.
- **On a React surface (inspector / context menu / settings) — validated:**
  - Git: **push, merge-to-main, rebase, create-PR, branch-status** → buttons in `components/task-info-panel/TaskGitActions.tsx`.
  - Task lifecycle: rename, set-overview, add-note, spawn-variants (`LaunchVariantsModal`), duplicate (`CreateTaskModal`), delete / mark-completed / mark-cancelled (`TaskDetailModal` / `TaskCard` / context menus).
  - Project config: custom-columns (`ProjectSettings`), custom-labels (`LabelPicker` / `ProjectSettings`).
  - Clone repo → `AddProjectModal` (clone tab).
- **Via tmux `⌃B` prefix typed into the live terminal:** all terminal pane ops (split/zoom/close/select/swap/rotate/resize/break/join/sync/send-to-all/capture/record/layout-*). The native-menu GUI shortcut for these is gone in remote, but the function is intact through the tmux prefix.

### Desktop / bun-only — correctly absent in remote (no fix)

about, check-for-updates, new-window, reveal-project-folder, **task-open-in-ide**, zoom in/out/reset (browser owns zoom), hard-refresh (browser reload), toggle-devtools, open-logs-directory, gauge-demo, viewport-lab. These run bun-side and never reach the renderer; their absence in remote is expected.

### True gaps to fix

| Gap | Type | Recommendation |
|---|---|---|
| **`task-open-in-finder` is IN the palette** (`commands.ts:74`) | reverse-gap | `openFolder` opens Finder **on the server host**, not the remote user's machine → confusing in remote. **Hide this palette command when `!isElectrobun`.** |
| `find-in-tasks` (`⌘F`) | keyboard shadowed | Native-menu-only accelerator; in browser `⌘F` = find-in-page. Functionally replaced by `/` focus-search. Acceptable; document it. Optionally add a palette "Find in tasks" entry. |
| `find-in-terminal` | minor | Native-menu-only; ghostty-web/tmux copy-mode covers search. Document; optional palette entry. |
| `view-tips` ("Tips" view) | minor | Confirm a non-menu entry exists; if not, add a palette "Show tips" command (already routable pattern). |

## Recommended design

A platform-aware keymap with the palette as the guaranteed fallback. This mirrors the project's "no native dialogs in remote" philosophy — the keymap degrades the same way the UI does.

1. **`keymap.ts` becomes the single source of remote truth.** Extend `ShortcutSpec` with:
   - `scope?: "both" | "desktop" | "remote"` (default `"both"`).
   - `remoteKeys?: { mac: string; other: string }` — the browser-safe combo shown/bound in remote.
   A small `remoteShortcutKeysFor(spec)` helper returns `remoteKeys ?? keys`. The registry already feeds the modal, README, and website, so the remote variant propagates everywhere from one place.
2. **`App.tsx` dispatcher becomes remote-aware** via `isElectrobun`:
   - Skip `drop`-fated branches in remote (`⌘Q`, `⌘H`, `⇧⌘N`, zoom, hard-refresh).
   - For `browser`-fated combos (zoom/reload) do **not** `preventDefault` in remote — let the browser do its native thing.
   - For `alias`-fated combos, ensure the documented alias path works (mostly already does: `C`, `G`-chords, `⌥Tab`, `⌘K`).
3. **`KeyboardShortcutsModal` becomes remote-aware:** render `remoteKeys`, hide `scope:"desktop"` rows, and show a one-line notice — "In the browser some combos are reserved by your browser; use the Command Palette (`⇧⌘P`)." Hide the native-menu-implied rows that don't apply.
4. **Palette adjustments (`commands.ts`):** hide `task-open-in-finder` when `!isElectrobun`; optionally add `find-in-tasks` / `view-tips` entries (both already routable through `handleMenuAction` patterns or a CustomEvent).

## Action hierarchy & tokens

No new buttons. The only visible surface change is an informational notice line in `KeyboardShortcutsModal` — semantic role `text-fg-3` helper text, no button, no accent. The palette and modal already exist; this feature reshapes their **content** per transport, not their placement. Zero impact on toolbar/inspector complexity budgets.

## Interaction details

- **Detection:** read `isElectrobun` once; pass a `remote` boolean into the keymap helpers, the dispatcher, the modal, and `availableCommands`.
- **Empty/edge states:** none new. On Linux remote, the `⌥Tab`/`Ctrl+Tab` task-switcher needs its alias surfaced.
- **Accessibility:** the notice is plain text in the existing modal; no focus changes.
- **Responsive:** unchanged.
- **Copy:** one i18n string (en/ru/es) for the remote notice; any new palette labels reuse existing keys where possible.

## Risks

- `preventDefault` reliability varies by browser/combo; the table marks only combos we can realistically own as `keep`. Anything dubious is `alias`/`browser`, never a false promise.
- Keeping `keymap.ts` in lockstep with `App.tsx` handlers is an existing manual discipline (AGENTS.md); adding `scope`/`remoteKeys` widens the surface but stays in one file.
- macOS `⇧⌘3/4/5` (screenshots) remain OS-reserved — pre-existing, out of scope.

## Alternatives considered

- **Command Palette only (no keymap changes):** cheapest, but abandons muscle-memory for `⌘1–9`/`⌘N` and leaves `task-open-in-finder` misleading in remote. Rejected as the sole solution; adopted as the fallback layer.
- **Full remote remap of every conflicting combo:** keyboard-complete but creates a divergent desktop/browser map users must relearn. Rejected — only remap where the browser genuinely steals the combo.
- **Leader-key mode in remote:** namespaces all app shortcuts behind a prefix; powerful but unfamiliar and heavy. Rejected.

## Files likely to change (at implementation time)

- `src/mainview/keymap.ts` — `scope` / `remoteKeys` + helper.
- `src/mainview/App.tsx` — remote branches in the `useGlobalShortcut` dispatcher.
- `src/mainview/components/KeyboardShortcutsModal.tsx` — remote rendering + notice.
- `src/mainview/commands.ts` — hide desktop-only palette command in remote; optional additions.
- `src/mainview/i18n/translations/{en,ru,es}/*` — remote notice + any new labels.
- Tests: `__tests__/keymap.test.ts`, `CommandPaletteModal.test.tsx`.

## What NOT to implement

- Do not try to `preventDefault` `⌘1–9` / `⌘N` / `⌘P` in the browser — Chrome won't yield; rely on aliases + palette.
- Do not add a remote replacement for desktop-only actions (quit/hide/IDE/Finder/devtools).
- Do not introduce a native menu replacement bar — the palette + modal cover discoverability.
