# UX Principal Report: Virtual "Operations" board

Date: 2026-06-23
Mode: planning only (no code; feature concept)
Manifest status: planned (introduces a new `Project.kind` variant — manifest to be updated at implementation)
Confidence: medium-high (feature shape locked via user Q&A; on-disk/identity details deferred to implementation)

## 1. Feature understanding

- **User job:** Run everyday, code-driven tasks that are **not tied to any git repo** — back up prod, stop a server, triage mail/Slack, throwaway experiments — and keep them in **history** ("what was this and why did I do it"). The user explicitly framed this as "I don't only write code, I also do all sorts of stuff with code", cross-project or project-less.
- **Owning object:** A new **kind of Project** (`virtual`), not a new top-level object. It reuses the existing `Project → Task → terminal` chain minus the git worktree.
- **Feature class:** `destination` + object-model extension (a durable product area expressed as a project variant), not a single command.
- **Scope:** Workspace-level (lives on the dashboard next to git projects).
- **Frequency:** Daily / occasional.
- **Risk:** Safe per-operation; the **on-disk identity/layout** work is the sensitive part (see §8).
- **Origin:** Bnaya Zilberfarb's weekend note (rollout/loop ideas + "a general project board where you can run a non-project-related session/operation like a loop on your mail inbox/Slack"). This plan addresses the third idea; loops are deferred (§7).

### The onboarding problem (the user's central worry)

The user flagged that "virtual directory" is hard to explain. **Resolution: the user never hears the word "directory".** They see an **Operations** board next to their projects, add an operation like a task ("Backup prod DB"), an agent + shell open, it runs, it lands in Done. The working folder is managed and invisible by default. There is nothing to onboard — the directory concept is hidden behind the familiar task/board model.

## 2. Concept summary (locked via Q&A)

