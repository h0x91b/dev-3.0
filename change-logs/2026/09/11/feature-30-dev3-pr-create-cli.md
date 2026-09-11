Short: Open a PR from the CLI

New `dev3 pr create --title "..." [--description "..."] [--base <branch>] [--draft] [--auto-merge[=squash|merge|rebase]]`: it pushes the branch checked out in the worktree, opens the pull request through `gh`, targets the base branch the task was created from, and appends the origin-task footer unless the user turned it off. An unauthenticated or missing `gh` is refused with the new exit code 23 before anything is pushed, so a logged-out `gh` can no longer be discovered halfway through.
