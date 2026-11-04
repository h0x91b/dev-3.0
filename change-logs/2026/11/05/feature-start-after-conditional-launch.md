Short: Start a task when another finishes

A To Do task can now wait for another task and start by itself when that task completes or its pull request merges: `dev3 task create --start-after seq:<N> [--until completed|merged]`, or `dev3 task update --start-after` / `--no-start-after` on an existing task. The card shows a "Starts after #N" chip; a cancelled or deleted prerequisite starts nothing and flags the card, and a start armed from inside a task still asks for approval like any agent launch.