| Dimension | Decision |
|---|---|
| Name / mental model | **"Operations"** — a place for everyday, code-driven, repo-less tasks that persist in history. (User leaned between "scratch" and "operations"; "operations" won because tasks must persist, not be throwaway.) |
| Terminology | Built-in board's default name is **localized "Operations"** (en/ru/es, via a `t()` key; user-created boards use literal names). Items stay **"task"** everywhere (model, `dev3 task` CLI, UI) — "Operations" is the board theme, not a new noun. |
| Data model | `Project.kind: "git" \| "virtual"`. Virtual reuses dashboard, board, cards, sidebar, labels, notes. No new navigation, no second board stack. |
| Entry point | In the **common project list** on the dashboard, marked with a badge/icon. Created via the existing **Add project** flow with a type toggle (`Git repository` \| `Operations / no git`). |
| Worktree | **Excluded entirely.** No `git worktree add`, no branch, no base branch. The whole git domain (diff, PR, branch status, rebase/push, AI/colleague review) is **hidden** for virtual tasks. |
| Working directory | **Default: auto-managed temp folder** (user does not think about it). **Optional: "choose folder"** override per operation (e.g. `~/Downloads`, a prod-data folder). |
| Board columns | **Simplified set:** `todo → in-progress → user-questions → done`. No `review-by-ai` / `review-by-colleague` (those are diff-based). |
| Lifecycle / history | An operation **is a normal task**. It moves through the columns and **stays in Done = history**. Click to see what it was (title, overview, notes, log). |
| How many boards | **One built-in "Operations" board** ships by default (replaces `home-terminal`), **plus** the user can create additional virtual boards. |
| What runs | Each operation launches **both the AI agent and a split-right tmux shell pane**. An operation may be a **"scratch" task with no prompt** — it just opens a working session (agent idle + shell). |
| Quick shell | The old `home-terminal` hotkey now **instantly creates/opens a "Quick shell" operation in `~`** inside the Operations board. The one-keystroke "shell in home" habit is preserved. |
| `home-terminal` | **Removed**; its single-PTY role is absorbed by the Quick-shell operation above. |
| Loops | Operations is the **designed future home** for recurring/loop runs (Bnaya's ask), but **MVP is manual one-shot**; the model is kept forward-compatible. |

## 3. UX placement decision

Recommended placement:

- **Object:** `Project` with `kind: "virtual"`. It is the same object class as a git project, so it inherits every project surface for free and consumes **zero** new navigation budget.
- **Dashboard:** virtual projects render in the **same project list** as git projects, visually distinguished by a badge/icon (no-git / operations glyph). No separate dashboard section (rejected below).
- **Creation:** a **type toggle inside `AddProjectModal`** (`Git repository` | `Operations`), not a new button or nav destination. For the virtual branch, the repo-path + base-branch fields are replaced by the operation defaults (managed temp dir; optional fixed folder is a per-operation choice, not a project-level one).
- **Board:** the existing Kanban, with a **simplified column set** and the git-dependent columns/affordances hidden.
- **Inspector:** `TaskInfoPanel` **gracefully degrades** — the row2-left **Git bar disappears** for virtual tasks; Context, Session/Agent, and Runtime (open-in + scripts + dev-server) bars remain. This *reduces* density, so no budget pressure.

Rejected placements:

- **A separate "Workspaces/Scratch" section on the dashboard** — adds visual weight to the home screen and implies a deeper split than exists; a badge on the shared list is lighter and was the user's pick.
- **A new top-level nav destination / global-header icon** — navigation = places, not commands; nav budget ≤ 7; and this is "just another project", so it does not earn chrome.
- **A new first-class object (`Workspace`/`Operation`) with its own board stack** — ~90% of behavior overlaps `Project`; duplicating the board/card/sidebar stack is pure cost.
- **A "no-worktree" task flag inside normal git projects** — pollutes git boards with a foreign task type and breaks the diff/PR/review semantics of git columns.

Rationale: the feature is **a new *kind* of an existing object, not a new object**. Modeling it as `Project.kind` keeps the entire IA, navigation, and component surface unchanged, and lets the git domain simply switch off where it is meaningless.

## 4. The "no worktree" cascade (the actual work)

Excluding the worktree is the core change; it cascades:

- **Inspector Git bar (row2.left):** hidden for virtual tasks.
- **Diff review viewer:** unreachable (no diff). The diff-summary badge on the card / Context bar is hidden.
- **Lifecycle:** `review-by-ai` / `review-by-colleague` are diff/PR-based → not shown (reuse the existing `peerReviewEnabled` / `autoReviewEnabled` hiding mechanism, generalized).
- **Git actions** (pull/push/PR/merge/rebase, branch status): absent from the menu/inspector when the active task is virtual.
- **Create flow:** the worktree/branch step is skipped; instead the operation gets a working dir (managed temp or chosen folder) and launches the agent + split shell there.

## 5. Action hierarchy and token decisions (high level)

No new always-visible buttons. The Operations board reuses existing task affordances. New surfaces are limited to:

- **Add project type toggle** — segmented control, role `neutral`; the create CTA stays the single `primary` (`bg-accent`).
- **Operation working-dir selector** — `auto ▾` dropdown with a "choose folder…" entry that opens the existing React `FolderPickerModal` (no native dialog). Role `neutral`.
- **Operations / virtual badge** — `status`-style chip on the project tile and board header, semantic tokens only (no hardcoded color; reuse a neutral/`bg-raised` chip, distinct glyph).
- **Scratch (no-prompt) operation badge** — reuse the existing `Scratch — HH:MM` auto-title plus a terminal/shell Nerd-Font glyph on the card, so a live prompt-less session is distinct from an unstarted task. `status`-style, semantic tokens only.
- **Fixed-folder conflict warning** — when the chosen folder is already used by another **active** operation, show a non-blocking inline warning at folder-pick time (the operation is still allowed; completed operations don't count).

All copy must go through `t()` in en/ru/es; any new glyph uses the Nerd Font convention.

## 6. Discoverability & onboarding

- The built-in **Operations** board exists from first launch (replaces `home-terminal`), so the feature is present without a setup step.
- The **Quick-shell hotkey** (former home-terminal key) maps to a familiar action.
- 1–2 **feature tips** (`tips.ts`): one introducing the Operations board, one for "operations keep their history in Done". Self-assigned score ~3–4 (distinctive but not the flagship).

## 7. Loops (deferred, kept compatible)

Bnaya's original framing was loops. The user is **not** designing loops yet (timers are unreliable — closing the GUI kills them). Decision: **Operations is the intended home for future recurring/loop operations**, but the MVP ships **manual one-shot** operations only. Keep the operation model free of one-shot-only assumptions so a future `recurring`/`schedule` field can attach without a redesign. Do **not** build timers/scheduling now.

## 8. On-disk decisions (resolved 2026-06-23, with the user)

These touch the **frozen `~/.dev3.0/` on-disk invariants** (see `AGENTS.md` → "On-disk data layout" and decision 039). All three are now resolved at the planning level; a formal `decisions/NNN-*.md` record is still required when implementation lands.

### 8.1 Identity / slug for a path-less virtual project — RESOLVED

A virtual project is given a **synthetic but real `path` rooted under `DEV3_HOME`**: `path = ~/.dev3.0/ops/<slug>`, where `<slug>` is a **human-readable, allocated-once** id derived from the project name (`operations`, `operations-2`, `operations-3`, … — dedup suffix on collision). Consequences:

- `projectSlug(path)` stays **completely unchanged** (frozen algorithm) — it just munges the synthetic path string like any other (`~/.dev3.0/ops/operations-2` → `Users-<user>-.dev3.0-ops-operations-2`).
- `src/cli/context.ts` cwd→task detection stays **unchanged** — it recomputes the same slug from `path`, so it keeps working with zero drift risk.
- Task metadata lives at `data/<projectSlug(path)>/tasks.json`, exactly like git projects.
- **Uniqueness rule:** the `<slug>` is unique across *all* projects (git + virtual) and is **never reused** while its `data/` dir survives — so a deleted-then-recreated board cannot inherit stale task data.
- "Add git project" is guarded against paths under `~/.dev3.0/` so a real repo can never collide with the synthetic namespace.

Rejected: a separate `dataKey`/`slug` field branching `taskDir` on `kind` (two code paths + must patch the independent `context.ts` recompute → exactly the drift the invariants warn against).

### 8.2 Where managed operation folders live — RESOLVED

Managed (auto) working dirs live in a **new additive tree**: `~/.dev3.0/ops/<slug>/<taskId>/work` (the working dir nests right under the project's synthetic `path`). This is additive (invariant-safe) and keeps the git-specific `worktrees/` tree semantically clean (no plain dirs masquerading as worktrees).

- **Cleanup:** the managed temp dir is removed **on operation (task) delete**, NOT on completion — a completed operation keeps its task record (title/overview/notes) as history.
- **Fixed (chosen) folder:** the user's own folder (e.g. `~/Downloads`) is **never** auto-created or auto-removed; only the task record is deleted.
- No `renameSync`/`mv` ever applied to anything under `~/.dev3.0/` (invariant rule 2).

### 8.3 Forward/backward compatibility of virtual projects — RESOLVED

Virtual projects are stored in a **separate `~/.dev3.0/virtual-projects.json`**, NOT in `projects.json`. This is the invariant doc's rule-5 "parallel path" pattern:

- Older app versions (N-2, side-by-side prod/dev builds) **never read** the new file → they are simply blind to the feature; `projects.json` stays 100% valid for them. No broken tiles, no git ops on a non-git project, no data loss.
- New versions build the dashboard from `merge(projects.json, virtual-projects.json)`.
- Tasks are **already isolated** (`data/<slug>/tasks.json` per project) — an old version never visits a slug it doesn't know, so virtual-project tasks are invisible to it for free.
- `src/cli/context.ts` must read **both** files when mapping cwd→task (additive change, no algorithm change). Old CLI versions simply won't detect virtual-project tasks (acceptable — they predate the feature).

Rejected: one `projects.json` with a `kind` field (old versions show a broken/erroring virtual tile on downgrade/side-by-side) and a `schemaVersion` bump (old versions' behavior is already fixed and can't react to the marker — weak protection).

## 9. What NOT to implement (now)

- No timers / scheduling / recurring runs.
- No second board stack, no new nav destination, no global-header entry.
- No git affordances on virtual tasks (hide, don't disable-in-place).
- No separate dashboard section.
- No changes to `projectSlug()` or any rename/move under `~/.dev3.0/`.

## 10. Likely files to change (implementation preview, for later)

- `src/shared/types.ts` — `Project.kind`, operation working-dir fields.
- `src/bun/data.ts` — load/save virtual projects from `~/.dev3.0/virtual-projects.json`, merge with `projects.json` for the dashboard; readable-slug allocation.
- `src/bun/git.ts`, `src/bun/paths.ts` — virtual-project synthetic path + managed `ops/<slug>/<taskId>/work` dir (no change to `projectSlug()`).
- `src/cli/context.ts` — read both `projects.json` and `virtual-projects.json` when mapping cwd→task (additive; no slug-algorithm change).
- Task creation / worktree path (`rpc-handlers/task-lifecycle.ts`) — skip worktree for virtual.
- `AddProjectModal.tsx` — type toggle.
- `KanbanBoard.tsx` / column config — simplified columns for virtual.
- `TaskInfoPanel.tsx` + `task-info-panel/*` — hide Git bar / diff for virtual.
- Remove `HomeTerminal.tsx` / `home-terminal` route; map its hotkey to Quick-shell operation.
- i18n (en/ru/es), `tips.ts`, a decision record, a changelog entry.

## 11. Product decisions (resolved 2026-06-23, with the user)

- **Board name — localized "Operations".** The built-in board's default name is `Operations` / `Операции` / `Operaciones`, rendered via a `t()` key (small special-case: only the built-in board's name is a key; user-created virtual boards store literal names like any project). The user can rename it. Rejected: fixed English label (violates the i18n policy) and a different default word like "General"/"Workspace" (less faithful to the "operations" concept the user chose).
- **Item noun — stays "task" everywhere.** "Operations" is the board's theme/name; the items inside remain **tasks** across the data model, the `dev3 task` CLI, and the UI. No vocabulary fork, no extra i18n, CLI contract unchanged. Rejected: relabel to "operation" in the renderer only (UI↔CLI split) or a full model+CLI+UI rename (breaks the CLI contract for no real gain).
- **Scratch (no-prompt) operation — reuse "Scratch — HH:MM" + shell glyph.** A prompt-less live session reuses the existing `Scratch — HH:MM` auto-title convention plus a terminal/shell Nerd-Font glyph badge on the card, so it reads as a live session rather than an unstarted task. `status`-style, semantic tokens only. Rejected: no marker (indistinguishable from an empty task) and a bespoke "ghost" card style (new card variant = drift risk vs `DESIGN.md`).
- **Fixed-folder sharing — allowed, warn on active conflict.** Two operations may target the same chosen folder, but if the folder is already used by another **active** operation, show a non-blocking inline warning at folder-pick time ("agents may conflict"). Completed operations don't count (they aren't running). Rejected: hard one-folder-per-operation (blocks legitimate sequential reuse) and silent allow (easy footgun).

## 12. Implementation plan (staged, 2026-06-23)

Grounded in a full code investigation (file:line refs below are current as of this date). The work is split into **6 PR-sized stages (0→5)**, each independently green (`bun run lint` + `bun run test`) and shippable. Stages 0–1 are backend-only and invisible; the feature becomes user-visible at stage 2.

### Cross-cutting decisions (apply to every stage)

These resolve conflicts surfaced by cross-checking the subsystem investigations. They override any single-subsystem suggestion.

1. **Reuse `Task.worktreePath` for the operation's working dir — do NOT add a parallel `workDir` field.** Almost every non-git affordance (Runtime bar: open-in / scripts / dev-server / ports; spawn-agent; tmux launch cwd; `deleteTask` cleanup) already keys off `task.worktreePath`. A virtual task therefore **must** have `worktreePath` set to its work dir so those keep working for free. The git domain is hidden by **explicit `project.kind !== "virtual"` guards** (§ stage 3), not by leaving `worktreePath` empty. The field name is a minor semantic wart (it's not a worktree) — documented in the decision record, not renamed.
2. **Work-dir path = `${project.path}/${shortId(task.id)}/work`.** Since a virtual project's `path` is already the synthetic `~/.dev3.0/ops/<readable-slug>`, the managed work dir nests directly under it. Do **not** re-apply `projectSlug()` to build it (that would double-munge). `projectSlug()` stays frozen and untouched.
3. **Task metadata is unchanged: `data/${projectSlug(project.path)}/tasks.json`.** The existing `tasksFile()` / `loadTasks` / `saveTasks` work as-is for virtual projects because `projectSlug()` munges the synthetic path like any other. **Zero changes to the task-data layer.** (The CLI must therefore resolve virtual tasks from `data/<projectSlug(path)>/tasks.json` too — NOT from `ops/<slug>/tasks.json`.)
4. **Deletion safety invariant: only ever `rm` a work dir that is under `${DEV3_HOME}/ops/`.** Managed dirs live there; user-chosen fixed folders (`~`, `~/Downloads`, a prod-data dir) never do and must never be auto-removed. `deleteTask` checks the prefix before `rmSync`. This is safety-critical (never delete user data).
5. **Chosen-folder is remembered on the task before activation** via a new optional `Task.opsWorkDir?: string`. On activation: `resolvedDir = task.opsWorkDir ?? managedWorkDir`; `mkdir -p` only when managed; then `worktreePath = resolvedDir`. Quick-shell sets `opsWorkDir = homedir()`.
6. **`kind` is `"git" | "virtual"`, optional, `undefined ⇒ "git"`.** Everywhere that branches reads `project.kind === "virtual"`; everywhere git-only reads `project.kind !== "virtual"` (so legacy projects with no field stay git).

### Stage 0 — Data model + identity foundation (backend, invisible)

**Goal:** virtual projects can exist on disk, load/merge into the dashboard list, and the CLI resolves their tasks. No UI, no lifecycle yet.

- `src/shared/types.ts` — `Project`: add `kind?: "git" | "virtual"` and `builtin?: boolean` (marks the localized built-in board). `Task`: add `opsWorkDir?: string`. Add the new RPC `addVirtualProject: { params: { name: string }; response: Project }` to `AppRPCSchema`.
- `src/bun/data.ts` — add `VIRTUAL_PROJECTS_FILE = ${DEV3_HOME}/virtual-projects.json`; mirror the projects.json functions: `rawLoadAllVirtualProjects` / `rawSaveVirtualProjects` / `loadVirtualProjects` / `saveVirtualProjects` (own cache key, own file lock). Add `findUniqueVirtualProjectSlug(base="operations")` scanning **git slugs** (`projectSlug(p.path)` over `rawLoadAllProjects`), **virtual slugs** (basename of each virtual `path`), and **surviving `data/` dir names** (never reuse while task data survives). Add `addVirtualProject(name)` → allocate slug → `path = ${DEV3_HOME}/ops/${slug}` → push to virtual file. Guard `addProjectImpl` (`app-handlers.ts:230`) to reject any git project path under `${DEV3_HOME}` (prevents collision with the synthetic namespace).
- `src/bun/rpc-handlers/app-handlers.ts` — `getProjects` becomes the **single merge point**: `[...await data.loadProjects(), ...await data.loadVirtualProjects()]`. Add the `addVirtualProject` handler (calls `data.addVirtualProject`, pushes a `projectAdded`/list-refresh as the existing add flow does).
- **Built-in board provisioning** (idempotent, additive — invariant-safe): on startup, if no `builtin` virtual project exists, create one via `addVirtualProject` semantics with `builtin: true`, `path = ${DEV3_HOME}/ops/operations`. Never rename/move; if it exists, leave it. This *replaces* `home-terminal` (removal in stage 4).
- `src/cli/context.ts` — additive: new `detectFromVirtualPath(cwd)` recognizing the `/.dev3.0/ops/` marker → `{ readableSlug, taskShortId, realDev3Home }`. In `resolveFromWorktreePath` (line 70): try git detection first, then virtual; for the virtual branch read `virtual-projects.json`, match the project by `basename(p.path) === readableSlug`, then resolve tasks from **`data/${projectSlug(p.path)}/tasks.json`** (same formula as git — correcting the investigation's `ops/<slug>/tasks.json`). **No change to the frozen slug algorithm.**
- **Tests:** virtual project CRUD + corrupt-file handling; slug allocation (uniqueness across git+virtual, no-reuse while `data/` survives); guard rejects git project under `~/.dev3.0`; CLI cwd→task resolution for a virtual work dir; dashboard merge includes both files.
- **Docs:** `decisions/NNN-virtual-project-identity-and-storage.md` (synthetic path, separate file, frozen slug, worktreePath reuse rationale).

### Stage 1 — Worktree-less lifecycle + cleanup (backend, invisible)

**Goal:** moving a virtual task to active creates a managed (or chosen) work dir, launches the agent + a split-right shell, and never touches git. Completion keeps the dir as history; delete removes it (managed only).

- `src/bun/rpc-handlers/task-lifecycle.ts`
  - `moveTask` inactive→active branch (≈663–684): if `project.kind === "virtual"`, resolve `dir = task.opsWorkDir ?? ${project.path}/${shortId(task.id)}/work`; `mkdir -p` when managed; `launchTaskPty(project, task, dir, agentId, configId, true)`; `updateTask({ worktreePath: dir, branchName: null })`. Else existing `activateTask` path.
  - `activateTask` (≈356–383): guard `git.createWorktree` (363), sparse-checkout (365–370), `runCowClones` (371) behind `project.kind === "git"`. `resolveOperationalProjectConfig` + `launchTaskPty` stay shared.
  - `moveTask` completed/cancelled cleanup (≈686–745): `runCleanupScript` stays; guard `git.removeWorktree` (726) behind `kind === "git"` — virtual keeps its dir on completion (history).
  - `deleteTask` (≈798–817): replace the unconditional `git.removeWorktree` with: git → `removeWorktree`; virtual → `rmSync(task.worktreePath)` **only if `worktreePath.startsWith(${DEV3_HOME}/ops/)`** (decision #4; protects fixed folders).
- `src/bun/git.ts` — guard `saveDiffSnapshot` (≈1851) to no-op for virtual (no diff). Guard any periodic branch-status/diff polling on `kind === "git"` (or `task.branchName != null`) so we never run `git` against a non-repo dir.
- `src/bun/rpc-handlers/tmux-pty.ts` — `launchTaskPty` after `pty.createSession` (≈387): for `kind === "virtual"`, always create a split-right shell pane (`tmux split-window -h -l 40% -c <worktreePath> … bash -i`), reusing the existing `pty.tmuxArgs` pattern from `runDevServer`/`launchColumnAgent`. Non-fatal on error (log + continue).
- **Scratch (no-prompt):** no code change — existing `task.scratch ⇒ description:""` blanking (≈276/380) already idles the agent; the split shell is the usable pane.
- **Tests (reproduce-first style):** virtual activation creates the managed dir and calls no git; `opsWorkDir` is honored (no mkdir for fixed); completion keeps the dir, delete removes a managed dir but **not** a fixed folder; split-shell tmux call issued for virtual only; scratch path blanks prompt.

### Stage 2 — Board, dashboard tile, create flow (renderer, feature goes visible)

- `src/mainview/components/KanbanBoard.tsx` (`shouldHide`, ≈283–285): add a leading clause so virtual hides the diff-based review columns. **Per locked §2 the virtual column set is `todo → in-progress → user-questions → completed/cancelled`** — i.e. hide `review-by-ai`, `review-by-colleague`, **and** `review-by-user`. (Only `review-by-user` is debatable; defaulting to the locked §2 list. Flag for user confirmation.)
- `src/mainview/components/ActivityOverview.tsx` (≈279–281): render an **Operations badge** (semantic `bg-raised` chip, Nerd-Font glyph, `t()` label) when `project.kind === "virtual"`.
- `src/mainview/components/AddProjectModal.tsx`: add a top-level segmented control **`Git repository | Operations`** (role `neutral`). `Operations` hides the Local/Clone/Init tabs, shows a single **name** field (+ a one-line "managed temp folder; pick a folder per-operation later" hint), and the primary CTA calls the new `addVirtualProject({ name })` RPC. No git path/branch validation on that branch.
- **Built-in board name localization:** the renderer maps `project.builtin === true` → `t("ops.boardName")`; user rename clears the localized display (store literal name, drop `builtin` name-substitution). Add `ops.boardName` to en/ru/es.
- **Tests:** virtual board renders exactly the 4 columns; badge shows for virtual / absent for git; modal's Operations branch creates a virtual project via the RPC (mocked).

### Stage 3 — Inspector git-domain hiding + working-dir selector

- `src/mainview/components/TaskInfoPanel.tsx`: guard on `project.kind !== "virtual"` (project arrives as a direct prop — no lookup): the `TaskGitActions` git bar in both rows (≈639–650, ≈702–712), the diff-summary badge (≈375–400), the diff-include-tests toggle (≈401–423), and the bug-hunters button (diff-based, ≈566). **Keep** Context, Session/Agent, spawn-agent, and the Runtime bar (open-in/scripts/dev-server/ports) — they already gate on `worktreePath`, which virtual now has.
- **Working-dir selector** (creation surface): an `auto ▾` dropdown with "Choose folder…" opening the existing React `FolderPickerModal` (no native dialog). Selecting a folder sets `task.opsWorkDir`; default (auto) leaves it unset → managed dir. On pick, if the folder is the `worktreePath` of another **active** virtual task, show a non-blocking inline warning (locked §11). Role `neutral`.
- **Scratch card badge:** shell/terminal Nerd-Font glyph on cards whose `task.scratch` is set (mostly already rendered via the `Scratch — HH:MM` convention; verify in `TaskCard*.tsx`).
- **Tests:** all git affordances hidden for virtual, Runtime bar still present; folder pick writes `opsWorkDir`; active-conflict warning appears only against active tasks.

### Stage 4 — Remove home-terminal, repurpose the hotkey to Quick-shell

- **Remove** (per the full audit): `HomeTerminal.tsx`, `HomeTerminalIcon.tsx`; the `{ screen: "home-terminal" }` route (`state.ts`) and all `App.tsx` references (import, render case ≈1627, `hasTerminal`/title-bar conditions); the `term-toggle-home-terminal` command + menuRouter case; `getHomePtyUrl`/`destroyHomeTerminal` (RPC schema + `tmux-pty.ts` ≈1027–1053 + exports); `PtySessionType "home"`, `HOME_TERMINAL_SESSION_KEY`/`_TMUX_NAME`, the `"home"` branch in `computeTmuxSessionName`, and the `sessionKey === "home"` special-cases in the PTY died/bell/idle handlers (`index.ts`, `headless-entry.ts`); related i18n keys; the `getHomePtyUrl`/`destroyHomeTerminal` tests and the `home-terminal` route test.
- **Quick-shell hotkey** (`App.tsx` ≈525–533, currently `⇧⌘\``): instead of navigating to home-terminal, **create-or-focus** a Quick-shell operation in the built-in Operations board — a `scratch: true` task with `opsWorkDir = homedir()`, moved straight to `in-progress`, then navigate to its task screen. Reuses the existing task-PTY machinery (`getPtyUrl`, recovery, ports). Update the `keymap.ts:78` entry's `descKey`/action (it's the single source of truth for the shortcuts overlay).
- **Tests:** hotkey creates the Quick-shell op (or focuses the existing one) with cwd = home; removed RPCs/route no longer referenced.

### Stage 5 — Discovery, manifest, docs, final green

- `src/mainview/tips.ts` + i18n: 1–2 tips (Operations board; "operations keep their history in Done"), self-scored ~3–4.
- Manifest: update `docs/ux/PRODUCT_UX_BIBLE.md` §3 and `docs/ux/ux-architecture.yaml` (mark `Project.kind` from `planned` → `Observed`); append `UX_DECISIONS.md`; `UX_MANIFEST_CHANGELOG.md` entry.
- `concept.md` status-tracker checkboxes flipped as stages land.
- One `change-logs/2026/MM/DD/feature-virtual-operations-board.md` (this worktree = one entry; update, don't multiply).
- Finalize the decision record(s); confirm `bun run lint` **and** the full `bun run test` are green end-to-end before any push/PR.

### Sequencing & risk

- **Order:** 0 → 1 → 2 → 3 → 4 → 5. 0+1 can land before any UI (safe, invisible). 4 (home-terminal removal) depends on the built-in board from 0 and the lifecycle from 1, so it comes after 2–3 prove the path.
- **Highest-risk areas:** the on-disk identity (stage 0 — covered by the frozen-invariant analysis in §8) and the `deleteTask` fixed-folder guard (stage 1, decision #4). Both have dedicated tests.
- **Forward-compat:** old app versions never read `virtual-projects.json` and never visit the virtual `data/` slug → they stay blind to the feature (no breakage), exactly as designed in §8.3.
