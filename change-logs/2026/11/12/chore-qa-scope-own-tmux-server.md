A scoped QA instance (`DEV3_QA_SCOPE`) now runs its own tmux server, so its task sessions never join the real app's server and a pane opened during QA cannot reach the real board.
