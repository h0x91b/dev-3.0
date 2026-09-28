# Pane dimming lives in the tmux server, last explicit toggle wins

## Context
Settings → Terminal → Dim inactive panes is one global choice, but every dev3 instance on a machine (the installed app, a dev build, a QA instance) shares the `dev3` tmux server and the `/tmp` themed config files. Before this change, each process wrote its own choice into `/tmp/dev3-tmux-{dark,light}.conf` when it loaded, and it re-sourced that file on every PTY spawn and theme change. So the choice of whichever process wrote last overwrote the choice the user had just clicked.

## Decision
- The choice is the server-global user option `@dev3_pane_dimming` (`TMUX_PANE_DIMMING_OPTION`, `src/bun/tmux/config.ts`).
- The themed config seeds it only when it is unset (`set -goq`), and derives `window-style` / `pane-border-style` from it with `#{?#{==:…,off},…}`. Re-sourcing a config therefore never changes the choice.
- Only an explicit toggle overrides it: `saveGlobalSettings` → `applyTmuxConfigChange` → `applyTmuxTheme(theme, { paneDimming })`, which runs `set-option -g` on each socket before the source.
- Config files are named per default choice (`tmuxConfigPath(theme, dimmed)`). A process's seed default is then never taken from another process's file.

## Risks
- An instance's Settings UI can show a value that differs from the server's after another instance toggled. To override it, the user clicks the toggle to the other value and back.
- After a server restart, the first instance to start the server seeds its own saved choice.
- Older app versions still write and source the old file names, with the old hard-coded styles.

## Alternatives considered
- **Per-process file names only.** This fixed the file overwrite, but a second instance still re-dimmed the server on its own sources.
- **Re-asserting the choice on every source.** This makes instances fight each other, and the loser is whoever sourced last rather than whoever clicked last.
- **A separate tmux socket per QA instance.** Out of scope, and it would not help two real installs.
