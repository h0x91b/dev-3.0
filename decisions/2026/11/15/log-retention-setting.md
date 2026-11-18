# Log retention is one global setting

## Context

The agent message log and the notification log both deleted day-files older than a fixed 30 days. Users who read the traffic history asked for longer, and some for never deleting it.

## Decision

`logRetentionDays` in `settings.json` covers both logs: a positive number of days or `"forever"`; absent means 30 (the default, never stored). The Settings select offers 30, 90, 180, 365 and forever, and shows any other stored day count as an extra option (`src/shared/log-retention.ts`, sanitized in `src/bun/settings.ts`).

The daily prune of both writers reads the field through `readLogRetentionForPrune`, straight from the raw file. Unreadable settings, or a field that is neither a positive integer nor `"forever"`, skip the prune for that whole day (the day is marked as checked, so the file is not re-read and parsed on every append), and the next day retries; the skip is logged once per day. Falling back to 30 there would delete history the user chose to keep. `null` retention deletes nothing.

The field is host-owned: inside the settings file lock, `saveSettings` writes back whatever `settings.json` holds for `logRetentionDays`, verbatim (an unknown value such as `"90"` included), and ignores the field in the object it is given. Every ordinary writer is covered, including ones that load a snapshot outside any queue. The only way to change it is `saveSettings(settings, { value, expectedCurrent })`, used by the `setLogRetention` RPC: under the lock it compares the stored value (absent = 30; an unreadable file counts as a mismatch, while an unknown value matches any `expectedCurrent`, so an explicit choice replaces it) with `expectedCurrent`, and on a mismatch throws `LogRetentionChangedError` and writes nothing. On a match it saves, prunes every project's message log and the notification log at once when the retention got shorter than `expectedCurrent`, and pushes `globalSettingsUpdated`. The Settings select stays disabled and empty until the host settings arrive, sends the value it showed as `expectedCurrent`, and on the stale rejection re-reads the settings and shows a toast. Before lowering, the Settings entry asks the host what would go (`getLogRetentionUsage({ retentionDays })` returns `beyond`, by the host's clock; file sizes only, no file contents are read) and confirms with the user. File layout and names on disk are unchanged.

## Risks

An older co-installed build rewrites `settings.json` without `logRetentionDays`. The new build then reads the default 30 and its next prune permanently deletes every day older than 30, even when the user chose a longer period or "forever". This was accepted on purpose: the owner of the change runs side-by-side builds and takes the risk, and a sidecar file (like the Auto exclusions one) was rejected to keep one settings store. `setLogRetention` loads settings the usual way, so if `settings.json` is corrupt it is written back as defaults.

## Alternatives considered

A separate value per log, or per project: more controls for a choice made once. Storing a closed set of values: it could not represent a count a user edited by hand without turning it into the default.
