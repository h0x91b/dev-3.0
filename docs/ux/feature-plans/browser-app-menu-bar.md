# Feature plan — Browser-mode application menu bar

Status: Planned (2026-06-28)
Owner: UX Principal
Feature class: `expert_shortcut` carrier surface (the action-taxonomy overflow surface), browser-only chrome.

## Problem

In the Electrobun desktop shell, the **native macOS/Linux menu bar** (`src/bun/application-menu.ts`)
is the canonical home for the full action taxonomy (File / Edit / Project / View / Terminal / Help)
and the documented "overflow/expert" surface. In **Remote Access / browser mode** (`isElectrobun ===
false`, `.browser-mode` on `<html>`) that entire surface **vanishes** — the OS does not draw it. A
browser user therefore loses the single most complete entry point to the app's actions; only the
keyboard-only command palette (⇧⌘P) mirrors a subset.

Goal: render the menu bar ourselves as in-app React UI **only in browser mode**, at parity with the
native menu, dispatching through the **same** `handleMenuAction` router.

## Decision summary

1. **Placement — a dedicated menu-bar strip as the first row of the app, above `GlobalHeader`,
   browser-only.** This mirrors the desktop mental model exactly: on desktop the OS draws this strip
   above the in-window breadcrumb header; in the browser we draw it in the same position. It adds
   **zero** pressure to `GlobalHeader`'s already-dense right cluster (toolbar-button-creep is the #1
   project anti-pattern), and it is a fresh surface with its own budget.
   - **Reject** merging into `GlobalHeader`: violates "header = location + switching only" and bloats
     the dense right cluster.
   - **Reject** a single `≡` hamburger as the primary form on wide screens: collapses the whole
     taxonomy behind one extra click and loses the menu-bar affordance. (`≡` is the *responsive*
     fallback only — see Responsive.)

2. **Source of truth — relocate the pure menu definition to `src/shared/application-menu.ts`; the
   renderer builds the menu locally from its own `MenuContext`.** `application-menu.ts` is already
   pure (its only electrobun dependency is a **type-only** `import type { ApplicationMenuItemConfig }`,
   erased at build). Move it to `src/shared/` (the home for cross-process pure code, alongside the RPC
   schema). Both `src/bun/index.ts` and the renderer import `buildApplicationMenu(context)`.
   - Renderer already computes `{hasTask, hasProject, hasTerminal}` for the existing
     `updateMenuContext` push (`App.tsx:120`) → it passes the same context straight into
     `buildApplicationMenu`, getting **instant, synchronous, drift-free** enable/disable.
   - **Reject** a `getApplicationMenu` RPC: needless round-trip for data the renderer can build
     locally; bun would rebuild + push back a structure the renderer itself triggered.
   - **Reject** a duplicate renderer-side menu definition: guaranteed drift; defeats the one-taxonomy
     architecture.

3. **Native-only `role` items are dropped in the browser.** `cut/copy/paste/undo/redo/selectAll` are
   already provided by the browser (right-click + standard shortcuts); `quit/hide/hideOthers/showAll/
   minimize/zoom/close/toggleFullScreen/bringAllToFront/cycleThroughWindows` have no meaning without
   the OS shell/dock. The renderer renders only nodes that carry an `action` (or submenus that contain
   one), so:
   - **Edit** menu → its only non-role items (`Find in Tasks`, `Find in Terminal`) are
     `NOT_YET_IMPLEMENTED`; the menu collapses to all-disabled. **Drop the Edit top-level entirely in
     browser** (re-add automatically once a real Edit action ships).
   - **Window** menu → all roles → **dropped**.
   - **App (dev-3.0)** menu → keep About, Check for Updates, Settings, Theme, Language; drop the
     hide/quit roles.
   - Net top-level set in browser: **dev-3.0 · File · Project · View · Terminal · Help** (6 ≤ budget 7).

4. **Enable/disable + roadmap are inherited, not re-implemented — but the browser is stricter.**
   `buildApplicationMenu` already bakes `enabled` from `NOT_YET_IMPLEMENTED` (roadmap) ∪
   `meetsContext` (REQUIRES_TASK/PROJECT/TERMINAL). The browser filter (`buildBrowserMenu`) then:
   **drops** roadmap items (`isComingSoonAction`) and any action not in `BROWSER_HANDLED_ACTIONS`
   (bun-only) entirely — so the bar lists only what this build can actually run — and **greys**
   the remainder when their **context** is absent (e.g. task actions with no task selected),
   matching native context-greying. Net effect: cleaner than the native menu (no roadmap noise),
   still native-like (menus stay put, items grey when N/A).

5. **Dispatch — call `handleMenuAction(action, ctx)` directly.** No `rpc:menuAction` round-trip; the
   browser menu is a peer caller of the same router the native menu feeds.

