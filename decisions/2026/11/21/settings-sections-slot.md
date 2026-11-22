# Global Settings on an internal `settingsSections` slot

## Context
Plan item 2.1 (`decisions/2026/11/21/gui-plugin-slots-and-api-versioning.md`): Global Settings rendered its 11
fixed categories through a hand-written `switch` in `GlobalSettings.tsx`. The user's order is internal first, so
the slot ships with built-ins only: no manifest kind, no public `ctx.*` service, no API version bump.

## Decision
- `src/mainview/settings-sections/registry.ts`: `SettingsSectionsRegistry`, a contribute-kind `SlotRegistry`
  whose `region` is the category. With no manifest kind for it, the runtime guard unloads any extension that
  registers a section (the "undeclared item into any other slot" rule).
- `BUILTIN_SETTINGS_SECTIONS` (`settings-registry.ts`) lists the 19 built-in sections in page order; each
  `SETTINGS_ENTRIES` row names its `section`. `SETTINGS_SECTION_INTEGRITY` fails compilation when a row's category
  differs from its section's, and the old `GlobalSettings` field records are untouched. `builtins.tsx` registers
  every section as one required built-in plugin started in `main.tsx`; a missing component is a type error.
- The sections' shared state and handlers moved, unchanged, into `useGlobalSettingsController()`; the page
  provides it through `SettingsControllerContext` and each built-in adapter passes the same props as before.
  This is the recorded tech debt (built-ins on internals, `docs/extensions-platform.md`).
- `<SettingsCategoryPage>` renders a category's sections itself instead of through `<SlotItems>`: that one is
  a bar (inline vs a "More" menu, a budget), the wrong shape for a page. Each section gets a `SlotErrorBoundary`.
  A crashed **built-in** leaves a visible notice, because a built-in section that silently disappears reads as a
  removed setting; an **extension** section vanishes like any failed contributor. This is the settings-sections
  exception now written into `docs/ux/PRODUCT_UX_BIBLE.md` §5.12 and amended onto
  `decisions/2026/11/21/gui-plugin-slots-and-api-versioning.md`.
- Search filters the entries of the registered sections; the anchor-scroll effect also re-runs when the
  registered set changes.

### Project Settings (plan item 2.4)
- The same slot carries the four fixed tabs as regions `projectSettings.<tab>`
  (`settings-sections/project-builtins.tsx`, one required built-in plugin); the `activeTab === …` body branches are
  gone. The page keeps the tab bar, the tab descriptions and the "not found" state, and renders a region only for
  a tab its bar offers.
- State and handlers moved unchanged into `useProjectSettingsController()` (`project-controller.tsx`).
- The unsaved-changes guard stays with the page (`section-dirty.tsx`): a section calls `useSectionDirty({ dirty,
  saving, blocked, save, discard })` while mounted, and the host drives the banner and `navigationGuardRef` from
  those reports. Only the open tab's body is mounted, so "only the open tab counts" holds as before.

## Risks
Before the slot opens to extensions, a section's render crash must be reported into its extension's failure state,
so the Extensions row shows the reason; today it only vanishes (precondition in `docs/extensions-platform.md`).
Before the slot opens to extensions, the page must place built-ins before extensions by origin (as `<SlotItems>`
does): today numeric `order` alone sorts, so an extension passing `order: -1` would rise above the built-ins.
The controller context re-renders every section on any settings change, as the prop-passing switch did. Built-ins
must be installed before Settings renders: tests that mount `GlobalSettings` call `applyBuiltinPlugins`.

## Alternatives considered
- A hook per section owning its own slice of state: right end state, but it rewrites ~20 components with
  bespoke saving logic in one PR. Deferred with the tech debt.
- Entries declared inside each section registration: loses the typed constant the compile-time records need.
- Rendering through `<SlotItems>`: would put future third-party sections in an overflow menu and hide crashes.
