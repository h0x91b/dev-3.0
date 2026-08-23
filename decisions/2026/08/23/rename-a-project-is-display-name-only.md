# Renaming a project changes the display name only

## Context

A project's name was fixed at creation (folder basename, or the repo name for a
clone) with no way to change it — the top user-visible gap Amit Cohen reported.
The obvious implementation is dangerous: `~/.dev3.0/data/<slug>/` and
`~/.dev3.0/worktrees/<slug>/` are derived from the project's **path**, and that
mapping is frozen by the on-disk invariants in `AGENTS.md`.

## Investigation

Every on-disk key comes from the path, not the name (`projectSlug` →
`projectStorageKey`); tmux session names are id-based. The only name-derived
path is a *virtual* board's synthetic `${OPS_DIR}/<slug>`, and it is computed
once at creation. So a rename is safe precisely as long as it never touches
`path`. The other loose end was the built-in Operations board: its name is
rendered from the localized `ops.boardName` key at seven display sites, and a
stale doc comment claimed a rename "clears the `builtin` flag for naming
purposes" — nothing ever implemented that.

## Decision

`name` joins `ProjectSettingsUpdate` and `data.ts`'s `ProjectUpdates`; `path`
deliberately stays out of both. `updateProjectSettings`
(`src/bun/rpc-handlers/settings-config.ts`) validates through the shared
`normalizeProjectName` and throws on blank/over-long input, so a rename can
never empty a board label. The UI is a single field at the top of the Board tab
(`ProjectNameField` in `ProjectSettings.tsx`), committing on blur/Enter like the
label rows, with the project path printed underneath so it is visible that
nothing on disk moves.

For the Operations board, `builtin` is **kept** rather than cleared:
`projectDisplayName(project, t("ops.boardName"))` renders the localized chrome
only while the board still carries `BUILTIN_OPS_BOARD_NAME` ("Operations"), and
the user's own name otherwise. The board therefore keeps its pin, its ⌘0
shortcut and its SYSTEM badge after a rename.

## Risks

A user who renames the Operations board back to the literal string
"Operations" gets the localized `[ Operations ]` chrome again — harmless, and
the alternative (a new persisted "name was overridden" flag) adds an on-disk
field for a cosmetic edge case. Nothing distinguishes two projects with the same
name in a picker; the path line in settings is the disambiguator.

## Alternatives considered

- **A dedicated `renameProject` RPC**, matching `renameTask` / `renameSpace`.
  Rejected: the Board tab already saves `sensitive` through
  `updateProjectSettings`, which pushes `projectUpdated` for free.
- **Clearing `builtin` on rename**, as the old comment described. Rejected: the
  flag also drives pin-first ordering, ⌘0 and the SYSTEM identity — clearing it
  would silently demote the board as a side effect of a rename.
- **Renaming the folder along with the project.** Rejected outright: it breaks
  the frozen path→slug contract and would strand every task of the project for
  any other installed version of the app.
