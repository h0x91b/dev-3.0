Short: Agent settings is now a preset library

Settings → Agents is a two-pane preset library instead of nested accordions: a filterable list grouped by model on the left (the same Model → Mode labels the launch picker shows), one preset editor on the right, with duplicate, favorite/unfavorite, make-default and a confirmation before delete. Every enum field — model, permission mode, reasoning effort, max budget — is now a searchable dropdown that also accepts a typed value the app has never heard of, so a brand-new model id or effort level needs no dev3 release.

An agent whose base command dev3 cannot recognize — a wrapper script, a shell alias, a command carrying flags — used to get no lifecycle hooks at all, so its task never moved across the board by itself and nothing on screen said why. The agent's own settings now carry a Lifecycle Hooks field (Auto, Claude Code, Codex, none) and warn when auto-detection comes up empty.
