## Tasks Quick Switch recency

Tasks Quick Switch keeps its own recent-task list derived from opened task routes, instead of reusing the app's general route history.

**Why:** Route history mixes dashboard, settings, project boards, and terminals, which makes Cmd+Tab-style task switching feel wrong. The switcher also needs cross-project active tasks, so it combines this recent-task memory with `getAllProjectTasks()` and falls back to task timestamps for items not visited yet.

## Tasks Quick Switch filter identity

Tasks in custom columns are filtered by custom column identity, not by their underlying built-in status.

**Why:** Custom columns are what users actually see on the board, while the built-in status is an implementation detail that still drives lifecycle rules. Treating quick-switch filters as `status | custom-column` keeps the settings UI honest, lets global settings include user-created columns, and avoids in-progress tasks from silently leaking into the switcher when they live in a custom column the user did not select.
