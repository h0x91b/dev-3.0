On macOS, the desktop app started with `open` from inside a dev3 pane no longer inherits that pane's task and registers as its guest. Before, CLI discovery could pick a dev-server instance over it, so `dev3 task move` opened its approval dialog in the dev window and lost the request when that window closed.

Contributed by @fallenfuzz
