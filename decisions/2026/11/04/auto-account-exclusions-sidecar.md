# App-wide Auto exclusions live in a sidecar next to settings.json

## Context
#2165 stored the app-wide "keep this login out of Auto" list as `autoAccountExclusions` in `settings.json`. Every released build loads that file through a key whitelist (`normalizeSettings`) and writes the whitelisted object back on its next save, so one start of an older build sharing `~/.dev3.0` erased the list and silently re-admitted a personal account. The on-disk invariants in AGENTS.md require N-2 readability, and the older builds cannot be changed.

## Decision
`saveSettings` also writes `~/.dev3.0/auto-account-exclusions.json` (`{ "version": 1, "keys": [...] }`, temp file + rename, written even when empty) and keeps the `settings.json` copy for builds that read it but predate the sidecar. `loadSettings` / `loadSettingsSync` prefer the sidecar (`withAutoExclusionsSidecar` in `src/bun/settings.ts`); a missing, unreadable or unknown-version sidecar falls back to the `settings.json` copy. Callers keep using `GlobalSettings.autoAccountExclusions` unchanged. Same pattern as `terminal-backend.json` (`decisions/2026/08/01/native-terminal-rollout-controls.md`).

## Risks
Two copies can disagree; the sidecar always wins, so an edit made by a build that only knows `settings.json` (none shipped) would be ignored. A save from a placeholder settings object would clear both copies, exactly as it would have cleared the single one.

## Alternatives considered
Make `saveSettings` preserve keys it does not know: protects future fields from future-minus-one builds, but cannot help against builds already shipped, which is the actual failure. Moving the list into `projects.json` or the accounts registry: other whitelisted files with the same problem, and a less obvious home.
