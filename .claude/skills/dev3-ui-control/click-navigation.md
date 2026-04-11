# Click-based navigation reference

Load this file only when testing click behavior itself. For normal navigation, use `__dev3.navigate()` from the main SKILL.md.

## Navigate to a project (from dashboard)

```bash
agent-browser snapshot -i
# Find the project button (e.g., @e2 button "dev-3.0 /Users/...")
agent-browser click @eNN
agent-browser wait 1000
agent-browser snapshot -i
# Now on the Kanban board
```

## Task card click behavior

| Task status | Click behavior |
|---|---|
| Active (has worktree) | Navigates to split view or fullscreen |
| To Do (no worktree) | **Does nothing** |
| Completed / Cancelled | Opens TaskDetailModal |

## Sidebar task list

The left sidebar lists active tasks. Each is a `<button>`:
- Click a task → switches to its workspace
- Click the active task → deselects (returns to board view)

## "Open in..." menu (gotcha)

The icon button (`U+F0379`) on task cards opens an "Open in..." dropdown — it does **not** navigate. Don't click it when trying to navigate.

## Finding task cards by ID

When snapshot refs don't surface a card, use `data-task-id`:

```bash
agent-browser eval '(() => {
  const el = document.querySelector("div[data-task-id=\"TASK_UUID\"]");
  if (!el) return "not found";
  el.click();
  return "clicked";
})()'
```
