Short: Dev server output as a greppable log

A task's dev server now mirrors everything it prints to `<taskDir>/logs/dev-server.log`, beside the worktree so it never appears in `git status`. `dev3 dev-server logs [--lines N]` prints the tail and `dev3 dev-server status` shows the path, so an agent can grep a stack trace or tail a failing build instead of attaching to the pane. Escapes and progress-bar redraws are stripped, each start begins a fresh log, and the pane itself is untouched — the dev server keeps its own tty, colours and interactive keys.
