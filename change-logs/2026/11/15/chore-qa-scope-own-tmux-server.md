A scoped QA instance (`DEV3_QA_SCOPE`) now runs its own tmux server, so its task sessions never join the real app's server and a pane opened during QA cannot reach the real board; stopping the dev server stops that server, and the printed reset command kills it before deleting the scope.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2297)
