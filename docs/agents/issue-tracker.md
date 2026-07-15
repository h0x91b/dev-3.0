# Issue tracker: dev-3.0 Kanban board

Issues and PRDs for this repo live as **tasks on the dev-3.0 Kanban board**, managed through the `dev3` CLI (the same board this project ships). There is no separate issue tracker — a task *is* an issue. External GitHub PRs are pulled in as a secondary triage surface (see below).

Task and project are auto-detected from the worktree; pass `--task <id>` / `--project <id>` to target another.

## Conventions (dev3 tasks)

- **Create an issue**: `dev3 task create --title "..." --description "..."` — lands in the To Do (`todo`) column. For multiline Markdown, pipe it with `--description -`, for example: `cat plan.md | dev3 task create --title "..." --description -`.
- **Write long text**: `task update --description -`, `note add --content -`, and `automations ... --prompt -` read the body from stdin; `@file` remains the file-based alternative.
- **Read an issue**: `dev3 task show --task <id> --notes --history` (always prints the current overview; `--notes` inlines note bodies, `--history` shows the title/overview change log).
- **List issues**: `dev3 tasks list [--status <s>] [--label <id>] [--limit <n>] [--offset <n>]` (newest first). Statuses: `todo`, `in-progress`, `user-questions`, `review-by-ai`, `review-by-user`.
- **Comment on an issue**: `dev3 note add "..." --task <id>` — per-task notes are the durable comment/scratchpad analog; they survive worktree teardown and are surfaced to future agents.
- **Apply / remove labels**: `dev3 label set <id> [<id>...] --task <task>` sets the task's labels to *exactly* the given ids (include every label the task should keep — it replaces the full set); `dev3 label set --clear --task <id>` removes all. Create a missing label first with `dev3 label create "name" [--color "#hex"]`; list with `dev3 label list`.
- **Set the overview (sticky summary)**: `dev3 overview set "..." --task <id>`.
- **Change state / column**: `dev3 task move --task <id> --status <status>`. Note: `completed` and `cancelled` are UI-only, require user approval, and destroy the worktree — they are not a plain "close".

## When a skill says "publish to the issue tracker"

Create a dev3 task: `dev3 task create --title "..." --description "..."`.

## When a skill says "fetch the relevant ticket"

Run `dev3 task show --task <id> --notes`.

## Pull requests as a triage surface

**PRs as a request surface: yes.** External GitHub PRs against `h0x91b/dev-3.0` are treated as feature requests and pulled into the same triage flow, using the same triage labels (see `docs/agents/triage-labels.md`). Collaborators' in-flight PRs are left alone.

- **Account**: run `gh auth switch --user h0x91b` before any `gh` write (the dev machine also has `h0x91b-wix`).
- **Read a PR**: `gh pr view <number> --comments`; `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.
- When an external PR is accepted into the work queue, mirror it as a dev3 task (`dev3 task create`) so it flows through the board like any other issue, and cross-link the PR number in the task description.

The triage role → dev3 label mapping lives in `docs/agents/triage-labels.md`.
