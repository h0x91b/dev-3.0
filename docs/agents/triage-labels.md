# Triage Labels

The skills speak in terms of five canonical triage roles. On this repo the tracker is the dev-3.0 Kanban board (see `docs/agents/issue-tracker.md`), so each role is a **dev3 label** applied to the task. dev3 statuses/columns (`todo`, `in-progress`, `user-questions`, `review-by-ai`, `review-by-user`) are managed by hooks and are NOT used to encode triage state — keep triage in labels.

| Canonical role (mattpocock/skills) | dev3 label        | Meaning                                  |
| ---------------------------------- | ----------------- | ---------------------------------------- |
| `needs-triage`                     | `needs-triage`    | Maintainer needs to evaluate this issue  |
| `needs-info`                       | `needs-info`      | Waiting on reporter for more information |
| `ready-for-agent`                  | `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human`                  | `ready-for-human` | Requires human implementation            |
| `wontfix`                          | `wontfix`         | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding dev3 label from this table.

## Applying a role

1. Ensure the label exists: `dev3 label list`. If missing, create it once: `dev3 label create "needs-triage"` (optionally `--color "#hex"`).
2. Apply it: `dev3 label set <label-id> [<other-ids>...] --task <task-id>`. `dev3 label set` replaces the task's full label set, so include every label the task should keep.
3. Clear all labels with `dev3 label set --clear --task <task-id>`.

For an external GitHub PR being triaged, apply the equivalent GitHub label instead: `gh pr edit <n> --add-label "<role>"` / `--remove-label "<role>"` (see `docs/agents/issue-tracker.md`).

Edit the right-hand column if you ever rename these labels.
