# Artifacts default to light, independently of dev3's theme

## Context

The artifact viewer initialized `themeMode` from dev3's current theme (`currentTheme()`), and the report shell's CSS `:root` tokens were dark. dev3 itself defaults to dark, so every `show-artifact` opened a dark document. Reports are read as paper, not as dev3 chrome; users who keep dev3 dark still wanted light pages.

## Decision

`TaskArtifactViewer` starts in `"light"` rather than `currentTheme()`. The toolbar cycle is unchanged: Light, Follow dev3, Dark. The template, the injected free-form theme contract (`injectArtifactThemeContract`), markdown artifacts, and the first-task docs shell all use light `:root` tokens, with dark behind `[data-theme="dark"]`. Unthemed JS fallbacks set `data-theme=light` instead of following `prefers-color-scheme`, so a dark dev3 webview does not flash dark before the viewer posts the theme.

## Risks

A dev3-dark user who preferred artifacts to match the app now clicks once ("Follow dev3") per open; the choice is not persisted. Standalone "Open in browser" on a dark OS also starts light until they toggle.

## Alternatives considered

- **Keep matching dev3, add a setting** — extra chrome for a default the ask already named.
- **Default to `"follow"`** — still opens dark for dev3-dark users, which is the complaint.
- **Follow `prefers-color-scheme` in the iframe** — dev3's dark webview reports dark, so first paint stays dark.
