# Gzip task diff snapshots as a parallel `.patch.gz` file

## Context
Every branch-status refresh saves `git diff <base>...HEAD` into `~/.dev3.0/worktrees/<slug>/<shortId>/diffs/<ts>.patch` (up to 50 per task, ≤ 1 MB each) as a disaster-recovery copy. On the maintainer's machine a single base44 task kept 25 MB of them. `~/.dev3.0` is shared by every installed version of the app, so the format change must not break an older one.

## Investigation
Nothing in the app reads these files back: Show Diff, review and history all run live `git`. The only reader is `saveDiffSnapshot` itself, which compares the newest snapshot with the new diff to skip duplicates and prunes beyond 50. Measured on byte-exact copies of the real snapshots (1337 files, 415 task dirs): 172.8 MB → 47.0 MB with gzip -9 per file (27%); the biggest task 25.2 MB → 7.0 MB.

## Decision
`src/bun/diff-snapshots.ts` owns the format. New snapshots are written as `<ts>.patch.gz` (`writeDiffSnapshot`); listing, dedupe and the 50-file prune cover both extensions, ordered by timestamp stem (`listDiffSnapshots`, `readDiffSnapshot`). Existing plain files are compressed only by an explicit action, never at load: `dev3 doctor --worktrees --gzip-diffs` (CLI, `src/cli/commands/doctor.ts`) and the daily metadata cleanup job, both through `compressAllDiffSnapshots(worktreesRoot)`. Each `.patch` becomes a `.patch.gz` with the same stem and mtime, and the plain file is deleted only after the gzip copy decompresses to identical bytes. Plain files modified in the last 60 s are left alone (an older version may still be writing them).

What an older (N-1, N-2, any pre-gzip) version sees in a task touched by the new one: its `readdirSync(...).filter(f => f.endsWith(".patch"))` does not match `.patch.gz`, so the compressed snapshots are invisible to it. Its dedupe then compares against the newest *plain* file, or finds none, and at worst writes one extra plain `.patch`; its prune counts only plain files, so it never deletes a `.patch.gz`. It cannot crash and shows nothing different, because no UI displays snapshots. A plain file it writes is gzipped by the next doctor/daily run. Nothing is renamed or moved; the originals are not kept, because no reader of them exists in any version.

## Risks
A human recovering work by hand now needs `gunzip -c` / `zcat` instead of `cat`. The mixed directory may briefly hold more than 50 files when an old version keeps writing plain ones; the next new-version save prunes both kinds.

## Alternatives considered
Rewriting existing files at app startup — rejected, a destructive migration at load time. Keeping the originals next to the `.gz` — doubles the data, and nothing reads them. Cross-snapshot compression (one archive or delta chain per task) shrinks the biggest task to ~0.17 MB (`xz` of all 50 snapshots concatenated) instead of 7 MB, because consecutive snapshots are near-identical — far better, but a new container format with its own compatibility story; left as a possible follow-up.