6. **Labels stay English (intentional i18n exception).** The native menu is hardcoded English and is
   not in the i18n system. Rendering the **same** strings keeps desktop⇄browser parity; translating
   only the browser copy would diverge the two menus. Documented exception, same class as the native
   menu already being English-only. (A future task can i18n *both* menus from one shared label map.)

## Token roles (chrome — no new tokens)

| Element | Role | Token |
|---|---|---|
| Menu bar strip | chrome surface | `bg-base` (or `bg-raised`), `border-b border-edge` |
| Top-level item (idle) | neutral/ghost | `text-fg-3 hover:text-fg hover:bg-elevated` |
| Top-level item (open) | neutral active | `bg-elevated text-fg` |
| Dropdown panel | popup surface | `bg-overlay border border-edge shadow`, rounded |
| Item (enabled) | neutral | `text-fg-2 hover:bg-raised-hover hover:text-fg` |
| Item (disabled / roadmap) | muted | `text-fg-muted/40`, no hover, `cursor-default` |
| Destructive item (e.g. Mark Cancelled) | destructive | `text-danger hover:bg-danger/10` |
| Accelerator hint | meta | `text-fg-muted` right-aligned |
| Separator | edge | `border-t border-edge` |
| Submenu caret (`›`) | meta | `text-fg-muted` |

## Interaction & a11y

- **Open/close:** click a top-level item to open its dropdown; while any menu is open, **hovering**
  another top-level item switches to it (classic menu-bar behavior). Click an enabled item → run +
  close. **Esc** closes; **click-outside** closes; focus returns to the trigger.
- **Submenus** (Theme, Language, Move to Status, Dev Server, Pane, Layout, Window, Session, Copy Mode,
  Keyboard Mode, Debug): open as a flyout on hover/click of the parent row.
- **a11y (v1 MUST):** `role="menubar"` on the strip; top-level `role="menuitem"` +
  `aria-haspopup="menu"` + `aria-expanded`; dropdown `role="menu"`; items `role="menuitem"` +
  `aria-disabled` on disabled. Accessible names from the label text.
- **a11y (SHOULD, fast-follow if it balloons v1):** full arrow-key navigation (←/→ between menus,
  ↑/↓ within, →/← into/out of submenus, Enter to activate). v1 ships pointer + hover-switch + Esc;
  arrow-key nav is the documented follow-up.
- **Accelerators are display-only.** The real shortcuts are owned by `App.tsx` `useGlobalShortcut`;
  the menu only *hints* them. No keymap.ts change (no new shortcut is introduced).
- **States:** no loading/empty/error — the menu is static structure + synchronous context. Actions
  that need task/project context but are invoked out of context are already disabled by
  `meetsContext`, so the "no-op when out of view" path can't be hit from the bar.

## Responsive

- **Wide (laptop browser — primary remote case):** full horizontal menu bar.
- **Narrow (phone/tablet remote):** collapse the top-level items behind a single **`≡` button**
  whose dropdown lists the top-level menus, each expanding to its items. Reuse the same dropdown
  primitives. This is the one place `≡` is correct (space-constrained), not the default.

## Complexity budget (new surface)

| Surface | Budget | Overflow rule |
|---|---:|---|
| App menu bar (browser only) | ≤ 7 top-level menus | group under an existing top-level before adding a 7th |
| — dropdown length | unbounded | it **is** the overflow/expert surface; long lists are by design |

## Files likely to change

- **Move:** `src/bun/application-menu.ts` → `src/shared/application-menu.ts` (pure; type-only
  electrobun import survives the move). Update imports in `src/bun/index.ts`,
  `src/bun/rpc-handlers/app-handlers.ts`, and `src/bun/__tests__/application-menu.test.ts`.
- **New:** `src/mainview/components/AppMenuBar.tsx` (+ `__tests__/AppMenuBar.test.tsx`).
- **Edit:** `src/mainview/App.tsx` — render `{!isElectrobun && <AppMenuBar … />}` above
  `<GlobalHeader>`; pass `MenuContext` (reuse the existing `hasTask/hasProject/hasTerminal` computation)
  and a dispatch that calls `handleMenuAction`.
- **Docs:** `UX_DECISIONS.md`, `ux-architecture.yaml` (new `app_menu_bar` surface + budget), this plan.
- **Product:** one "Did you know?" tip (`tips.ts` + en/ru/es), changelog entry.

## What NOT to implement

- Do **not** show the bar in Electrobun (native menu owns it there).
- Do **not** add a header/toolbar button to open it (it is always-visible chrome in browser).
- Do **not** re-implement enable/disable or roadmap logic — inherit from `buildApplicationMenu`.
- Do **not** translate the labels (parity with the English native menu).
- Do **not** wire `role`-based clipboard/window/quit items — the browser owns them.
- Do **not** add new keyboard shortcuts or keymap.ts entries.
