Short: Choose how completion asks appear

Settings → Tasks & Board → "How completion offers ask" picks how a merged branch or an agent's request to complete asks you: Dialog (the default) waits for an answer, while "On the task" shows a one-line bar at the bottom-right of the agent's pane, next to its prompt, and blocks nothing. The bar finds that pane by its id, so it stays put after a pane swap, and offers Show agent while the pane is under another zoomed pane or in another tmux window. The bar checks the branch for unsaved work before Complete, for agent requests too, and a marker on the task's card and sidebar row shows which tasks are waiting. An agent's request for a To Do task still asks in the dialog, because that task has no pane to hold the bar. Dialog keeps the dialogs dev3 already had.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2257)
