# Compress old day logs into a verified .tgz beside the original

## Context
`~/.dev3.0/logs/YYYY/MM/YYYY-MM-DD.log` reached 35–90 MB a day (675 MB on disk for the 14-day retention window). Nothing in the app reads old day files; humans and agents grep them after the fact.

## Decision
`src/bun/log-archive.ts` (`archiveOldLogs`, `archiveLogFile`) packs every day file at least three days old into `YYYY-MM-DD.log.tgz` in the same directory: one ustar entry named like the file, written by a hand-built 512-byte header streamed through `node:zlib` gzip, so no external `tar` binary and identical behaviour on macOS, Linux and Windows. The archive is written to `<name>.tgz.<pid>.tmp`, read back (gunzip + header parse + SHA-256 of the entry), renamed into place, read back again, and only then is the plain file unlinked. An existing archive that matches is reused; one that does not is rewritten. `log-archive-scheduler.ts` runs it five minutes after boot and once a day as a clock job, so only the process that owns the schedulers does it. `pruneLogFiles` now ages out `.log.tgz` on the same 14-day window.

## Risks
Older installed versions only know `.log`: their prune skips `.tgz`, so archives can outlive 14 days until a new version runs — harmless. The tmp→final rename touches only a file this run just created, never existing user state. A process still appending to a 3-day-old file (clock skew) makes the size/mtime check fail and the plain file stays.

## Alternatives considered
`.log.gz` (simpler, `zgrep` reads it directly) — rejected to match the requested `.tgz` and Finder/Windows double-click extraction. Spawning system `tar` — not guaranteed on older Windows and adds a process per file. Shorter retention instead of compression — loses the diagnostic history bug reports rely on.
