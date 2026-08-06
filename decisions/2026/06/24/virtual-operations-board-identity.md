# 079 — Virtual "Operations" board: identity, storage, and worktreePath reuse

## Context

The virtual "Operations" board (`Project.kind: "virtual"`) is a non-git Kanban whose
tasks have no git worktree. It must coexist with the **frozen `~/.dev3.0/` on-disk
invariants** (AGENTS.md → "On-disk data layout"; decision 039): `projectSlug()` must
not change, nothing under `~/.dev3.0/` may be renamed/moved, and older app versions
must keep reading `projects.json` correctly.

## Decision

1. **Synthetic real path.** A virtual project gets `path = ${OPS_DIR}/<slug>`
   (`OPS_DIR = ~/.dev3.0/ops`), where `<slug>` is a human-readable, allocated-once,
   never-reused id derived from the name (`operations`, `operations-2`, …). `projectSlug()`
   and `src/cli/context.ts` stay **completely unchanged** — they just munge the synthetic
   path string like any other (`findUniqueVirtualProjectSlug` in `src/bun/data.ts`).
2. **Separate file.** Virtual projects live in `~/.dev3.0/virtual-projects.json`
   (`rawLoad/rawSave/load/saveVirtualProjects`), merged with `projects.json` only at the
   dashboard read point (`getProjects` in `app-handlers.ts`). Old versions never read it →
   stay blind to the feature; `projects.json` remains valid for them (rule-5 parallel path).
3. **Task metadata is NOT special-cased.** Tasks live at
   `data/${projectSlug(path)}/tasks.json` exactly like git projects, so `tasksFile()` /
   `loadTasks` / `saveTasks` are untouched. The CLI resolves virtual tasks from that same
   location (`resolveFromVirtualPath` in `context.ts`), matching the project by the readable
   slug (basename of the synthetic path).
4. **Managed work dir = `${project.path}/${shortId(task.id)}/work`** (`virtualWorkDir` in
   `git.ts`) — nested under the synthetic path, so `projectSlug()` is NOT re-applied (that
   would double-munge).
5. **`Task.worktreePath` is reused** for the operation's working dir (no parallel field).
   Runtime affordances (open-in / scripts / dev-server / ports / spawn-agent) and the PTY
   launch already key off `worktreePath`, so reusing it keeps them working for free; the
   git domain is hidden by explicit `project.kind !== "virtual"` guards instead.

## Risks

- `worktreePath` is a semantic misnomer for virtual tasks (it is not a worktree). Accepted
  to avoid threading a new field through the whole PTY/cleanup/open-in stack; documented here.
- Deletion safety: only ever `rm` a work dir under `${OPS_DIR}/`; user-chosen fixed folders
  (e.g. `~`) are never auto-removed (enforced in the lifecycle stage).
- `addProjectImpl` rejects git projects under `~/.dev3.0/` so a real repo can never collide
  with the synthetic namespace.

## Alternatives considered

- A `dataKey`/`slug` field branching `taskDir` on `kind` — two code paths + a second place to
  patch `context.ts`, exactly the drift the invariants warn against. Rejected.
- One `projects.json` with a `kind` field — old versions render a broken/erroring virtual tile
  on downgrade/side-by-side. Rejected.
- A separate `Task.workDir` field — would hide the Runtime bar (it gates on `worktreePath`) and
  require fallback plumbing everywhere. Rejected in favor of reusing `worktreePath`.
