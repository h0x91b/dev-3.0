# The "Open in…" rows as an internal `openInTargets` slot, opened only by app id

## Context

Phase 4 of the GUI move to Cordis plugins (coordinator task seq:2526, inventory item 2.4) moves the editors and
apps a path can open in onto a contribution slot. They are used by the ⌘O launcher (`OpenInPickerModal`) and the
`OpenInMenu` / `OpenInAppList` rows (the header Open-in control, card and task menus, file rows). The bun-side
`openInApp` took an app *name* and ran `open -a <name> <path>` for anything without a "/". So any renderer code
could launch any installed app by name. A plugin slot must not hand that power to plugins.

## Investigation

- No "last used" or default target exists: the rows are `getAvailableApps()` in order (`DEFAULT_EXTERNAL_APPS`,
  then `settings.externalApps`).
- Availability is detected on the bun side only (`open -Ra`, macOS; Finder and Terminal are always listed).
- The renderer is the only caller of `openInApp`. There is no CLI, remote-only or agent-facing path.

## Decision

- **Security narrowing:** `openInApp` now takes `{ appId, path }`.
  - Bun resolves `appId` against `DEFAULT_EXTERNAL_APPS` + `settings.externalApps` and throws "Unknown app"
    before any spawn otherwise. Before: any renderer code could launch any installed app by name. After: only a
    known id (see Risks: the settings write path can still add one).
  - The Finder and Zed special cases and the macOS-only `open` behaviour are unchanged; they now key on the
    resolved app's name.
- **The slot holds data only.** `OpenInTarget` (`src/mainview/open-in-targets/registry.ts`) is
  `{ id, appId, icon?, brandColor?, category? }`, with no callback. The host's `openInRow` is the only opener.
- **Rows** (`placeOpenInRows` in `open-in-targets/rows.ts`):
  - They follow bun's detection order.
  - A default app shows while a target draws it. A user-added app falls back to a plain row, as before.
  - A target for an app bun did not detect draws nothing.
  - A malformed target is ignored and logged once.
- **Built-ins** (`open-in-targets/builtins.ts`) carry the glyphs, brand colours and categories that were in
  `components/openInAppIcons.ts`, which is deleted. A JSON fixture generated from main's module pins them.

## Risks

- **Residual route: the settings write path.** `saveGlobalSettings` (`rpc-handlers/settings-config.ts`) accepts
  `externalApps` from the renderer without validation. Any renderer code that can call RPCs can therefore add
  `{ id, macAppName: "<any app>" }` and then open it by that id: two calls instead of one. The narrowing still
  removes one-call launches, launches by name or path, and any power from slot targets. Closing this route is an
  opening-track precondition (`docs/extensions-platform.md`): extensions must not reach `saveGlobalSettings` or raw
  `api.request` (they share the renderer's JS realm today), or bun must validate `externalApps` writes.

- A default app whose built-in target is unloaded loses its row. That is the slot's dispose semantics, and the
  built-in plugin is required.
- Any future caller of `openInApp` must pass an id. A name no longer works, by design.

## Alternatives considered

- Decoration only (no target concept): rejected. Same effort, less useful.
- A renderer-side allowlist with the RPC unchanged: rejected. Any renderer code could still call the RPC with a
  name, so "known id only" would be a convention, not a boundary.
- Renderer-only actions (copy path, deep link) as targets: out of scope.
