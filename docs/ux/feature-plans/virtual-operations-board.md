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

All copy must go through `t()` in en/ru/es; any new glyph uses the Nerd Font convention.

## 6. Discoverability & onboarding

- The built-in **Operations** board exists from first launch (replaces `home-terminal`), so the feature is present without a setup step.
- The **Quick-shell hotkey** (former home-terminal key) maps to a familiar action.
- 1–2 **feature tips** (`tips.ts`): one introducing the Operations board, one for "operations keep their history in Done". Self-assigned score ~3–4 (distinctive but not the flagship).

## 7. Loops (deferred, kept compatible)

Bnaya's original framing was loops. The user is **not** designing loops yet (timers are unreliable — closing the GUI kills them). Decision: **Operations is the intended home for future recurring/loop operations**, but the MVP ships **manual one-shot** operations only. Keep the operation model free of one-shot-only assumptions so a future `recurring`/`schedule` field can attach without a redesign. Do **not** build timers/scheduling now.

## 8. Deferred technical landmines (NOT solved in this plan)

These touch the **frozen `~/.dev3.0/` on-disk invariants** (see `AGENTS.md` → "On-disk data layout" and decision 039) and must be designed at implementation time, with the user, before any code:

1. **Slug for a path-less virtual project.** `projectSlug()` derives from `Project.path` and is **frozen**. A virtual project has no real repo path → it needs a synthetic, collision-free identity for `~/.dev3.0/data/<slug>/` without changing the slug algorithm for git projects.
2. **Where managed operation folders live.** A **new** path (e.g. `~/.dev3.0/ops/…`) is additive and acceptable, but must **never** be renamed/moved (invariant rule 2). Cleanup of a managed temp dir happens on operation delete, not on completion (history is preserved).
3. **Forward/backward compatibility of `Project.kind`.** `kind` is an additive field, but an older app version (N-2) opening `projects.json` would treat a virtual project as a git repo and break/show empty. This is the most uncomfortable cross-version angle and needs an explicit decision record before shipping.

## 9. What NOT to implement (now)

- No timers / scheduling / recurring runs.
- No second board stack, no new nav destination, no global-header entry.
- No git affordances on virtual tasks (hide, don't disable-in-place).
- No separate dashboard section.
- No changes to `projectSlug()` or any rename/move under `~/.dev3.0/`.

## 10. Likely files to change (implementation preview, for later)

- `src/shared/types.ts` — `Project.kind`, operation working-dir fields.
- `src/bun/data.ts`, `src/bun/git.ts`, `src/bun/paths.ts` — virtual-project identity + managed dir path (respecting invariants).
- Task creation / worktree path (`rpc-handlers/task-lifecycle.ts`) — skip worktree for virtual.
- `AddProjectModal.tsx` — type toggle.
- `KanbanBoard.tsx` / column config — simplified columns for virtual.
- `TaskInfoPanel.tsx` + `task-info-panel/*` — hide Git bar / diff for virtual.
- Remove `HomeTerminal.tsx` / `home-terminal` route; map its hotkey to Quick-shell operation.
- i18n (en/ru/es), `tips.ts`, a decision record, a changelog entry.

## 11. Open questions for the user (next planning pass)

- Exact user-facing label: **"Operations"** vs localized variants; and whether each item is called an "operation" or stays "task".
- How a **scratch (no-prompt) operation** presents on the card (badge? distinct glyph?).
- Whether the **fixed-folder** option allows several operations to share one folder (warn) or is one-folder-per-operation.
