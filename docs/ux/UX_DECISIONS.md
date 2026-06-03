# UX Decisions

Append-only log of UX architecture decisions. Each entry: date, decision, rationale, evidence/status.

## 2026-05-29 — Initial manifest derived from repository

- **Decision:** Treat dev-3.0 as a full-screen desktop web app with a **screen-based navigation model** (the `Route` union in `src/mainview/state.ts`), not a URL-routed site. The manifest's "routes" are screen ids.
- **Rationale:** There is no URL router; navigation is `useReducer` + back/forward history. Modeling it as URL routes would be fiction.
- **Status:** `Observed`.

## 2026-05-29 — Button variants documented as role → token, not as a prop

- **Decision:** Document button semantics by semantic role mapped to Tailwind token classes (`bg-accent` = primary, `text-danger`/`bg-danger` = destructive, ghost = hover surface) rather than a `<Button variant>` API.
- **Rationale:** No formal Button component or `variant` prop exists; buttons are styled inline. AGENTS.md forbids hardcoded colors and mandates semantic tokens.
- **Status:** `Observed`.

## 2026-05-29 — Native application menu is the canonical action surface

- **Decision:** Treat the Electrobun application menu (`src/bun/application-menu.ts`) as the authoritative, complete action taxonomy; DOM toolbars mirror only the frequent subset.
- **Rationale:** The native menu enumerates every File/Edit/Task/Project/View/Debug action; DOM surfaces are intentionally partial to control density.
- **Status:** `Observed`.

## 2026-05-29 — Toolbar button creep flagged as the primary anti-pattern

- **Decision:** Set explicit complexity budgets and require an overflow/group decision before adding visible buttons to `TaskInfoPanel`, `TaskCard`, or board toolbars.
- **Rationale:** Changelog history shows a steady accretion of always-visible git/tmux/dev-server buttons; these are the densest, highest-risk surfaces.
- **Status:** `Inferred` (from changelog + file sizes).

## 2026-06-03 — Prevent-sleep surfaced as a header toggle with a new `--awake` token

- **Decision:** Surface the existing `preventSleepWhileRunning` setting as a prominent header toggle (`PreventSleepToggle`) placed immediately left of Home Terminal, using a coffee glyph and a new semantic `--awake` (amber) token defined in both themes. Default on. While remote access is active (Cloudflare tunnel connected or a browser client attached) it is forced on and locked. Semantics changed: when enabled, sleep is inhibited for the whole time the app runs (driven by the resource-monitor poll), not only while agents are active.
- **Rationale:** The feature was buried in Settings and invisible. The user wanted an obvious, always-visible control and "machine never sleeps while remote." Amber/coffee reads as "awake" and is distinct from `--warning`. Remote-active detection lives in `remote-access-server.isRemoteAccessActive()`; it is imported lazily inside the resource-monitor poll to keep that module free of electrobun-heavy imports.
- **Status:** `Observed` (implemented: `PreventSleepToggle.tsx`, `caffeinate.ts`, `app-handlers.ts`, `index.css`/`tailwind.config.js`).

## 2026-06-03 — TaskInfoPanel governed by a 4-bar 2×2 domain model

- **Decision:** The inspector header is a 2×2 grid of quickbars (2 rows × left|right), one bar per action domain: Context (row1-left), Session/Agent (row1-right), Git (row2-left), Runtime (row2-right). Panel chrome (collapse/fullscreen/⚙) is pinned to row-1 far-right and is **not** a bar. Moved `dev-server` + `scripts` out of the overloaded row-1-right cluster into the previously unused row-2-right (next to Git). Labels in the Context bar truncate to 4 inline chips + a `+k` chip. See bible §5.1.
- **Rationale:** Row-1-right had become a dumpster mixing 4 domains (agent, terminal, dev-server, panel-nav). Wide desktop width lets each row carry a left+right bar, so domains separate cleanly without adding rows (the panel has a hard `MAX_RATIO=0.33` height budget). Row 1 = "Drive", row 2 = "Outputs".
- **Status:** `Observed` (implemented in `TaskInfoPanel.tsx`).

## 2026-06-03 — Quit confirmation is a React modal on explicit-quit paths only

- **Decision:** The "sessions keep running" quit confirmation is a React modal (Modal surface), driven by a single `before-quit` gate in the main process. It fires on the explicit quit commands that have a window — Cmd+Q (the renderer catches the keystroke and forwards via `requestQuit`, since WKWebView swallows the native menu accelerator), the menu Quit item, and dock Quit. Closing the **last window** with the red X quits **without** the dialog. No native `showMessageBox` is used (it would be wrong for the remote/browser client). Decision records 061 (quit gate) and 060 (shared-PTY smallest-client resize).
- **Rationale:** One confirmation for every deliberate quit, kept in React so it works identically in the remote client (we are removing native dialogs). The native window-close event is not interceptable, so showing a dialog there would require reopening a window — which flashed and raced the renderer mount; quitting is not truly destructive (tmux sessions persist), so closing the last window is treated as a deliberate exit. Asymmetry is intentional and documented.
- **Status:** `Observed` (implemented: `App.tsx`, `src/bun/index.ts` gate, `quit-manager.ts`, `app-handlers.ts` `requestQuit`/`quitApp`).
