# Global Settings registry and legacy category links

## 1. Context

Global Settings is changing from one scrolling page into seven categories with localized search and responsive list-to-detail navigation. Existing surfaces already dispatch legacy section ids, and every `GlobalSettings` field must retain its current persistence semantics.

## 2. Investigation

The route is a screen-based `Route` union, not a URL router, and the launch picker still dispatches `proxy` through `OPEN_SETTINGS_SECTION_EVENT`. The existing settings controls contain bespoke CRUD and local-storage behavior, so replacing them with a form renderer would expand scope and risk regressions.

## 3. Decision

Add `src/mainview/settings-registry.ts` as documentation and search metadata: each Settings entry records its id, category, localized title/description keys, optional anchor, and storage disposition. Keep controls in their existing components, normalize legacy ids through `LEGACY_SETTINGS_CATEGORY_MAP`, and use compile-time/runtime integrity tests to require every durable field to be registered or explicitly excluded.

## 4. Risks

Anchors describe a containing surface when multiple entries share one editor, so a search result may land at the editor rather than an individual sub-control. Legacy ids remain part of the accepted route vocabulary until all external callers migrate; removing them early would break deep-links from older surfaces.

## 5. Alternatives considered

A registry that rendered controls was rejected because the Agents and Accounts editors are complex CRUD surfaces whose behavior is already tested and should relocate as-is. Renaming legacy ids was rejected because event callers and persisted/navigation assumptions can outlive the refactor; a single normalization map preserves compatibility while exposing the new category ids.
