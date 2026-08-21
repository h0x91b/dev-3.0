# Spaces group projects without replacing project boards

## Context

[Issue #1295](https://github.com/h0x91b/dev-3.0/issues/1295) (proposed by @arditti) asks for
**Spaces**: a way to group projects once the project list stops being scannable.

An earlier record on this branch took the design the other way: a project that joined a space
lost its own board, and the merged space board became the working level. @arditti pushed back on
exactly that ([comment 5256453622](https://github.com/h0x91b/dev-3.0/issues/1295#issuecomment-5256453622)),
then narrowed his own proposal further
([comment 5260039214](https://github.com/h0x91b/dev-3.0/issues/1295#issuecomment-5260039214)): a
Space is not a container but a global tag on a project. This record accepts that framing,
re-derives everything downstream of it, and **replaces the earlier one**, which was never merged.

Two things decided it:

- **Removing the per-project board is not an additive change, and phasing does not make it one.**
  Deferring the removal to a later phase would mean taking away a screen users already have —
  strictly worse than never shipping the removal at all. So either project boards go away now or
  they live forever. Forever.
- **A container that allows a project in several places is not a container.** Once membership is
  many-to-many, "folder" is a lie and "tag" is the honest word. The word *Space* survives in the
  UI because it reads better in a project manager, and because *tag* collides with task labels,
  which already exist and are coloured.

## Investigation

Verified in the code, not assumed:

- **`src/bun/data.ts`** — `virtual-projects.json` is an exact precedent for a new sibling file:
  own cache with `cacheLookup`, `withFileLock` + `atomicWriteFile` on write, cache invalidation
  after, missing file means empty list, soft delete via `deleted: true`.
- **`addProject`** reactivates a soft-deleted project at the same path **keeping its id**, so
  membership keyed by `project.id` survives a remove and re-add.
- **`src/bun/data.ts` → `reorderProjects`** writes only `projects.json`; it stays the owner of the
  order of projects that are in no space.
- **`src/shared/types.ts`** — `CustomColumn`, `columnOrder`, `customStatusLabels`, `labels` and
  task `seq` are all per-project. `orderProjectsForDisplay()` pins the builtin Operations board
  first everywhere.
- **`src/mainview/App.tsx`** — the `Cmd+1..9` index is a project's position in board order with the
  builtin excluded (it owns `Cmd+0`), and the same number renders as a badge in the command
  palette. `keymap.ts` §5.2 declares number families structural and non-remappable.
- **`ActivityOverview.tsx`** is an attention-triage list, not a project table: per project it
  renders the individual task rows waiting for the user, each with priority, unread bell,
  custom-column swatch, hibernated badge, and exactly one action (`✓ Complete`).
- **`ActiveTasksSidebar.tsx`** — `SidebarScope = "project" | "global" | "attention"`, persisted in
  `localStorage` under `dev3-sidebar-scope`. The attention scope is a flat cross-project list of
  tasks in `user-questions`, `review-by-user`, `review-by-colleague` (`ATTENTION_STATUSES` in
  `utils/taskFacets.ts`), and it shares that rule with the `is:attention` search token.
- **`docs/ux/PRODUCT_UX_BIBLE.md`** §10 rejects "a per-row kebab or context menu on the dashboard"
  (it is what keeps the triage list from becoming a second board, issue #1252); §12 is
  one-zone-at-a-time on narrow viewports.
- **Streamer mode** (`decisions/2026/07/23/streamer-mode-css-blur-masking.md`) blurs a sensitive
  project's name *and all of its tasks* everywhere they render.

**Why this does not repeat the #257 rejection.** Issue #257 rejected "Board Groups" — a view-only
merged board — as an uncanny valley: it looked like one board but could not be worked in. There is
no merged board here at all, so there is nothing to mistake for one.

## Decision

### The model

- A **Space** is a named group of projects. **A project may belong to several spaces.** Membership
  is a set of edges; a space references projects and owns nothing.
- A **task always belongs to exactly one project.** Git decides this — worktree, branch and PR live
  in one repo. Spaces never move anything on disk; `projectSlug()` and the `~/.dev3.0/` layout are
  untouched.
- **Every project always keeps its own board.** No screen loses its subject, and nothing about the
  kanban changes.
- **There is no default space and nothing called Home on disk.** A project with no membership
  renders in a computed group at the bottom of the dashboard. Zero spaces means today's app
  exactly: no migration, and `spaces.json` is not even created until the user makes a space.
- **Nesting is not in v1.** The schema carries `parentId` so it can be added later without changing
  a format other installed versions already read.
- **A space has a name and nothing else.** No colour: colour already means *task label* on these
  screens, and a second coloured vocabulary teaches the user nothing.

### Data — `~/.dev3.0/spaces.json`

New file. Nothing existing is renamed, moved or rewritten.

```jsonc
{
  "version": 1,
  "spaces": [
    {
      "id": "sp_…",
      "name": "Client X",
      "parentId": null,            // reserved; always null in v1
      "projectIds": ["prj_…"],     // membership AND this space's project order
      "createdAt": 1754870000000,
      "deleted": false,            // soft delete, same convention as projects
      "sensitive": true            // optional; absent unless the user hides this space on camera
    }
  ],
  "order": ["sp_…"]                // order of the spaces themselves
}
```

Rules:

- **Membership is keyed by `project.id`.** Dangling ids are normal, not corruption — an older
  installed version can delete a project and will never clean up a file it does not know about.
  Rendering skips unknown ids silently.
- **`projectIds` is ordered**, and that order is per space: the same project may sit third in one
  space and first in another. Adding or removing a membership appends to or splices that one array
  and never touches `projects.json`.
- **Projects in no space keep the existing global order** from `projects.json`; `reorderProjects`
  is unchanged and still owns it.
- **A space is never empty.** The New Space dialog requires at least one project (existing, or one
  created inline as part of the same flow); when the last member leaves, the space is
  **soft-deleted automatically** with a toast, so the name is recoverable rather than silently
  gone. This holds for every path that can remove the last member, including unticking every
  project in `Edit projects…` — that dialog reports the auto-delete like the row's own picker does.
- Writes go through `withFileLock` + `atomicWriteFile` + cache invalidation, exactly like
  `virtual-projects.json`. Missing file means empty state. The app runs in several windows and in
  `dev3 remote` at once — never write without the lock.

### Surfaces

| Surface | Change |
|---|---|
| Dashboard (`ActivityOverview.tsx`) | A collapsible **space header** above that space's existing triage rows. **A project in several spaces renders its rows under each of them** — that is what many-to-many means on a screen. Projects in no space render last, under a computed heading. With zero spaces the dashboard is byte-identical to today's |
| Dashboard drag | **Reorders only, never membership.** Dragging a **rail row** reorders spaces (`order`) — the space header carries no grip; dragging a project inside a space writes that space's `projectIds`; dragging inside the bottom block writes `projects.json` through `reorderProjects`. The keyboard/touch path for space order is `Move up` / `Move down` in the space's own menu |
| Membership | A **multi-select** in Project Settings and in the create-project form, plus a **Spaces…** action in the existing project action cluster / bottom sheet, plus `Edit projects…` in a space's own menu (one dialog that both adds and removes). **No kebab is added to a project row** — §10; the `…` a *space* carries on its rail row and group header is the space object's own chrome, which §10 requires to sit against the space name |
| Create a space | One **New Space** dialog, reachable from the dashboard and from Project Settings; requires at least one project and can create that first project inline |
| Delete a space | Soft delete. Member projects only lose that one edge; a project left with no membership falls into the computed bottom block. **No prompt offering to remove the project from dev3** — a grouping change must never be able to delete a repo from the app |
| Active-tasks sidebar | Three scopes: **project**, **space**, **global** — `space` takes the slot the `attention` scope used to hold, which is removed ([#1347](https://github.com/h0x91b/dev-3.0/issues/1347)). **space** = every project sharing at least one space with the current project (the union when it has several); the position is disabled when the current project is in none |
| `Cmd+1..9` | **Unchanged.** The index stays the project's position in the stable global order; grouping does not renumber anything. The badge on grouped rows was **never built** — only the pinned Operations board shows its `⌘0` — so a repeated project repeats no number either |
| Search | Project search matches space names as well as project names |
| Narrow viewport | Nothing new. The space header is one collapsible row and the membership multi-select lives in the bottom sheet that already exists |
| Streamer mode | **A space is sensitive from its own flag, or if any member project is sensitive** — its name, header and counts blur wherever they render (rail, filter sheet, group header, row chips, pickers). Deliberately conservative: one private repo mutes the whole heading on camera. `Space.sensitive` is additive and *deleted* rather than written `false`, so an older installed version reads the file exactly as before |
| CLI | `dev3 current` gains the project's space names and the **read-only paths of sibling projects** (the union across its spaces, deduplicated) — both shipped, `src/cli/spaces.ts` — so an agent knows neighbouring repos exist and can read them. Nothing else: no cross-repo worktrees, no cross-repo PRs |

### Explicitly out of scope for v1

A merged space board · nested spaces · space settings · space colours · per-space column or label
configuration · cross-repo tasks (#257) · a space-level dev server or terminal.

### If a cross-project board is ever built

It is an **additional view**. It may not remove, replace or hide a project's own board. That
sentence is the reason this record exists; anything else re-opens a decision that was made here.

### What actually shipped

Steps 1–4, 6 and 7 landed as planned (PRs #1401, #1450). Step 5 shipped by halves: search matches
space names, the `Cmd` badge on grouped rows was never built. The dashboard's shape then moved on
past this record — a filtering rail, one menu per space, no cross-space task panel — which is the
subject of `decisions/2026/08/17/spaces-dashboard-follows-the-proposal-mock.md` and the
2026-08-20/21 records, not of this one. **This record is the model**: what a space is, what it owns,
and what it may never do to a project's board.

Every step was additive. The only capability that left the app is the sidebar's attention scope,
removed on its own track.

## Risks

- **The same task can appear twice on the dashboard** when its project is in several spaces. The
  honest reading of many-to-many, and collapsed headers hide it — but the triage list is the one
  screen where duplication costs the most, so this is the thing to watch in real use first.
- **v1 buys grouping and a sidebar ring, and no more.** If a user never creates a second space,
  nothing changed for them. Deliberate: the expensive half is the board, and it is not being
  guessed at ahead of use.
- **Two owners of order** — per-space `projectIds` and `projects.json` for everything else. They
  cannot conflict (each covers a disjoint case) but both must be written correctly on every
  membership change.
- **`Cmd` numbers no longer read top-to-bottom** on a grouped dashboard. Chosen over renumbering,
  which would move a shortcut every time a header collapses. Moot in practice: the number is not
  rendered on grouped rows at all.
- **One sensitive project mutes a whole space heading** in streamer mode — and a space can also be
  muted on its own, since the client's name is the secret whether or not any single repo of theirs
  is marked.
- **Deleting a space unlinks silently.** The record is soft-deleted and recoverable on disk, but
  there is no in-app undo.

## Alternatives considered

- **Spaces replace project boards** (the previous, unmerged record). Rejected after the author's
  pushback: it is not additive, and doing it in a later phase would be a regression on a screen
  users already have.
- **One space per project (a real folder).** Rejected: a shared microservice legitimately belongs to
  several clients, and with no merged board the main cost of many-to-many — one task on several
  boards — does not arise.
- **A stored builtin `Home` space.** Rejected: it writes to every user's state on upgrade and then
  needs permanent exceptions (cannot be deleted, cannot be renamed, hidden from the multi-select).
  A computed heading needs none of that.
- **A space as a route you navigate into.** Rejected: it makes a space a place, and one step later
  the question is "where is this place's board".
- **Calling it Tags.** Rejected: task labels already exist, are coloured, and are per project; two
  similar words on one screen is worse than one slightly loose word.
- **Drag moves membership** (the author's recommendation). Rejected: with several memberships the
  user cannot see which edge was removed, and cannot undo it with the same gesture. Drag keeps its
  single existing meaning — order.
- **Keeping the sidebar's attention scope and adding a fourth position.** Rejected: four positions
  in a scope switcher, for a scope that duplicates the `is:attention` search token.

Proposed by @arditti (h0x91b/dev-3.0#1295).
