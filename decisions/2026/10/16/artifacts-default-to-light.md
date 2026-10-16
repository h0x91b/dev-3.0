# Artifacts default to light, and remember an explicit theme choice

## Context

The artifact viewer initialized `themeMode` from dev3's current theme (`currentTheme()`), and the report shell's CSS `:root` tokens were dark. dev3 itself defaults to dark, so every `show-artifact` opened a dark document. Reports are read as paper; users who keep dev3 dark still wanted light pages — but a hard-coded light on every open would throw away a user who deliberately picked Dark or Follow dev3.

## Decision

`src/mainview/artifact-theme-prefs.ts` holds one app-wide `ArtifactThemeMode` (`light` / `follow` / `dark`) in `localStorage("dev3-artifact-theme")`, shared by every `TaskArtifactViewer` through `useSyncExternalStore`. No stored value (or an unrecognised one) reads as `light` and is never written back: only an explicit toolbar pick writes, so a saved choice is never reset. Follow dev3 keeps the existing `MutationObserver` on `<html data-theme>` and re-posts the theme to the frame. The template, the injected free-form theme contract (`injectArtifactThemeContract`), markdown artifacts and the first-task docs shell all use light `:root` tokens, with dark behind `[data-theme="dark"]`, and their unthemed JS fallbacks set `light`. `composeArtifactDocument` stamps the resolved theme on `<html>` before the iframe paints, so reports saved under the old dark `:root` default do not flash dark until `onLoad` posts the theme.

## Risks

`localStorage` is per origin: the desktop webview keeps it across restarts (as it does `dev3-theme`), but each remote browser keeps its own choice. Standalone "Open in browser" / ZIP copies of a report published before this change keep that file's baked default until republished.

## Alternatives considered

- **Always open light, no memory** — the first version of this change; rejected in review because it resets a deliberate Dark or Follow dev3 pick on every open.
- **Persist in host settings (`settings.json`) via RPC** — would share the choice with remote browsers, at the cost of a new RPC field and an async first paint; not worth it for a viewer preference.
- **Default to `"follow"`** — still opens dark for dev3-dark users, which is the complaint.
