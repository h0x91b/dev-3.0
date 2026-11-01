# Never save global settings from the renderer's pre-load placeholder

## Context
`saveGlobalSettings` takes the whole settings object. App, the Settings screen and `global-settings-cache` all started from a hardcoded placeholder (`defaultConfigId: "claude-auto"`). When the startup `getGlobalSettings` read was lost, the placeholder stayed for the whole session, and the first help-mode open (`markHelpDiscovered`) saved it: settings.json was wiped to four keys, and the load-time `DEPRECATED_DEFAULT_CONFIG_REMAP` turned `"claude-auto"` into `claude-auto-fable5-xhigh`. An affected user's log showed exactly `→ saveGlobalSettings {defaultConfigId:"claude-auto", …, helpModeDiscovered:true}`.

## Decision
- A renderer save is only ever built from the host's settings. App (`persistAppSettings`), `GlobalSettings.tsx` (`whenHostSettingsLoaded`) and `patchGlobalSettings` re-read `getGlobalSettings` when their load never landed, and App syncs the cache only after a load or a push.
- One default: `DEFAULT_CLAUDE_CONFIG_ID` (Opus 5.5 Medium) feeds `DEFAULT_AGENTS`, the host `DEFAULT_SETTINGS` and the renderer `DEFAULT_GLOBAL_SETTINGS`, which App and KanbanBoard now share. A test fails if the placeholder is ever a remapped id.
- The retired `claude-auto` / `claude-bypass` now remap to Opus 5.5 Medium (Auto / Bypass), since a stray copy on disk most likely came from the placeholder, not from a Fable choice.

## Risks
Users already remapped to Fable 5 X-High stay there: the fix rewrites nothing on disk, and their wiped settings can only come back from `~/.dev3.0/settings-backups/` (72 h) or `settings-last-known-good.json`. Someone who really did pick the old plain Fable 5 Auto and has not launched since v1.62 lands on Opus 5.5 Medium.

## Alternatives considered
A server-side patch merge (`{...stored, ...params}`) would also have stopped the wipe, but omitting a key is how the renderer clears an optional setting today, so merging would make those settings impossible to clear. Blocking saves outright until load would silently drop the user's action; re-reading and then saving keeps it.
