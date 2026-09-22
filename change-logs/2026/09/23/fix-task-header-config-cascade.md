Short: Dev server CTA no longer lies

The task header read a task's config from the worktree alone, so a `devScript` or `setupScript` set in the main checkout's gitignored `.dev3/config.local.json` — a file a worktree never receives — looked absent and the header offered "Setup Dev Server" for a project whose dev server started fine. It now resolves through the same worktree+main cascade a start uses, with a reviewed branch's commands still untrusted.
