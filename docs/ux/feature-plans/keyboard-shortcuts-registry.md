# Feature plan — Keyboard-shortcut registry + reference overlay

Status: Planned (design locked via interview 2026-06-19; not yet implemented)
Owner: Product UX Architecture
Related: UX_DECISIONS 2026-06-19, command_palette / task_switcher surfaces, TmuxCheatSheetModal.

## 1. Problem

Keyboard shortcuts are the app's primary interaction model, but their definitions are
**scattered with no single source of truth**:

- `src/bun/application-menu.ts` — native macOS menu accelerators (single-char + Cmd).
- `src/mainview/App.tsx` — a large `useGlobalShortcut` if-else chain: palettes (⌘K / ⇧⌘P),
  zoom (⌘= / ⌘- / ⌘0), project switch (⌘1..9 / ⇧⌘1..9), terminal toggles (⌘` / ⇧⌘`),
  route nav (⌘[ / ⌘]), Escape, quit/hide/new-window.
- `src/mainview/hooks/useTaskSwitcher.ts` — Option+Tab / Ctrl+Tab hold-cycle.
- `src/mainview/terminal-keymaps.ts`, `shift-key-sequences.ts`, `src/bun/tmux-config.ts` — terminal/tmux.
- `src/mainview/commands.ts` — palette command registry, but labels only, **no key bindings**.

Consequences: no way for a user to discover the full keymap; no canonical list for README /
website; easy for new shortcuts to be added without being documented anywhere. There is already
a **dead** Help → "Keyboard Shortcuts" menu item (`MENU_ACTIONS.helpKeyboardShortcuts`) with no
router case — a hook waiting to be wired.

## 2. User job

"Show me every keyboard shortcut the app has, grouped and readable, without leaving the app —
and let the README / website carry the same list for people evaluating the tool."

## 3. Feature classification

- **Class:** `onboarding/help` reference overlay + `expert_shortcut` entry. Same family as the
  existing Tmux cheat sheet.
- **Scope:** global (app-wide).
- **Frequency:** occasional (discovery / reminder), not a daily operational action.
- **Risk:** safe, read-only.

## 4. Placement decision

### In-app: ONE modal with two tabs (chosen)

A single full-screen **Modal** surface `KeyboardShortcutsModal`, mirroring `TmuxCheatSheetModal`'s
visual shell, with two tabs:

- **App** — renders the app-level keymap from the new registry (`keymap.ts`), grouped by category.
- **Terminal (tmux)** — the existing tmux cheat-sheet content (⌃B … prefix bindings).

The Tmux cheat sheet folds into this modal as the Terminal tab (the standalone
`TmuxCheatSheetModal` content/data is reused). "Единый вид" = one component, one look, one entry
flow; the tab split keeps the ~40 prefix-keyed terminal bindings from drowning the ~25 app
shortcuts in a single flat list.

- **Rejected — separate route/page:** would add a navigation destination for ephemeral reference
  content (violates "navigation = destinations, not help/commands" and the ≤7 nav budget). The
  "page" form of this content is the **website**, not an in-app screen.
- **Rejected — two separate sibling modals:** the user explicitly wants one unified surface.

### Entry points (no new toolbar/DOM button — avoids the #1 anti-pattern, toolbar-button-creep)

1. **Native Help menu → "Keyboard Shortcuts"** — the canonical home. The item already exists; wire
   the dead `help-keyboard-shortcuts` action through `menuRouter` to open the modal (App tab).
   Help → "Tmux Cheat Sheet" opens the same modal on the Terminal tab. Show the chord in the label:
   `Keyboard Shortcuts (⌘/)`.
2. **Keyboard shortcut `⌘/` (Ctrl+/ on Linux)** — owned by the `App.tsx` keydown handler (capture
   phase, like the palettes), toggles the modal. `⌘/` is free, single-chord, and safe under a
   focused terminal (Cmd is intercepted at capture). Bare `?` (GitHub/Linear convention) is rejected:
   the live terminal must receive a bare `?`.
3. **Command palette (⇧⌘P)** — add a `help-keyboard-shortcuts` command to `commands.ts` (category
   `app`/help, scope `always`), consistent with the tmux cheat sheet already being palette-reachable.

## 5. Source of truth: registry = documentation + test (chosen)

New module `src/mainview/keymap.ts` declares every **app-level** shortcut as data:

