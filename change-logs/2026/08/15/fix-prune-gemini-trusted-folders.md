Short: Stop leaking worktree paths to Gemini

dev3 registered every task worktree in ~/.gemini/trustedFolders.json and never removed it, so the file grew one dead entry per task forever. Entries are now dropped when the worktree is removed, and a startup sweep clears the ones left behind — only paths under the dev3 worktrees root that no longer exist, never a folder you trusted yourself.
