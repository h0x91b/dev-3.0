Short: Start a task when another finishes

A To Do task can now wait for another task and start by itself when that task completes or its pull request merges: pick **Launch later… → After task** in the launch dialog, or run `dev3 task create|update --start-after seq:<N> [--until completed|merged]` (`--no-start-after` clears it). The card shows a "Starts after #N" chip with **Start now** and **Remove start condition**; any variant of the awaited task counts, a cancelled or deleted one starts nothing and the card says why, and a start armed from inside a task still asks for approval like any agent launch.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2196)
