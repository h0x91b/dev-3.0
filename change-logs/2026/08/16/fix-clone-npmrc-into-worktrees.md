Short: Worktrees keep your .npmrc

A gitignored `.npmrc` at the project root is now cloned into every new task worktree, so installs there use the same registry and credentials as the main checkout instead of silently falling back to the public registry. The file is also gitignored in this repo so it can never be committed by accident.