```ts
interface ShortcutSpec {
  id: string;                 // stable id
  keys: { mac: string; other: string };  // e.g. { mac: "⌘K", other: "Ctrl+K" }
  descKey: TranslationKey;    // i18n description
  category: ShortcutCategory; // nav | projects | view | palettes | terminal-toggle | window | global
}
```

- The modal's App tab, the README table, and the website section all render from this one array.
- App.tsx handlers stay as they are (the giant if-else is **not** refactored — chosen to avoid a
  risky rewrite of central, edge-case-heavy code: capture phase, terminal focus, zoom, e.code vs e.key).
- A **vitest test** guards drift: assert every spec has a description key + valid category + unique
  id + non-empty platform strings; and a coverage check that flags shortcuts handled in App.tsx but
  missing from the registry (best-effort string scan) so new bindings can't silently go undocumented.
- The Terminal tab keeps sourcing from the tmux cheat-sheet data (extract its inline `sections`
  array to a small data module if convenient; not required for v1).

## 6. Docs / website / README integration

- **CLAUDE.md (AGENTS.md):** add a short "Keyboard shortcuts" reference rule — "every app-level
  shortcut must be registered in `src/mainview/keymap.ts` (the single source of truth); the Help →
  Keyboard Shortcuts overlay, README, and website all render from it." Same shape as the existing
  tips / changelog / decision-record rules.
- **README:** a "Keyboard shortcuts" section with the table + a link to the website / in-app overlay.
  Keep it generated from `keymap.ts` (small `scripts/gen-keymap-docs.*`) or hand-synced under the
  CLAUDE.md rule — implementation choice, generator preferred for true single-source.
- **Website (`docs/index.html`, GitHub Pages):** a "Keyboard shortcuts" section rendering the same
  data (this is the legitimate standalone "page" form the user floated).

## 7. Interaction, states, a11y, copy

- **Trigger:** Help menu / ⌘/ / palette → open modal (App tab default; Terminal tab when opened via
  the Tmux Cheat Sheet entry).
- **Within modal:** tab switch via click and ←/→; rows are `<kbd>` chip + description, 2-col grid,
  grouped by category (reuse TmuxCheatSheetModal layout + tokens exactly).
- **Keyboard:** Esc closes; focus trapped; focus restored to the prior element on close.
- **States:** static content (no loading/empty/error). Platform-aware key rendering (⌘ on macOS,
  Ctrl on Linux) via a small formatter, **not** i18n. No search box in v1 (grouped content fits,
  matches the tmux cheat sheet); optional filter later if the list grows.
- **a11y:** `role="dialog"`, `aria-modal`, `aria-label` (i18n), `<kbd>` semantics, close button
  `aria-label`, tabs as a labelled tablist.
- **Tokens:** identical to `TmuxCheatSheetModal` — `bg-overlay`, `border-edge-active`,
  kbd = `bg-elevated border-edge text-fg-2`, headings `text-fg-2`. **No new tokens.**
- **i18n:** all descriptions + tab labels + title via `t()` in en/ru/es. Key symbols are not translated.

## 8. Complexity-budget check

- No new nav destination (modal, not a route) → global-nav budget (≤7) untouched.
- No new toolbar/DOM button → no toolbar-button-creep, no per-surface action budget consumed.
- Help menu already lists the item → no menu growth.

## 9. What NOT to implement

- No new top-level screen/route for shortcuts.
- No toolbar / breadcrumb / header button to open it (keyboard + menu + palette only).
- No refactor of the `App.tsx` shortcut dispatch (registry documents, does not drive — chosen).
- No bare `?` global shortcut (terminal conflict).
- No search box in v1.

## 10. Likely files to change (implementation phase)

- New: `src/mainview/keymap.ts`, `src/mainview/components/KeyboardShortcutsModal.tsx`,
  `keymap.test.ts`, modal test.
- Edit: `src/mainview/App.tsx` (⌘/ handler + modal mount + Terminal-tab routing of the cheat-sheet
  listener), `src/mainview/menuRouter.ts` (`help-keyboard-shortcuts` case), `src/mainview/commands.ts`
  (palette entry), `application-menu.ts` (label `(⌘/)`), TmuxCheatSheetModal (fold into the new modal
  as the Terminal tab), i18n en/ru/es, `tips.ts` (the `keyboard-shortcuts` tip already exists),
  `AGENTS.md`/`CLAUDE.md`, `README`, `docs/index.html`, optional `scripts/gen-keymap-docs`.
