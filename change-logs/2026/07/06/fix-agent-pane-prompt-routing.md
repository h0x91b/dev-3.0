Fixed the Create-PR / auto-merge / rebase-conflict hand-off writing its prompt into whatever pane happened to be focused. When a task has exactly one live agent pane, the prompt now always goes there even if a shell or dev-server split is active; with two or more agent panes it still respects the active pane.

Suggested by @genrym (h0x91b/dev-3.0#609)
