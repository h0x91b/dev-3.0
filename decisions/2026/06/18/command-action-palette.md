# 072 — Cmd+Shift+P action palette as a DOM mirror of the native menu

## Context

PR #685 shipped the Cmd+K navigation palette and locked a future direction: a sibling Cmd+Shift+P **action** palette. We needed to add it without (a) building a second command runner, (b) duplicating the palette UI, or (c) letting destructive actions become a fuzzy-Enter away.

## Decision

- Extracted `src/mainview/components/PaletteShell.tsx` (portal, fuzzy input, keyboard nav, highlight, empty state) from `ProjectQuickSwitchModal`. Both palettes now render on it. `ProjectQuickSwitchModal` is a thin wrapper; `CommandPaletteModal` is the new action palette.
- Commands live in `src/mainview/commands.ts`: each entry is `{ id (a handleMenuAction action string), labelKey, category, scope }`. `availableCommands({hasProject, hasTask})` filters by route context.
- Running a command calls the existing renderer router `handleMenuAction(id, ctx)` (see `App.runCommand`). The palette is therefore a **DOM mirror of the native application menu**, not a parallel dispatcher. We extended `menuRouter.ts` with the missing renderer-executable cases (open-settings, open-new-task / open-add-project via CustomEvent, task-toggle-watch, safe task-move-* statuses) — this also fixed those native-menu items, which were previously no-op in the renderer.
- Hotkey `Cmd/Ctrl+Shift+P` (VSCode convention); Cmd+K stays navigation.

## Risks

- `handleMenuAction` no-ops when context is missing; the palette mitigates by only listing context-applicable commands, but a command could still no-op if context changes between open and Enter (low impact).
- Adding a command requires two edits (registry entry + handleMenuAction case) — intentional, keeps the registry honest (no broken/no-op entries).

## Alternatives considered

- **One palette with modes/sections** (prefix `>` for commands like VSCode): rejected for now — two chords map to two intents more predictably; revisit if it gets crowded.
- **Separate CommandPaletteModal with its own overlay/keyboard code**: rejected — would duplicate the just-merged palette UI. Shared `PaletteShell` instead.
- **Full menu mirror including destructive + modal flows**: rejected by UX canon — destructive (delete/cancel/complete) needs friction, and modal/inline flows (rename, overview, note, spawn, duplicate) belong to their own surfaces. Excluded deliberately, documented in `docs/ux/UX_DECISIONS.md` (2026-06-18).
