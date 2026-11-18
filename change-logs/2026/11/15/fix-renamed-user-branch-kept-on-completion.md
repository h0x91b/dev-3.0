Short: Renamed user branches survive task completion

Completing or cancelling a task no longer deletes a branch the user brought in just because an agent renamed it to a name that starts with the original (e.g. `feature/x` → `feature/x-renamed`). A branch now counts as a variant branch only when it carries this task's exact variant name (`<branch>-vN`, or `<branch>-vN-K`), judged by its original name from the reflog when it was renamed.
