# 039 — Revert project slug dash-escape

## Context

In v1.8.3 (commit `afe131b6`, PR #486) the `projectSlug` algorithm was changed
to escape literal dashes (`"-"` → `"--"`) before replacing path separators
(`"/"` → `"-"`) so that two distinct paths like `/foo/bar-baz` and
`/foo-bar/baz` could no longer collapse to the same slug. That change was
paired with a one-shot migration that renamed `~/.dev3.0/data/<legacy-slug>`
directories to the new slug at app startup.

## Investigation

The migration broke real users who had both v1.8.2 (installed as production)
and v1.8.3 (dev build) on the same machine. Once v1.8.3 booted it renamed the
`data/<slug>` directory in place; any subsequent launch of v1.8.2 recomputed
the slug with the old algorithm, looked in the old (now-renamed) path and
found nothing — every Kanban column showed empty. The slug collision the
original fix was guarding against is a theoretical edge case (two project
paths that differ only by where dashes vs slashes appear); the regression
was immediate and visible.

## Decision

Revert the slug change and its migration. `projectSlug` goes back to the
plain `path.replace(/^\//, "").replaceAll("/", "-")` form used since v1.0.
Drop `legacyProjectSlug`, `migrateSlugDir`, `migrateProjectSlugDirs` and the
startup call in `rawLoadAllProjects`. Test fixtures that used the escaped
slugs (`tmp-test--project`, `tmp-race--test--project`, `tmp-existing--project`)
are restored to their pre-escape form.

Implementation: see `src/bun/git.ts` (`projectSlug`) and `src/bun/data.ts`
(imports + `rawLoadAllProjects`). The four other fixes bundled into PR #486
(CLI tri-state `--description`, custom column-agent failure push message,
ProjectSettings worktree load race, activateTask description note) are left
untouched — only the slug portion is rolled back.

## Risks

- The original collision remains possible for any user whose project paths
  differ only by dash/slash placement. No known user currently hits this;
  if it comes up we fix it with hash-based or UUID-based slugs rather than
  an in-place directory rename.
- Users who already ran v1.8.3 have their `data/<slug>` directory renamed on
  disk. This revert does not undo that — the directory needs to be renamed
  back manually (or by a one-off script) on any machine that ran v1.8.3.

## Alternatives considered

- **Keep the collision fix but replace rename with a symlink.** Cleaner than
  a rename but adds a permanent symlink to user state; rejected in favour of
  a full revert because the collision is not an actively observed problem.
- **Leave v1.8.3 as-is and tell users to upgrade.** Rejected: v1.8.2 is the
  current production channel and an upgrade is not always immediate.
