Short: Own worktree for one gitless task

A project with the git workflow off can now give a single task its own worktree and branch: pick Own worktree under Working folder in the New Task dialog (or pass `dev3 task create --worktree`), and that task gets the diff and Git bar while every other task keeps sharing the project folder. Finishing it removes the worktree but keeps a branch with commits found nowhere else, and Merge goes through a pull request so nothing is committed in the shared folder.
