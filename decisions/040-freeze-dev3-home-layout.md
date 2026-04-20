# 040 — Freeze the `~/.dev3.0/` on-disk layout

## Context

PR #486 shipped a two-part change: (a) a "safer" `projectSlug` that escaped
literal dashes before replacing slashes, and (b) a one-shot `renameSync` at
app startup that migrated `~/.dev3.0/data/<legacy-slug>` to the new slug so
tasks from v1.8.2 would still be found by v1.8.3.

The migration broke any machine that still had v1.8.2 installed (the
production channel at the time). On first launch of v1.8.3 the `data/`
directory was silently renamed; on the next launch of v1.8.2 the slug was
recomputed with the old algorithm, the pre-rename path was looked up, and
every Kanban column showed empty — same project, same tasks, but invisible.

The same regression also killed CLI worktree auto-detection. `src/cli/context.ts`
computes the slug inline with the pre-escape algorithm and reads
`~/.dev3.0/data/<slug>/tasks.json`. After the rename, that file no longer
existed under the legacy slug, so `resolveFromWorktreePath` returned `null`,
and agent hooks like `dev3 task move --status in-progress --if-status-not review-by-ai`
(which rely on `cwd`-derived `taskId`) started failing with
`Usage: dev3 task move <id> ...`.

## Investigation

The slug collision that PR #486 was guarding against is a theoretical edge
case: two distinct project paths that differ only in the placement of
dashes vs slashes (e.g. `/foo/bar-baz` vs `/foo-bar/baz`). It has never been
reported by a real user. The cost of the "fix" was an immediate, silent,
100% regression for the production channel on every multi-version install.

Reverting the code alone was not enough — users who ran v1.8.3 had their
`data/<slug>` directory already renamed on disk and needed a one-off manual
rename to get back. There is no safe way to automate that undo without
committing the same class of sin.

## Decision

`~/.dev3.0/` is treated as **shared operating-system state** owned jointly
by every installed version of the app. The layout is frozen:

1. `projectSlug` in `src/bun/git.ts` is `path.replace(/^\//, "").replaceAll("/", "-")`.
   It must not change.
2. No automatic renames or moves of anything under `~/.dev3.0/`. In-place
   content rewrites of individual files (e.g. the `say` cleanup-script
   migration in `rawLoadAllProjects`) are still fine — the file *path*
   is what must stay stable.
3. `src/cli/context.ts` inlines the same slug algorithm. These two must
   stay in lockstep; if the slug ever legitimately needs to change, both
   sides are updated together with a compatibility story for at least the
   last two released versions.
4. Any future change that genuinely needs a new on-disk structure is
   written as a **parallel path** (new file / new directory alongside the
   old), with the old location kept readable for N-2 versions. No silent
   in-place rewrites.

These rules are also captured in `AGENTS.md` under "On-disk data layout —
hard invariants (MANDATORY)" so every coding agent reads them before
touching `src/bun/data.ts`, `src/bun/git.ts`, `src/bun/paths.ts`, or
`src/cli/context.ts`.

## Risks

- The original theoretical slug collision remains unfixed. Accepted —
  we have no reports of it. If it ever surfaces, the fix is a new
  parallel layout with an explicit opt-in, not a rename.
- Future agents may still propose a slug change because the reasoning
  "it's cleaner" is tempting. The guardrail in `AGENTS.md` and this
  decision record are the backstop — anyone who wants to change it
  must first justify why the freeze rule does not apply.

## Alternatives considered

- **Symlink-based migration** (legacy dir → new dir). Cleaner than
  `renameSync` but still writes into user state and still creates a
  cross-version dependency on a specific filesystem layout. Rejected.
- **Hash-based slug** that is collision-free by construction. Plausible
  if we ever genuinely need it, but at that point we would do it as a
  parallel layout, not as an in-place swap of the directory name.
- **Silently stop caring about multi-version installs.** Rejected:
  users routinely keep production and `bun run dev` side by side, and
  the stable channel is the one that must never break.
