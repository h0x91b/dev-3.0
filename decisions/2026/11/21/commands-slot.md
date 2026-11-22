# Command palette on an internal `commands` slot

## Context
Plan item 4.1 (`decisions/2026/11/21/gui-plugin-slots-and-api-versioning.md`): the ⇧⌘P palette listed a static
`ALL_COMMANDS` array (`commands.ts`) of action-id strings, and running one went through `handleMenuAction` in
`menuRouter.ts`, so every command needed two edits that had to agree. Internal first: built-ins only, no manifest
kind, no public service, no API version bump.

## Decision
- `src/mainview/commands/registry.ts`: `CommandsRegistry`, a contribute-kind `SlotRegistry` of `CommandItem`
  (`labelKey`, `category`, `scope`, optional `when(ctx)`, and its own `run(actionCtx)`). With no manifest kind for
  it, the runtime guard unloads any extension that registers a command.
- `commands/builtins.ts` registers the 44 built-in commands, in the old order, as one required built-in plugin
  started in `main.tsx`. `commands.ts` is deleted. The id-specific filters moved onto their items as `when`
  (stats and agent-traffic gates, remote Finder, virtual run-script / project terminal); the category rules for
  virtual and gitless projects stay generic in `commands/available.ts`, which also inserts one command per offered
  board view right after `builtin:view-board`.
- The bodies the palette and the native menu share moved from `menuRouter.ts` into `src/mainview/app-actions.ts`.
  `menuRouter` keeps only native-menu dispatch (menu clicks, swipe navigation, the browser menu bar); palette-only
  actions (`toggle-streamer-mode`, `find-coordinator`) left it and `BROWSER_HANDLED_ACTIONS`. `keymap.ts` and
  `application-menu.ts` are unchanged.
- Parity is pinned by `commands/__tests__/palette-parity.test.ts`, whose snapshot was recorded from the old static
  list over every context-flag combination, and `run.test.ts`, which checks each command's effect against what its
  router case did.

## Risks
- `run()` receives `AppActionContext` (full `AppState`, `dispatch`): built-ins on internals, the same recorded
  tech debt as the settings slot. It must not become the public contract when the slot opens.
- A throwing `run()` is logged by `App.runCommand`; a throwing `when()` drops only its command. Neither reports into
  an extension's failure state yet — the same opening-track precondition as render crashes.

## Alternatives considered
- `run: (ctx) => handleMenuAction("<id>", ctx)` — keeps the string routing the item exists to remove.
- Native menu dispatch through the registry — would let a palette contribution change what a menu item does.
