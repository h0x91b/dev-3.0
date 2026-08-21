Short: No more "vs origin/main" without a remote

A project added from a local folder with no git remote no longer compares against `origin/main`, a ref that is not there. Diffs, ahead/behind and Show Diff now measure against the local base branch, Push / Create PR / PR + auto-merge read as unavailable with a reason instead of failing on click, and a diff whose compare ref does not exist says so rather than reporting "no changes to show". The root cause was the newly added project reaching the UI with its config unresolved, so the UI guessed `origin/` for the rest of the session.
