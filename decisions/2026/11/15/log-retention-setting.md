# Log retention is one global setting

## Context

The agent message log and the notification log both deleted day-files older than a fixed 30 days. Users who read the traffic history asked for longer, and some for never deleting it.

## Decision

`logRetentionDays` in `settings.json` covers both logs: a positive number of days or `"forever"`; absent means 30 (the default, never stored). The Settings select offers 30, 90, 180, 365 and forever, and shows any other stored day count as an extra option (`src/shared/log-retention.ts`, sanitized in `src/bun/settings.ts`).

The daily prune of both writers reads the field through `readLogRetentionForPrune`, straight from the raw file. Unreadable settings, or a field that is neither a positive integer nor `"forever"`, skip the prune and do not mark the day as pruned, so the next append retries; the skip is logged once per day. Falling back to 30 there would delete history the user chose to keep. `null` retention deletes nothing.

The field is host-owned, like `autoAccountDefault`: `saveGlobalSettings` always keeps the stored value, because the renderer saves a whole snapshot that may be stale. The only writer is the `setLogRetention` RPC, which saves, prunes every project's message log and the notification log at once when the effective retention got shorter, and pushes `globalSettingsUpdated`. Before lowering, the Settings entry asks the host what would go (`getLogRetentionUsage({ retentionDays })` returns `beyond`, by the host's clock; file sizes only, no file contents are read) and confirms with the user. File layout and names on disk are unchanged.

## Risks

An older co-installed build rewrites `settings.json` from its own key whitelist and drops the field on its next save; its own prune stays at 30 days. Sandro accepted this. `setLogRetention` loads settings the usual way, so if `settings.json` is corrupt it is written back as defaults.

## Alternatives considered

A separate value per log, or per project: more controls for a choice made once. Storing a closed set of values: it could not represent a count a user edited by hand without turning it into the default.
