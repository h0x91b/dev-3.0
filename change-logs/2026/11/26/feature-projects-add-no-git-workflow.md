Short: Add plain folders from the CLI

`dev3 projects add <path> --no-git-workflow` registers a folder with the git workflow off, as the Add Project dialog already can: the folder needs no git repository or first commit, and its tasks share it with no worktree or branch each. The "not a git repository" error now names the flag next to `--init`, and the two flags cannot be combined. `dev3 projects list --json` and the add result show each project's `gitWorkflow`, and the CLI fails loudly if an older app ignores the flag.
